import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_CLOUD_PORTS, E2E_MOCK_PORTS } from '../ports';

// Phase 14 demo script: add a cloud model with its key, fetch the provider's models and pick one,
// then race it on the Text tab next to a local machine, as a reference.
const [, LINUX] = DEMO_MACHINES;
const LINUX_MOCK = `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`;
const OPENAI = `http://127.0.0.1:${E2E_CLOUD_PORTS[0]}`;
const ANTHROPIC = `http://127.0.0.1:${E2E_CLOUD_PORTS[1]}`;
// The demo's fake providers accept these keys, and nothing else.
const OPENAI_KEY = 'sk-proj-demo-openai-0000000000000000000001';
const ANTHROPIC_KEY = 'sk-ant-api03-demo-anthropic-000000000000001';

test.describe.configure({ mode: 'serial' });

/** Machines this file added, removed again at the end: the machines spec starts from none. */
const added: string[] = [];

async function reset(request: APIRequestContext) {
  await request.post(`${LINUX_MOCK}/__mock/reset`);
  await request.post(`${LINUX_MOCK}/__mock/config`, {
    data: { stream: { startupMs: 150, tokenMs: 10, jitterMs: 0, answerTokens: 30 } },
  });
  for (const cloud of [OPENAI, ANTHROPIC]) {
    await request.post(`${cloud}/__mock/reset`);
    await request.post(`${cloud}/__mock/config`, { data: { startupMs: 200, tokenMs: 10 } });
  }
}

const pane = (page: Page, name: string) =>
  page.getByTestId('run-pane').and(page.locator(`[data-machine="${name}"]`));

const choose = (page: Page, group: string, option: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

async function setUpRace(page: Page, names: string[]) {
  await page.goto('/#/text');
  const boxes = page.getByRole('group', { name: 'Machines' }).getByRole('checkbox');
  await expect(boxes.first()).toBeEnabled();
  for (const box of await boxes.all()) {
    const label = (await box.locator('xpath=..').textContent()) ?? '';
    await box.setChecked(names.some((name) => label.includes(name)));
  }
  await choose(page, 'Warm-up', 'Off');
  await page.getByRole('textbox', { name: 'Rounds', exact: true }).fill('1');
  await page.getByLabel('Pause between rounds, seconds').fill('0');
}

test.beforeAll(async ({ request }) => {
  const existing = (await (await request.get('/api/machines')).json()) as Array<{ name: string }>;
  if (!existing.some((m) => m.name === LINUX.name)) {
    const created = await request.post('/api/machines', {
      data: { name: LINUX.name, baseUrl: LINUX_MOCK, apiKey: LINUX.apiKey },
    });
    added.push(((await created.json()) as { id: string }).id);
  }
  // A second cloud model, added the way the page does it.
  const listed = await request.post('/api/cloud/models', {
    data: { provider: 'openai', apiKey: OPENAI_KEY, baseUrl: OPENAI },
  });
  const { models } = (await listed.json()) as { models: Array<{ id: string }> };
  const created = await request.post('/api/machines', {
    data: {
      name: 'ChatGPT Luna',
      baseUrl: OPENAI,
      apiKey: OPENAI_KEY,
      cloud: { provider: 'openai', model: models.find((m) => m.id === 'gpt-6-luna') },
    },
  });
  added.push(((await created.json()) as { id: string }).id);
});
test.beforeEach(async ({ request }) => {
  await reset(request);
});
test.afterAll(async ({ request }) => {
  await reset(request);
  const machines = (await (await request.get('/api/machines')).json()) as Array<{
    id: string;
    cloud: unknown;
  }>;
  // The cloud model the dialog added, too.
  for (const m of machines) if (m.cloud && !added.includes(m.id)) added.push(m.id);
  for (const id of added) await request.delete(`/api/machines/${id}`);
});

test('adds a cloud model from the provider’s list, with the key checked on the way', async ({
  page,
}) => {
  await page.goto('/#/machines');
  await page.getByRole('button', { name: 'Add cloud model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add cloud model' });
  await dialog.getByLabel('Provider').selectOption('anthropic');
  await dialog.getByText('API address (optional)').click();
  await dialog.getByLabel('API address', { exact: true }).fill(ANTHROPIC);

  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByText('Enter the API key.')).toBeVisible();

  await dialog.getByLabel('API key').fill('sk-ant-wrong-key-00000000000000');
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Anthropic did not accept the API key');

  await dialog.getByLabel('API key').fill(ANTHROPIC_KEY);
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  const model = dialog.getByLabel('Model', { exact: true });
  await expect(model.locator('option')).toHaveCount(3);
  await model.selectOption('claude-sonnet-5');
  await expect(
    dialog.getByText(/128,000 tokens · thinks when asked · effort low to max/),
  ).toBeVisible();
  await expect(dialog.getByLabel('Name')).toHaveValue('Claude Sonnet 5');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  const card = page
    .getByTestId('cloud-card')
    .and(page.locator('[data-machine-name="Claude Sonnet 5"]'));
  await expect(card).toContainText('Anthropic · claude-sonnet-5');
  await expect(card).toContainText('1,000,000 tokens of context');
  await expect(card).not.toContainText(ANTHROPIC_KEY);
  await expect(card.getByRole('button', { name: 'Probe' })).toHaveCount(0);

  // The other tabs need Unsloth, so they leave cloud models out.
  await page.goto('/#/transcribe');
  await expect(page.getByRole('checkbox', { name: /Claude Sonnet 5/ })).toHaveCount(0);
});

test('races two cloud models next to a local machine and compares them', async ({
  page,
  request,
}) => {
  await setUpRace(page, [LINUX.name, 'Claude Sonnet 5', 'ChatGPT Luna']);
  await expect(page.getByRole('checkbox', { name: /Claude Sonnet 5/ })).toBeChecked();
  await expect(page.getByText('Anthropic · claude-sonnet-5')).toBeVisible();
  await expect(page.getByTestId('race-notes')).toContainText('raced as a reference');
  await page.getByRole('button', { name: 'Start' }).click();
  for (const name of [LINUX.name, 'Claude Sonnet 5', 'ChatGPT Luna']) {
    await expect(pane(page, name).getByTestId('run-state')).toHaveText('Done', { timeout: 20_000 });
  }
  await expect(pane(page, 'Claude Sonnet 5')).toContainText('claude-sonnet-5');
  await expect(pane(page, 'ChatGPT Luna').getByTestId('answer')).toContainText('the model answers');
  const decode = page.getByTestId('compare').locator('tr[data-key="decode"]');
  await expect(decode.locator('td[data-machine="ChatGPT Luna"]')).toHaveText(/\d/);
  await expect(page.getByTestId('setup')).toContainText('gpt-6-luna');

  // The result file names the provider and model, and carries no key.
  const id = new URL(page.url()).hash.split('/').at(-1) ?? '';
  const result = await request.get(`/api/sessions/${id}/result.json`);
  const text = await result.text();
  const machines = (JSON.parse(text) as { machines: Array<{ kind: string; cloud: unknown }> })
    .machines;
  expect(machines.map((m) => m.kind).sort()).toEqual(['cloud', 'cloud', 'local']);
  expect(machines.map((m) => m.cloud)).toContainEqual({
    provider: 'anthropic',
    model: 'claude-sonnet-5',
  });
  expect(text).not.toContain(ANTHROPIC_KEY);
  expect(text).not.toContain(OPENAI_KEY);
});

test('shows what the provider billed next to what streamed', async ({ page }) => {
  await setUpRace(page, ['ChatGPT Luna']);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(pane(page, 'ChatGPT Luna').getByTestId('run-state')).toHaveText('Done', {
    timeout: 20_000,
  });
  const table = page.getByTestId('run-metrics');
  await expect(table.getByRole('columnheader', { name: 'Reported by OpenAI' })).toBeVisible();
  const reported = table
    .getByRole('row', { name: /^Output tokens/ })
    .locator('td[data-column="reported"]');
  await expect(reported).toHaveText('60');
  await expect(table.getByTestId('cloud-note')).toContainText('Request id req_mock_openai');
  await expect(table.getByTestId('cloud-reasoning')).toContainText('summary of its thinking');
});
