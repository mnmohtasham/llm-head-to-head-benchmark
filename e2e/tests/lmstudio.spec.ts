import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_LMSTUDIO_PORT, E2E_MOCK_PORTS } from '../ports';

// LM Studio demo script: add an LM Studio machine, see its models on the Models tab and load
// another, then race it on the Text tab next to an Unsloth machine.
const [, LINUX] = DEMO_MACHINES;
const LINUX_MOCK = `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`;
const LM = `http://127.0.0.1:${E2E_LMSTUDIO_PORT}`;
const NAME = 'Studio box';

test.describe.configure({ mode: 'serial' });

/** Machines this file added, removed again at the end: the machines spec starts from none. */
const added: string[] = [];

async function reset(request: APIRequestContext) {
  await request.post(`${LM}/__mock/reset`);
  await request.post(`${LM}/__mock/config`, { data: { startupMs: 120, tokenMs: 8 } });
  await request.post(`${LINUX_MOCK}/__mock/reset`);
  await request.post(`${LINUX_MOCK}/__mock/config`, {
    data: {
      stream: { startupMs: 120, tokenMs: 8, jitterMs: 0, reasoningTokens: 0, answerTokens: 30 },
    },
  });
}

const pane = (page: Page, name: string) =>
  page.getByTestId('run-pane').and(page.locator(`[data-machine="${name}"]`));
const choose = (page: Page, group: string, option: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

test.beforeAll(async ({ request }) => {
  await reset(request);
  const existing = (await (await request.get('/api/machines')).json()) as Array<{ name: string }>;
  if (!existing.some((m) => m.name === LINUX.name)) {
    const created = await request.post('/api/machines', {
      data: { name: LINUX.name, baseUrl: LINUX_MOCK, apiKey: LINUX.apiKey },
    });
    added.push(((await created.json()) as { id: string }).id);
  }
});
test.afterAll(async ({ request }) => {
  await reset(request);
  const machines = (await (await request.get('/api/machines')).json()) as Array<{
    id: string;
    name: string;
  }>;
  for (const m of machines) if (m.name === NAME && !added.includes(m.id)) added.push(m.id);
  for (const id of added) await request.delete(`/api/machines/${id}`);
});

test('adds an LM Studio machine and probes it as LM Studio', async ({ page }) => {
  await page.goto('/#/machines');
  await page.getByRole('button', { name: 'Add machine' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add machine' });
  await dialog.getByRole('radio', { name: 'LM Studio' }).click();
  await dialog.getByLabel('Name', { exact: true }).fill(NAME);
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await expect(dialog.getByText('Will connect to')).toContainText('http://127.0.0.1:1234');
  await dialog.getByLabel('Address', { exact: true }).fill(`127.0.0.1:${E2E_LMSTUDIO_PORT}`);
  await expect(dialog.getByText('Agent, for the Command tab')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add and probe' }).click();
  await expect(dialog).toBeHidden();

  const card = page.getByTestId('machine-card').and(page.locator(`[data-machine-name="${NAME}"]`));
  await expect(card.getByTestId('server-label')).toHaveText('LM Studio');
  await expect(card.getByTestId('overall')).toHaveText('Ready');
  await expect(card.getByTestId('cap-text')).toHaveAttribute('data-status', 'ok');
  await expect(card.getByTestId('cap-stt')).toHaveAttribute('data-status', 'missing');
  await expect(card).toContainText('qwen/qwen3.8-27b Q4_K_M loaded · 3 downloaded');

  // The tabs that need Unsloth leave it out.
  await page.goto('/#/transcribe');
  await expect(page.getByRole('checkbox', { name: new RegExp(NAME) })).toHaveCount(0);
});

test('loads another model through LM Studio on the Models tab', async ({ page }) => {
  await page.goto('/#/models');
  const lm = page.getByTestId('lm-model-pane').and(page.locator(`[data-machine-name="${NAME}"]`));
  await expect(lm.getByTestId('lm-loaded')).toContainText('Qwen3.8 27B');
  await lm
    .getByTestId('lm-downloaded')
    .and(page.locator('[data-key="google/gemma-4-12b"]'))
    .getByRole('button', { name: 'Load' })
    .click();
  const form = lm.getByRole('form', { name: 'Load Gemma 4 12B' });
  await form.getByLabel('Context length').fill('16384');
  await expect(form.getByLabel(/Unload Qwen3\.8 27B first/)).toBeChecked();
  await form.getByRole('button', { name: 'Load' }).click();
  await expect(lm.getByTestId('lm-loaded')).toHaveCount(1);
  await expect(lm.getByTestId('lm-loaded')).toContainText('Gemma 4 12B');
  await expect(lm.getByTestId('lm-loaded')).toContainText('context 16,384');
  await expect(page.getByRole('region', { name: 'Activity' })).toContainText(
    'Loaded Gemma 4 12B in LM Studio',
  );
});

test('races LM Studio next to Unsloth, with LM Studio’s own timings', async ({ page, request }) => {
  await reset(request);
  await page.goto('/#/text');
  const boxes = page.getByRole('group', { name: 'Machines' }).getByRole('checkbox');
  await expect(boxes.first()).toBeEnabled();
  for (const box of await boxes.all()) {
    const label = (await box.locator('xpath=..').textContent()) ?? '';
    await box.setChecked(label.includes(NAME) || label.includes(LINUX.name));
  }
  await expect(page.getByText('LM Studio · qwen/qwen3.8-27b · Q4_K_M')).toBeVisible();
  await choose(page, 'Warm-up', 'Off');
  await page.getByRole('textbox', { name: 'Rounds', exact: true }).fill('1');
  await expect(page.getByTestId('race-warnings')).toContainText('compares the servers');
  await expect(page.getByTestId('race-notes')).toContainText('LM Studio cannot count tokens');
  await page.getByLabel(/Race anyway/).check();
  await page.getByRole('button', { name: 'Start' }).click();
  for (const name of [NAME, LINUX.name]) {
    await expect(pane(page, name).getByTestId('run-state')).toHaveText('Done', { timeout: 20_000 });
  }
  const compare = page.getByTestId('compare');
  await expect(
    compare.locator(`tr[data-key="decodeServer"] td[data-machine="${NAME}"]`),
  ).toHaveText(/ tok\/s/);
  await expect(page.getByTestId('setup')).toContainText('LM Studio GGUF');

  // One LM Studio run on its own shows what LM Studio reported beside what streamed.
  for (const box of await boxes.all()) {
    const label = (await box.locator('xpath=..').textContent()) ?? '';
    await box.setChecked(label.includes(NAME));
  }
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(pane(page, NAME).getByTestId('run-state')).toHaveText('Done', { timeout: 20_000 });
  const table = page.getByTestId('run-metrics');
  await expect(table.getByRole('columnheader', { name: 'Reported by LM Studio' })).toBeVisible();
  await expect(table.getByTestId('lmstudio-note')).toContainText('no stop reason');
});
