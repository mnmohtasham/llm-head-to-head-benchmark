import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 2 demo script: load one model everywhere, skip a machine without the quant, filter and
// load one machine, unload, see a failure and a memory warning, cancel a load.
const [MAC, LINUX] = DEMO_MACHINES;
const MAC_MOCK = `http://127.0.0.1:${E2E_MOCK_PORTS[0]}`;
const LINUX_MOCK = `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`;
const GEMMA = 'unsloth/gemma-4-12b-it-GGUF';

test.describe.configure({ mode: 'serial' });

function pane(page: Page, name: string) {
  return page
    .getByTestId('model-pane')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function ensureMachines(request: APIRequestContext) {
  const existing = (await (await request.get('/api/machines')).json()) as Array<{ name: string }>;
  for (const [index, machine] of DEMO_MACHINES.entries()) {
    if (existing.some((m) => m.name === machine.name)) continue;
    await request.post('/api/machines', {
      data: {
        name: machine.name,
        baseUrl: `127.0.0.1:${E2E_MOCK_PORTS[index]}`,
        apiKey: machine.apiKey,
      },
    });
  }
}

async function openLoadDialog(page: Page, from: 'all' | string) {
  if (from === 'all') await page.getByRole('button', { name: 'Load on all machines' }).click();
  else await pane(page, from).getByRole('button', { name: 'Load model' }).click();
  return page.getByRole('dialog', { name: 'Load model' });
}

test.beforeAll(async ({ request }) => {
  await ensureMachines(request);
});

test.beforeEach(async ({ request }) => {
  for (const mock of [MAC_MOCK, LINUX_MOCK]) {
    await request.post(`${mock}/__mock/reset`);
    await request.post(`${mock}/__mock/config`, { data: { loadMs: 1500 } });
  }
});

test('loads one model on both machines: both bars finish and both panes match', async ({
  page,
}) => {
  await page.goto('/#/models');
  for (const machine of [MAC, LINUX]) {
    await expect(pane(page, machine.name).getByTestId('model-state')).toHaveText('Ready');
  }
  const dialog = await openLoadDialog(page, 'all');
  await dialog.getByLabel('Model', { exact: true }).selectOption(GEMMA);
  await dialog.getByLabel('Quant', { exact: true }).selectOption('Q4_K_M');
  await dialog.getByLabel('Context length', { exact: true }).fill('8192');
  await expect(dialog.getByLabel('Speculative decoding', { exact: true })).toHaveValue('off');
  await dialog.getByRole('button', { name: 'Load on 2 machines' }).click();
  await expect(dialog).toBeHidden();

  for (const machine of [MAC, LINUX]) {
    await expect(pane(page, machine.name).getByRole('progressbar')).toBeVisible();
  }
  for (const machine of [MAC, LINUX]) {
    const machinePane = pane(page, machine.name);
    await expect(machinePane.getByTestId('model-state')).toHaveText('Ready', { timeout: 15_000 });
    await expect(machinePane.getByRole('progressbar')).toHaveCount(0);
    await expect(machinePane.locator('.machine-notes')).toHaveText(GEMMA);
    await expect(machinePane.locator('dd[data-field="quant"]')).toHaveText('Q4_K_M');
    await expect(machinePane.locator('dd[data-field="context"]')).toHaveText(/^8,192 tokens/);
    await expect(machinePane.locator('dd[data-field="speculative"]')).toHaveText('Off');
    await expect(machinePane.getByTestId('last-load')).toContainText(
      'Loaded gemma-4-12b-it-GGUF Q4_K_M in',
    );
    await expect(machinePane.getByTestId('load-time')).toHaveText(/^\d+(\.\d)? s$/);
  }
});

test('skips a machine that lacks the quant, and says so before and after', async ({ page }) => {
  await page.goto('/#/models');
  const dialog = await openLoadDialog(page, 'all');
  await dialog.getByLabel('Model', { exact: true }).selectOption(GEMMA);
  await dialog.getByLabel('Quant', { exact: true }).selectOption('Q8_0');
  await expect(dialog.getByTestId(`availability-${MAC.name}`)).toHaveText('Ready');
  await expect(dialog.getByTestId(`availability-${LINUX.name}`)).toHaveText(
    'Q8_0 is not fully downloaded on this machine. It will be skipped.',
  );
  await dialog.getByRole('button', { name: 'Load on 1 machine' }).click();

  await expect(page.getByRole('region', { name: 'Activity' })).toContainText(
    'Skipped. Q8_0 is not fully downloaded on this machine.',
  );
  await expect(pane(page, MAC.name).locator('dd[data-field="quant"]')).toHaveText('Q8_0', {
    timeout: 15_000,
  });
  await expect(pane(page, LINUX.name).locator('.machine-notes')).toHaveText(
    'unsloth/Qwen3.8-27B-GGUF',
  );
});

test('filters a machine’s model list and loads one model from it', async ({ page }) => {
  await page.goto('/#/models');
  const linuxPane = pane(page, LINUX.name);
  await linuxPane.getByText('Models on this machine').click();
  await linuxPane.getByLabel(`Filter models on ${LINUX.name}`).fill('8b');
  await expect(linuxPane.getByTestId('model-row')).toHaveCount(1);
  await linuxPane.getByRole('button', { name: 'Load unsloth/Qwen3.8-8B-GGUF' }).click();

  const dialog = page.getByRole('dialog', { name: 'Load model' });
  await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('unsloth/Qwen3.8-8B-GGUF');
  await expect(dialog.getByRole('checkbox', { name: new RegExp(LINUX.name) })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: new RegExp(MAC.name) })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Load on 1 machine' }).click();
  await expect(linuxPane.locator('.machine-notes')).toHaveText('unsloth/Qwen3.8-8B-GGUF', {
    timeout: 15_000,
  });
});

test('unload asks first, then the pane shows no model', async ({ page }) => {
  await page.goto('/#/models');
  const macPane = pane(page, MAC.name);
  await expect(macPane.getByTestId('model-state')).toHaveText('Ready');
  await macPane.getByRole('button', { name: 'Unload' }).click();
  const confirm = page.getByRole('dialog', { name: 'Unload model' });
  await confirm.getByRole('button', { name: 'Unload' }).click();
  await expect(macPane.getByTestId('model-state')).toHaveText('No model');
  await expect(macPane.getByRole('button', { name: 'Unload' })).toHaveCount(0);
});

test('shows Unsloth’s failure message and a memory warning', async ({ page, request }) => {
  await request.post(`${LINUX_MOCK}/__mock/config`, {
    data: { failNextLoad: 'Failed to load GGUF model: gemma-4-12b-it-GGUF' },
  });
  await request.post(`${MAC_MOCK}/__mock/config`, {
    data: { memoryWarning: 'The weights do not fit in memory, so llama.cpp pages them from disk.' },
  });
  await page.goto('/#/models');
  const dialog = await openLoadDialog(page, 'all');
  await dialog.getByLabel('Model', { exact: true }).selectOption(GEMMA);
  await dialog.getByLabel('Quant', { exact: true }).selectOption('Q4_K_M');
  await dialog.getByRole('button', { name: 'Load on 2 machines' }).click();

  await expect(pane(page, LINUX.name).getByTestId('last-load')).toContainText(
    'Failed to load GGUF model: gemma-4-12b-it-GGUF',
    { timeout: 15_000 },
  );
  await expect(pane(page, MAC.name).getByTestId('memory-warning')).toContainText(
    'do not fit in memory',
    {
      timeout: 15_000,
    },
  );
});

test('cancels a running load', async ({ page, request }) => {
  await request.post(`${LINUX_MOCK}/__mock/config`, { data: { loadMs: 20_000 } });
  await page.goto('/#/models');
  const dialog = await openLoadDialog(page, LINUX.name);
  await dialog.getByLabel('Model', { exact: true }).selectOption(GEMMA);
  await dialog.getByRole('button', { name: 'Load on 1 machine' }).click();
  const linuxPane = pane(page, LINUX.name);
  await expect(linuxPane.getByRole('progressbar')).toBeVisible();
  await linuxPane.getByRole('button', { name: 'Cancel load' }).click();
  await expect(linuxPane.getByTestId('last-load')).toContainText('cancelled after', {
    timeout: 10_000,
  });
});
