import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 15 demo script: after a race, find each machine's run in the Results tab, filter and sort
// the table, pick columns, and download what it shows.
const [MAC, LINUX] = DEMO_MACHINES;
const MOCKS = [`http://127.0.0.1:${E2E_MOCK_PORTS[0]}`, `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`];
const MARKER = 'results-spec: why do GPUs have more memory bandwidth than CPUs?';

test.describe.configure({ mode: 'serial' });

/** Machines this file added, removed again at the end. */
const added: string[] = [];
let sessionId = '';

async function reset(request: APIRequestContext) {
  for (const mock of MOCKS) {
    await request.post(`${mock}/__mock/reset`);
    await request.post(`${mock}/__mock/config`, {
      data: {
        stream: { startupMs: 100, tokenMs: 8, jitterMs: 0, reasoningTokens: 0, answerTokens: 30 },
      },
    });
  }
}

const rows = (page: Page) => page.getByTestId('results-row');
const row = (page: Page, name: string) => rows(page).and(page.locator(`[data-machine="${name}"]`));
const cell = (page: Page, name: string, column: string) =>
  row(page, name).locator(`td[data-column="${column}"]`);

test.beforeAll(async ({ request }) => {
  await reset(request);
  const existing = (await (await request.get('/api/machines')).json()) as Array<{
    id: string;
    name: string;
  }>;
  const ids: string[] = [];
  for (const [index, machine] of DEMO_MACHINES.entries()) {
    let id = existing.find((m) => m.name === machine.name)?.id;
    if (!id) {
      const created = await request.post('/api/machines', {
        data: {
          name: machine.name,
          baseUrl: `127.0.0.1:${E2E_MOCK_PORTS[index]}`,
          apiKey: machine.apiKey,
        },
      });
      id = ((await created.json()) as { id: string }).id;
      added.push(id);
    }
    // The probe is where a race's hardware snapshot comes from.
    await request.post(`/api/machines/${id}/probe`, { data: {} });
    ids.push(id);
  }
  const started = await request.post('/api/sessions', {
    data: {
      workload: 'text',
      machineIds: ids,
      config: { prompt: MARKER, maxTokens: 512, thinking: false, reasoningEffort: null },
      plan: { rounds: 2, warmup: false, settleMs: 0, sequencing: 'concurrent' },
      acknowledgeWarnings: true,
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  sessionId = ((await started.json()) as { id: string }).id;
  await expect
    .poll(
      async () =>
        (
          (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
            finishedAt: unknown;
          }
        ).finishedAt,
      { timeout: 20_000 },
    )
    .not.toBeNull();
});
test.afterAll(async ({ request }) => {
  await reset(request);
  for (const id of added) await request.delete(`/api/machines/${id}`);
});

test('shows each machine’s run with its GPU, model settings and medians', async ({ page }) => {
  await page.goto('/#/results');
  await expect(page.getByRole('radio', { name: /^Text/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Search').fill('results-spec');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId('results-count')).toHaveText(/^2 (of \d+ )?runs$/);

  await expect(cell(page, LINUX.name, 'gpu')).toHaveText('NVIDIA GeForce RTX 5090');
  await expect(cell(page, LINUX.name, 'platform')).toHaveText('CUDA');
  await expect(cell(page, MAC.name, 'platform')).toHaveText('MLX');
  await expect(cell(page, LINUX.name, 'model')).toHaveText('unsloth/Qwen3.8-27B-GGUF');
  await expect(cell(page, LINUX.name, 'quant')).toHaveText('Q4_K_M');
  await expect(cell(page, LINUX.name, 'kvCache')).toHaveText('f16');
  await expect(cell(page, LINUX.name, 'slots')).toHaveText(/^\d+$/);
  await expect(cell(page, LINUX.name, 'rounds')).toHaveText('2');
  await expect(cell(page, LINUX.name, 'thinking')).toHaveText('off');
  await expect(cell(page, LINUX.name, 'metric:decode')).toHaveText(/ tok\/s/);
  // Two machines with speeds: one of them has the best decode speed of the rows shown.
  await expect(page.locator('td[data-column="metric:decode"].best')).toHaveCount(1);

  // The date opens the race.
  await row(page, LINUX.name).locator('td[data-column="date"] a').click();
  await expect(page).toHaveURL(new RegExp(`#/text/${sessionId}$`));
  await expect(page.getByTestId('compare')).toBeVisible();
});

test('filters, sorts and picks columns', async ({ page }) => {
  await page.goto('/#/results');
  await page.getByLabel('Search').fill('results-spec');
  await page.getByLabel('Machine', { exact: true }).selectOption(LINUX.name);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toHaveAttribute('data-machine', LINUX.name);
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(page.getByLabel('Search')).toHaveValue('');

  await page.getByLabel('Search').fill('results-spec');
  const decode = page.getByRole('columnheader', { name: /Decode speed higher/ });
  await decode.getByRole('button').click();
  await expect(decode).toHaveAttribute('aria-sort', 'descending');
  const speeds = await page.locator('td[data-column="metric:decode"]').allTextContents();
  const numbers = speeds.map((s) => Number.parseFloat(s));
  expect(numbers).toEqual([...numbers].sort((a, b) => b - a));

  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'RAM', exact: true }).check();
  await expect(page.getByRole('columnheader', { name: 'RAM' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'GPU', exact: true }).uncheck();
  await expect(page.getByRole('columnheader', { name: 'GPU', exact: true })).toHaveCount(0);
  // The choice stays after a reload, in this browser.
  await page.reload();
  await expect(page.getByRole('columnheader', { name: 'RAM' })).toBeVisible();
  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('button', { name: 'Reset columns' }).click();
  await expect(page.getByRole('columnheader', { name: 'RAM' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'GPU', exact: true })).toBeVisible();
});

test('downloads the rows shown as CSV, and fits a phone screen', async ({ page }) => {
  await page.goto('/#/results');
  await page.getByLabel('Search').fill('results-spec');
  await expect(rows(page)).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const file = await (await download).path();
  const csv = await readFile(file, 'utf8');
  const lines = csv.trim().split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^Machine,Date,Rounds,GPU,GPU memory \(GB\)/);
  expect(csv).toContain(LINUX.name);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows(page)).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
