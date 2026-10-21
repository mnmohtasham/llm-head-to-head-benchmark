import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { TEST_MACHINES } from '../stand-ins';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 22 scenario: tick runs in the Results tab and compare them side by side, open a
// comparison from its link, and follow one machine over its races, where an update of llama.cpp
// halved its decode speed.
const [MAC, LINUX] = TEST_MACHINES;
const MOCKS = [`http://127.0.0.1:${E2E_MOCK_PORTS[0]}`, `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`];
const LINUX_MOCK = MOCKS[1]!;
// Custom prompts only: the results spec counts the runs of the standard Short prompt.
const MARKER = 'compare-spec: what limits the decode speed of a GPU?';

test.describe.configure({ mode: 'serial' });

/** Machines this file added, removed again at the end. */
const added: string[] = [];
const machineIds = new Map<string, string>();
/** Before the update, after it, and after it with a lower Max tokens. */
const races: string[] = [];

async function stream(request: APIRequestContext, mock: string, tokenMs: number) {
  await request.post(`${mock}/__mock/config`, {
    data: {
      stream: { startupMs: 100, tokenMs, jitterMs: 0, reasoningTokens: 0, answerTokens: 30 },
    },
  });
}

async function race(request: APIRequestContext, maxTokens: number): Promise<string> {
  const started = await request.post('/api/sessions', {
    data: {
      workload: 'text',
      machineIds: TEST_MACHINES.map((m) => machineIds.get(m.name)),
      config: { prompt: MARKER, maxTokens, thinking: false, reasoningEffort: null },
      plan: { rounds: 2, warmup: false, settleMs: 0, sequencing: 'concurrent' },
      acknowledgeWarnings: true,
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const id = ((await started.json()) as { id: string }).id;
  await expect
    .poll(
      async () =>
        ((await (await request.get(`/api/sessions/${id}`)).json()) as { finishedAt: unknown })
          .finishedAt,
      { timeout: 20_000 },
    )
    .not.toBeNull();
  return id;
}

const key = (session: string, name: string) => `${session}/${machineIds.get(name)}`;
const rows = (page: Page) => page.getByTestId('results-row');
const row = (page: Page, session: string, name: string) =>
  rows(page).and(page.locator(`[data-session="${session}"][data-machine="${name}"]`));

test.beforeAll(async ({ request }) => {
  for (const mock of MOCKS) {
    await request.post(`${mock}/__mock/reset`);
    await stream(request, mock, 8);
  }
  const existing = (await (await request.get('/api/machines')).json()) as Array<{
    id: string;
    name: string;
  }>;
  for (const [index, machine] of TEST_MACHINES.entries()) {
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
    await request.post(`/api/machines/${id}/probe`, { data: {} });
    machineIds.set(machine.name, id);
  }
  races.push(await race(request, 512));

  // An update on the Linux machine: llama.cpp b9601 to b9650, after which it decodes at half the
  // speed. The probe before a race is where the version comes from.
  const hardware = (await (
    await request.get(`${LINUX_MOCK}/api/system/hardware?include_details=true`, {
      headers: { authorization: `Bearer ${LINUX.apiKey}` },
    })
  ).json()) as Record<string, unknown>;
  expect(hardware.llama_cpp).toBe('b9601');
  await request.post(`${LINUX_MOCK}/__mock/config`, {
    data: {
      routes: {
        '/api/system/hardware': { status: 200, body: { ...hardware, llama_cpp: 'b9650' } },
      },
    },
  });
  await request.post(`/api/machines/${machineIds.get(LINUX.name)}/probe`, { data: {} });
  await stream(request, LINUX_MOCK, 16);
  races.push(await race(request, 512));
  races.push(await race(request, 256));
});
test.afterAll(async ({ request }) => {
  for (const mock of MOCKS) await request.post(`${mock}/__mock/reset`);
  for (const id of machineIds.values()) {
    // A machine that was here before goes back to the stand-in's own version.
    if (added.includes(id)) await request.delete(`/api/machines/${id}`);
    else await request.post(`/api/machines/${id}/probe`, { data: {} });
  }
});

test('ticks runs and compares them side by side, against the first', async ({ page }) => {
  await page.goto('/#/results');
  await page.getByLabel('Search').fill('compare-spec');
  await expect(rows(page)).toHaveCount(6);
  await expect(page.getByTestId('selection-bar')).toHaveCount(0);

  await row(page, races[0]!, LINUX.name)
    .getByRole('checkbox', { name: new RegExp(`^Select the run of ${LINUX.name} from `) })
    .check();
  const bar = page.getByTestId('selection-bar');
  await expect(bar).toContainText('1 run selected');
  await expect(bar.getByRole('button', { name: 'Compare' })).toBeDisabled();
  await expect(bar).toContainText('Tick at least one more run to compare.');
  // The keyboard ticks a run too.
  const after = row(page, races[1]!, LINUX.name).getByTestId('row-select');
  await after.focus();
  await page.keyboard.press('Space');
  await expect(after).toBeChecked();
  await expect(bar).toContainText('2 runs selected');
  await bar.getByRole('button', { name: 'Compare' }).click();

  const before = key(races[0]!, LINUX.name);
  const updated = key(races[1]!, LINUX.name);
  await expect(page).toHaveURL(new RegExp(`#/results\\?compare=${before},${updated}$`));
  const comparison = page.getByTestId('run-comparison');
  await expect(comparison.getByRole('heading', { name: 'Comparing 2 runs' })).toBeFocused();
  await expect(comparison.getByTestId('like-for-like')).toBeVisible();
  // The update is the one setting that differs, and it is marked in words, not only in colour.
  await expect(comparison.locator('tr.differs')).toHaveCount(1);
  const llama = comparison.locator('tr[data-key="llamaCpp"]');
  await expect(llama.getByRole('rowheader')).toHaveText(/differs/);
  await expect(llama.locator('td').nth(0)).toHaveText('b9601');
  await expect(llama.locator('td').nth(1)).toHaveText(/^b9650 ≠/);
  // Half the speed: the first run is the best, and the second about two times slower.
  const decode = comparison.locator('tr[data-key="decode"]');
  await expect(decode.locator('td').nth(0)).toHaveAttribute('data-best', 'true');
  await expect(decode.locator('td').nth(0)).toContainText('★');
  await expect(decode.getByTestId('versus')).toHaveText(/^\d\.\d\d× slower$/);
  // Total time has no better direction, so no ratio.
  await expect(comparison.locator('tr[data-key="total"]').getByTestId('versus')).toHaveCount(0);

  // It follows the median or average switch.
  await expect(comparison.locator('.run-compare-group th').nth(1)).toHaveText(
    'Medians of each run’s counted rounds',
  );
  await page
    .getByRole('radiogroup', { name: 'Rounds summed up by' })
    .getByRole('radio', { name: 'Average' })
    .click();
  await expect(comparison.locator('.run-compare-group th').nth(1)).toHaveText(
    'Averages of each run’s counted rounds',
  );
  await page
    .getByRole('radiogroup', { name: 'Rounds summed up by' })
    .getByRole('radio', { name: 'Median' })
    .click();

  // Against the later run instead, the first is the faster one.
  await comparison.getByRole('button', { name: /^Compare against / }).click();
  await expect(page).toHaveURL(new RegExp(`compare=${updated},${before}$`));
  await expect(decode.getByTestId('versus')).toHaveText(/^\d\.\d\d× faster$/);

  await bar.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByTestId('selection-bar')).toHaveCount(0);
  await expect(rows(page).getByTestId('row-select').and(page.locator(':checked'))).toHaveCount(0);
  // The comparison stays until it is closed.
  await comparison.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(/#\/results$/);
  await expect(page.getByTestId('run-comparison')).toHaveCount(0);
});

test('says when runs did not answer the same request', async ({ page }) => {
  await page.goto('/#/results');
  await page.getByLabel('Search').fill('compare-spec');
  await row(page, races[0]!, LINUX.name).getByTestId('row-select').check();
  await row(page, races[2]!, LINUX.name).getByTestId('row-select').check();
  await row(page, races[2]!, MAC.name).getByTestId('row-select').check();
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Compare' }).click();
  const comparison = page.getByTestId('run-comparison');
  await expect(comparison.getByTestId('not-like-for-like')).toHaveText(
    /^Not like for like: .* since their Max tokens differs\./,
  );
  await expect(comparison.locator('tr[data-key="maxTokens"] td[data-differs]')).toHaveCount(2);
  await expect(comparison.locator('tr[data-key="machine"] td[data-differs]')).toHaveCount(1);
});

test('opens a comparison from its link, and says which runs are gone', async ({ page }) => {
  const linux = key(races[0]!, LINUX.name);
  const mac = key(races[0]!, MAC.name);
  const gone = '00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000';
  await page.goto(`/#/results?compare=${linux},${mac},${gone}`);
  const comparison = page.getByTestId('run-comparison');
  await expect(comparison.getByTestId('compare-missing')).toHaveText(
    'One run in this link no longer exists, so it is left out.',
  );
  await expect(comparison.locator('thead th.run-compare-head')).toHaveCount(2);
  await expect(comparison.locator('thead th.run-compare-head').first()).toContainText(LINUX.name);
  // The runs it opened are ticked, ready for more.
  await expect(page.getByTestId('selection-bar')).toContainText('2 runs selected');

  await comparison.getByRole('button', { name: 'Copy link' }).click();
  // Copied where the browser allows the clipboard, shown to copy by hand where it does not.
  const typed = comparison.getByLabel('Link to this comparison, to copy');
  await expect(comparison.getByRole('button', { name: 'Link copied ✓' }).or(typed)).toBeVisible();
  if (await typed.isVisible())
    await expect(typed).toHaveValue(new RegExp(`compare=${linux},${mac}$`));

  // With one run left there is nothing to compare, and the page says why.
  await page.goto(`/#/results?compare=${linux},${gone}`);
  await expect(page.getByTestId('compare-problem')).toHaveText(
    'Tick at least one more run to compare.',
  );
});

test('follows a machine over its races, and marks the update', async ({ page }) => {
  await page.goto('/#/results');
  await page.getByLabel('Search').fill('compare-spec');
  await row(page, races[2]!, LINUX.name)
    .getByRole('button', { name: new RegExp(`^History of ${LINUX.name} with `) })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/results\\?history=${key(races[2]!, LINUX.name)}$`));
  const history = page.getByTestId('run-history');
  await expect(history.getByRole('heading', { level: 2 })).toHaveText(`History · ${LINUX.name}`);
  await expect(history.getByRole('heading', { level: 2 })).toBeFocused();
  // The same prompt and thinking by default: this file's three races.
  await expect(history.getByRole('checkbox', { name: /^Same prompt/ })).toBeChecked();
  await expect(history.getByTestId('history-row')).toHaveCount(3);
  await expect(history.getByTestId('history-chart-decode')).toBeVisible();
  await expect(history.getByTestId('history-chart-ttft')).toBeVisible();
  await expect(history.getByTestId('history-decode').getByTestId('history-summary')).toHaveText(
    /^Latest .* tok\/s on \d{4}-\d\d-\d\d is \d+% slower than the best, .* Both are the servers’ own numbers\.$/,
  );

  const changes = history.getByTestId('history-change');
  await expect(changes).toHaveCount(2);
  await expect(changes.nth(0)).toContainText(/llama\.cpp b9601 → b9650 on \d{4}-\d\d-\d\d/);
  await expect(changes.nth(0)).toContainText(/Decode speed .* tok\/s → .* tok\/s, \d+% slower/);
  await expect(changes.nth(1)).toContainText(/Max tokens 512 → 256 on \d{4}-\d\d-\d\d/);

  // Any prompt takes in at least as many runs.
  await history.getByRole('checkbox', { name: /^Same prompt/ }).uncheck();
  expect(await history.getByTestId('history-row').count()).toBeGreaterThanOrEqual(3);
  await history.getByRole('checkbox', { name: /^Same prompt/ }).check();

  // Every run links to its race; the oldest is last.
  await history.getByTestId('history-row').last().getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`#/text/${races[0]}$`));
  await expect(page.getByTestId('compare')).toBeVisible();
});

test('opens a history from a comparison, and fits a phone screen', async ({ page }) => {
  const before = key(races[0]!, LINUX.name);
  const updated = key(races[1]!, LINUX.name);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/results?compare=${before},${updated}`);
  const comparison = page.getByTestId('run-comparison');
  await comparison
    .getByRole('button', { name: /^History of / })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`compare=${before},${updated}&history=${before}$`));
  await expect(comparison).toBeVisible();
  const history = page.getByTestId('run-history');
  await expect(history.getByTestId('history-chart-decode')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await history.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(new RegExp(`compare=${before},${updated}$`));
  await expect(page.getByTestId('run-history')).toHaveCount(0);
});
