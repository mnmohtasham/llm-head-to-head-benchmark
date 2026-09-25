import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 10 demo script: race two machines on one prompt and seed, watch the steps, see both
// images side by side, and get the chat models back afterwards.
const [MAC, LINUX] = DEMO_MACHINES;
const MOCKS = [`http://127.0.0.1:${E2E_MOCK_PORTS[0]}`, `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`];

test.describe.configure({ mode: 'serial' });

/** Machines this file added, removed again at the end: the machines spec starts from none. */
const added: string[] = [];

async function ensureMachines(request: APIRequestContext) {
  const existing = (await (await request.get('/api/machines')).json()) as Array<{ name: string }>;
  for (const [index, machine] of DEMO_MACHINES.entries()) {
    if (existing.some((m) => m.name === machine.name)) continue;
    const created = await request.post('/api/machines', {
      data: {
        name: machine.name,
        baseUrl: `127.0.0.1:${E2E_MOCK_PORTS[index]}`,
        apiKey: machine.apiKey,
      },
    });
    added.push(((await created.json()) as { id: string }).id);
  }
}

async function resetMocks(request: APIRequestContext) {
  for (const mock of MOCKS) {
    await request.post(`${mock}/__mock/reset`);
    await request.post(`${mock}/__mock/config`, {
      data: { loadMs: 200, image: { loadMs: 200 } },
    });
  }
}

const pane = (page: Page, name: string) =>
  page.getByTestId('run-pane').and(page.locator(`[data-machine="${name}"]`));

const choose = (page: Page, group: string, option: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

async function setUp(page: Page) {
  await page.goto('/#/image');
  for (const machine of DEMO_MACHINES) {
    const box = page.getByRole('checkbox', { name: new RegExp(machine.name) });
    await expect(box).toBeEnabled();
    await box.setChecked(true);
  }
  await choose(page, 'Warm-up', 'Off');
  await page.getByRole('textbox', { name: 'Rounds', exact: true }).fill('1');
  await page.getByLabel('Pause between rounds, seconds').fill('0');
  await page.getByRole('button', { name: '512²' }).click();
  await page.getByRole('textbox', { name: 'Steps', exact: true }).fill('4');
}

test.beforeAll(async ({ request }) => {
  await ensureMachines(request);
  // The probe tells pre-flight which machine is Apple Silicon and which is CUDA.
  const machines = (await (await request.get('/api/machines')).json()) as Array<{ id: string }>;
  for (const machine of machines) await request.post(`/api/machines/${machine.id}/probe`);
});
test.beforeEach(async ({ request }) => {
  await resetMocks(request);
});
test.afterAll(async ({ request }) => {
  await resetMocks(request);
  for (const id of added) await request.delete(`/api/machines/${id}`);
});

test('races one prompt and seed, shows the steps and both images, then restores chat', async ({
  page,
  request,
}) => {
  await setUp(page);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'unsloth/FLUX.2-klein-9B-GGUF',
  );
  await expect(page.getByTestId('race-notes')).toContainText(
    `Loading the image model unloads unsloth/Qwen3.8-27B-GGUF on ${LINUX.name}. Model Duel loads it again when the race ends.`,
  );
  await expect(page.getByTestId('race-warnings')).toContainText('Apple Silicon and CUDA');
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  await page.getByLabel('Race anyway').check();
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(pane(page, MAC.name).getByTestId('step-progress')).toBeVisible({ timeout: 15_000 });
  for (const name of [MAC.name, LINUX.name]) {
    await expect(pane(page, name).getByTestId('run-state')).toHaveText('Done', { timeout: 20_000 });
  }
  // The chat models come back before the race counts as over.
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 20_000 });
  for (const name of [MAC.name, LINUX.name]) {
    const image = pane(page, name).getByTestId('image');
    await expect(image).toBeVisible();
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
  }
  const speed = async (name: string) =>
    Number(await pane(page, name).getByTestId('steps-per-sec').textContent());
  expect(await speed(LINUX.name)).toBeGreaterThan(await speed(MAC.name));
  await expect(pane(page, LINUX.name)).toContainText('diffusers · cuda · bfloat16 · speed off');
  await expect(page.getByTestId('step-chart')).toBeVisible();
  await expect(
    page.getByTestId('compare').getByRole('row', { name: /Denoising speed/ }),
  ).toContainText(LINUX.name);
  const setup = page.getByRole('row', { name: /Chat model afterwards/ });
  await expect(setup).toContainText('unsloth/Qwen3.8-27B-GGUF loaded again');
  const row = page.getByTestId('session-row').first();
  await expect(row).toContainText('Image "A red and white lighthouse');
  await expect(row).toContainText('steps/s');

  const status = await request.get(`${MOCKS[1]}/api/inference/status`, {
    headers: { authorization: `Bearer ${LINUX.apiKey}` },
  });
  expect(((await status.json()) as { active_model: string | null }).active_model).toBe(
    'unsloth/Qwen3.8-27B-GGUF',
  );
});

test('marks a model one machine lacks, and warns that its disk could not be checked', async ({
  page,
}) => {
  await setUp(page);
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model.locator('option', { hasText: 'Qwen-Image-2.1-GGUF (on 1 of 2)' })).toHaveCount(
    1,
  );
  await model.selectOption('unsloth/Qwen-Image-2.1-GGUF');
  await expect(page.getByTestId('race-warnings')).toContainText(
    `could not check that unsloth/Qwen-Image-2.1-GGUF is on ${MAC.name}'s disk`,
  );
});

test('fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/image');
  await expect(page.getByRole('radiogroup', { name: 'Speed mode' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
