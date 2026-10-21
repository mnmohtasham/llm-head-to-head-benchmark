import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_COMPAT_PORT, E2E_OLLAMA_PORT } from '../ports';

// Ollama and OpenAI-compatible scenario: add one machine of each, see their models on the Models
// tab, race them on the Text tab, and find them in Results with their servers' own numbers.
const OLLAMA = `http://127.0.0.1:${E2E_OLLAMA_PORT}`;
const COMPAT = `http://127.0.0.1:${E2E_COMPAT_PORT}`;
const OLLAMA_NAME = 'Ollama box';
const COMPAT_NAME = 'llama-server box';

test.describe.configure({ mode: 'serial' });

async function reset(request: APIRequestContext) {
  for (const mock of [OLLAMA, COMPAT]) {
    await request.post(`${mock}/__mock/reset`);
    await request.post(`${mock}/__mock/config`, { data: { startupMs: 100, tokenMs: 8 } });
  }
}

const card = (page: Page, name: string) =>
  page.getByTestId('machine-card').and(page.locator(`[data-machine-name="${name}"]`));
const pane = (page: Page, name: string) =>
  page.getByTestId('run-pane').and(page.locator(`[data-machine="${name}"]`));
const choose = (page: Page, group: string, option: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

test.beforeAll(async ({ request }) => {
  await reset(request);
});
test.afterAll(async ({ request }) => {
  await reset(request);
  const machines = (await (await request.get('/api/machines')).json()) as Array<{
    id: string;
    name: string;
  }>;
  for (const m of machines) {
    if (m.name === OLLAMA_NAME || m.name === COMPAT_NAME)
      await request.delete(`/api/machines/${m.id}`);
  }
});

async function add(page: Page, server: string, name: string, port: number, defaultPort: string) {
  await page.goto('/#/machines');
  await page.getByRole('button', { name: 'Add machine' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add machine' });
  await dialog.getByRole('radio', { name: server }).click();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await expect(dialog.getByText('Will connect to')).toContainText(
    `http://127.0.0.1:${defaultPort}`,
  );
  await dialog.getByLabel('Address', { exact: true }).fill(`127.0.0.1:${port}`);
  await dialog.getByRole('button', { name: 'Add and probe' }).click();
  await expect(dialog).toBeHidden();
}

test('adds an Ollama machine and an OpenAI-compatible one, and probes each as itself', async ({
  page,
}) => {
  await add(page, 'Ollama', OLLAMA_NAME, E2E_OLLAMA_PORT, '11434');
  const ollama = card(page, OLLAMA_NAME);
  await expect(ollama.getByTestId('server-label')).toHaveText('Ollama');
  await expect(ollama.getByTestId('overall')).toHaveText('Ready');
  await expect(ollama).toContainText('qwen3:8b Q4_K_M loaded · 2 downloaded');
  await expect(ollama.getByTestId('cap-stt')).toHaveAttribute('data-status', 'missing');

  await add(page, 'OpenAI-compatible server', COMPAT_NAME, E2E_COMPAT_PORT, '8080');
  const compat = card(page, COMPAT_NAME);
  await expect(compat.getByTestId('server-label')).toHaveText('OpenAI-compatible server');
  await expect(compat).toContainText('qwen3-8b-q4_k_m.gguf on llama.cpp');

  // The tabs that need Unsloth leave them out.
  await page.goto('/#/image');
  await expect(page.getByRole('checkbox', { name: new RegExp(OLLAMA_NAME) })).toHaveCount(0);
});

test('shows both on the Models tab, and loads a model through Ollama', async ({ page }) => {
  await page.goto('/#/models');
  const ollama = page
    .getByTestId('engine-model-pane')
    .and(page.locator(`[data-machine-name="${OLLAMA_NAME}"]`));
  await expect(ollama.getByTestId('model-state')).toHaveText('Ready');
  await expect(ollama.locator('dd[data-field="quant"]')).toHaveText('Q4_K_M');
  await expect(ollama.locator('dd[data-field="gpu"]')).toContainText('100%');
  const list = ollama.locator('details.model-list');
  await list.locator('summary').click();
  await expect(list.getByTestId('model-row')).toHaveCount(2);
  await list.getByRole('button', { name: 'Load gemma3:4b' }).click();
  await expect(ollama.getByRole('heading', { name: OLLAMA_NAME })).toBeVisible();
  await expect(ollama.getByTestId('model-state')).toHaveText('Ready', { timeout: 10_000 });
  await expect(ollama).toContainText('Ollama · gemma3:4b');
  await expect(page.getByRole('region', { name: 'Activity' })).toContainText(
    'Loaded gemma3:4b in Ollama',
  );
  // Back to the model the race expects.
  await list.getByRole('button', { name: 'Load qwen3:8b' }).click();
  await expect(ollama).toContainText('Ollama · qwen3:8b', { timeout: 10_000 });

  const compat = page
    .getByTestId('engine-model-pane')
    .and(page.locator(`[data-machine-name="${COMPAT_NAME}"]`));
  await expect(compat.getByTestId('model-state')).toHaveText('Ready');
  await expect(compat.locator('dd[data-field="server"]')).toHaveText('llama.cpp b6800-0123abcd');
  await expect(compat.locator('dd[data-field="slots"]')).toHaveText('4');
});

test('races both with their servers’ own timings, and lists them in Results', async ({
  page,
  request,
}) => {
  await reset(request);
  await page.goto('/#/text');
  const boxes = page.getByRole('group', { name: 'Machines' }).getByRole('checkbox');
  await expect(boxes.first()).toBeEnabled();
  for (const box of await boxes.all()) {
    const label = (await box.locator('xpath=..').textContent()) ?? '';
    await box.setChecked(label.includes(OLLAMA_NAME) || label.includes(COMPAT_NAME));
  }
  await expect(page.getByText('Ollama · qwen3:8b · Q4_K_M')).toBeVisible();
  await choose(page, 'Prompt', 'Code');
  await choose(page, 'Warm-up', 'Off');
  await page.getByRole('textbox', { name: 'Rounds', exact: true }).fill('1');
  await expect(page.getByTestId('race-warnings')).toContainText('compares the servers');
  await page.getByLabel(/Race anyway/).check();
  await page.getByRole('button', { name: 'Start' }).click();
  for (const name of [OLLAMA_NAME, COMPAT_NAME]) {
    await expect(pane(page, name).getByTestId('run-state')).toHaveText('Done', { timeout: 20_000 });
  }
  const compare = page.getByTestId('compare');
  for (const name of [OLLAMA_NAME, COMPAT_NAME]) {
    await expect(
      compare.locator(`tr[data-key="decodeServer"] td[data-machine="${name}"]`),
    ).toHaveText(/ tok\/s/);
  }
  await expect(page.getByTestId('setup')).toContainText('Ollama GGUF');
  await expect(page.getByTestId('setup')).toContainText('llama.cpp GGUF');

  await page.goto('/#/results');
  await page.getByLabel('Search').fill('merge_intervals');
  const row = page
    .getByTestId('results-row')
    .and(page.locator(`[data-machine="${OLLAMA_NAME}"]`))
    .first();
  await expect(row).toContainText('Ollama');
});
