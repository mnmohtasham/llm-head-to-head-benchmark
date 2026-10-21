import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { TEST_MACHINES } from '../stand-ins';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 22 scenario: queue a suite of races from the Suites tab, watch it run, read its summary
// and download it; a race pre-flight refuses is skipped, Cancel stops the rest, and a suite can be
// opened again and deleted while its races stay.
const [MAC, LINUX] = TEST_MACHINES;
const MOCKS = [`http://127.0.0.1:${E2E_MOCK_PORTS[0]}`, `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`];
const FAST = { startupMs: 100, tokenMs: 5, jitterMs: 0, reasoningTokens: 6, answerTokens: 20 };
const SLOW = { startupMs: 100, tokenMs: 40, jitterMs: 0, reasoningTokens: 0, answerTokens: 400 };

test.describe.configure({ mode: 'serial' });

/** Machines this file added, removed again at the end. */
const added: string[] = [];

async function streamAll(request: APIRequestContext, stream: Record<string, unknown>) {
  for (const mock of MOCKS) {
    await request.post(`${mock}/__mock/reset`);
    await request.post(`${mock}/__mock/config`, { data: { stream } });
  }
}

/** Cancels whatever suite or race is still running, so the next test starts clean. */
async function stopEverything(request: APIRequestContext) {
  const { suites } = (await (await request.get('/api/suites')).json()) as {
    suites: Array<{ id: string; state: string }>;
  };
  for (const suite of suites.filter((s) => s.state === 'running')) {
    await request.post(`/api/suites/${suite.id}/cancel`);
  }
  const { sessions } = (await (await request.get('/api/sessions')).json()) as {
    sessions: Array<{ id: string; state: string }>;
  };
  for (const session of sessions.filter((s) => s.state === 'running')) {
    await request.post(`/api/sessions/${session.id}/cancel`);
  }
}

const report = (page: Page) => page.getByTestId('suite-report');
const rows = (page: Page) => page.getByTestId('suite-row');
const chip = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });

/**
 * Opens the Suites tab and sets the machines, prompts, thinking settings, Max tokens and a quick
 * plan: one round, no warm-up, no pause.
 */
async function setUp(
  page: Page,
  options: { machines: string[]; presets: string[]; thinking: string[]; maxTokens: string },
) {
  await page.goto('/#/suites');
  for (const machine of TEST_MACHINES) {
    const box = page.getByRole('checkbox', { name: new RegExp(machine.name) });
    await expect(box).toBeEnabled();
    await box.setChecked(options.machines.includes(machine.name));
  }
  for (const name of ['Short', '8K', '32K', 'Puzzle', 'Code', 'Fixed length']) {
    const button = chip(page, 'Prompts', name);
    const on = (await button.getAttribute('aria-pressed')) === 'true';
    if (on !== options.presets.includes(name)) await button.click();
  }
  for (const name of ['Off', 'On']) {
    const button = chip(page, 'Thinking', name);
    const on = (await button.getAttribute('aria-pressed')) === 'true';
    if (on !== options.thinking.includes(name)) await button.click();
  }
  await page.getByLabel('Max tokens').fill(options.maxTokens);
  await page.getByRole('textbox', { name: 'Rounds', exact: true }).fill('1');
  await page
    .getByRole('radiogroup', { name: 'Warm-up' })
    .getByRole('radio', { name: 'Off' })
    .click();
  await page.getByLabel('Pause between rounds, seconds').fill('0');
}

test.beforeAll(async ({ request }) => {
  await streamAll(request, FAST);
  const existing = (await (await request.get('/api/machines')).json()) as Array<{
    id: string;
    name: string;
  }>;
  for (const [index, machine] of TEST_MACHINES.entries()) {
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
});
test.beforeEach(async ({ request }) => {
  await stopEverything(request);
  await streamAll(request, FAST);
});
test.afterAll(async ({ request }) => {
  await stopEverything(request);
  await streamAll(request, FAST);
  for (const mock of MOCKS) await request.post(`${mock}/__mock/reset`);
  for (const id of added) await request.delete(`/api/machines/${id}`);
});

test('counts the races, runs them one after another and sums them up', async ({ page }) => {
  await setUp(page, {
    machines: [MAC.name, LINUX.name],
    presets: ['Short', 'Puzzle'],
    thinking: ['Off', 'On'],
    maxTokens: '64',
  });
  await expect(page.getByTestId('suite-count')).toContainText(
    '4 races: 2 prompts × 2 thinking settings × 1 Max tokens value, 8 requests in all.',
  );
  await page.getByLabel('Max tokens').fill('64, 128');
  await expect(page.getByTestId('suite-count')).toContainText('8 races');
  await page.getByLabel('Max tokens').fill('64');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/#\/suites\/[0-9a-f-]{36}$/);
  // While it runs, the form is held and the top bar offers Cancel.
  await expect(page.getByRole('button', { name: 'Cancel suite' })).toBeVisible();
  await expect(chip(page, 'Prompts', 'Code')).toBeDisabled();

  await expect(report(page)).toContainText('Done', { timeout: 30_000 });
  await expect(page.getByTestId('suite-progress')).toHaveText('4 of 4 races done.');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(rows(page)).toHaveCount(8);
  const first = rows(page).and(page.locator(`[data-race="0"][data-machine="${LINUX.name}"]`));
  await expect(first.locator('td[data-column="state"]')).toHaveText('done');
  await expect(first.locator('td[data-column="metric:decode"]')).toContainText('tok/s');
  // Both stand-ins report llama.cpp's own speed, so the summary uses it.
  await expect(first.locator('td[data-column="metric:decode"]')).toContainText('server');
  await expect(rows(page).locator('td[data-column="thinking"]', { hasText: 'On' })).toHaveCount(4);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csv = await readFile(await (await download).path(), 'utf8');
  const lines = csv.trim().split('\n');
  expect(lines).toHaveLength(9);
  expect(lines[0]).toMatch(/^Prompt,Thinking,Max tokens,Machine,State,Rounds done,/);
  expect(lines[0]).toContain('Decode speed (tok/s),"Decode speed, from"');
  expect(csv).toContain(MAC.name);

  // Each row opens its race, an ordinary race on the Text tab.
  await first.getByRole('link', { name: /^Open race 1/ }).click();
  await expect(page).toHaveURL(/#\/text\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('compare')).toBeVisible();
});

test('skips a race pre-flight refuses, says why, and goes on', async ({ page }) => {
  await setUp(page, {
    machines: [LINUX.name],
    presets: ['Short'],
    thinking: ['Off'],
    maxTokens: '64, 40000',
  });
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(report(page)).toContainText('Done', { timeout: 30_000 });
  await expect(page.getByTestId('suite-progress')).toHaveText('1 of 2 races done.');
  const skipped = rows(page).and(page.locator('[data-race="1"]'));
  await expect(skipped.locator('td[data-column="state"]')).toHaveText('skipped');
  await expect(page.getByTestId('suite-problems')).toContainText(
    /Race 2, Short · thinking off · 40,000 tokens: skipped\. .*do not fit/,
  );
});

test('cancels the race in progress and the rest', async ({ page, request }) => {
  await streamAll(request, SLOW);
  await setUp(page, {
    machines: [LINUX.name],
    presets: ['Short', 'Code'],
    thinking: ['Off'],
    maxTokens: '512',
  });
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('suite-progress')).toContainText('Race 1 of 2', {
    timeout: 15_000,
  });
  await expect(page.getByRole('link', { name: 'Watch it on the Text tab' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel suite' }).click();
  await expect(report(page)).toContainText('Cancelled');
  await expect(rows(page).locator('td[data-column="state"]')).toHaveText([
    'cancelled',
    'cancelled',
  ]);
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});

test('refuses a race from the Text tab while a suite runs', async ({ page, request }) => {
  await streamAll(request, SLOW);
  const machines = (await (await request.get('/api/machines')).json()) as Array<{
    id: string;
    name: string;
  }>;
  const linux = machines.find((m) => m.name === LINUX.name)?.id ?? '';
  const mac = machines.find((m) => m.name === MAC.name)?.id ?? '';
  const started = await request.post('/api/suites', {
    data: {
      machineIds: [linux],
      presets: ['short'],
      thinking: [{ thinking: false }],
      maxTokens: [512, 1024],
      plan: { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' },
    },
  });
  expect(started.status()).toBe(201);
  const id = ((await started.json()) as { id: string }).id;
  await expect
    .poll(
      async () =>
        (
          (await (await request.get(`/api/suites/${id}`)).json()) as {
            races: Array<{ sessionId: string | null }>;
          }
        ).races[0]?.sessionId ?? null,
      { timeout: 15_000 },
    )
    .not.toBeNull();
  const refused = await request.post('/api/sessions', {
    data: {
      workload: 'text',
      machineIds: [mac],
      config: { preset: 'short', maxTokens: 64, thinking: false, reasoningEffort: null },
      plan: { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' },
    },
  });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { message: string }).message).toMatch(/A suite is running/);
  // The Text tab shows the suite's race as it runs.
  await page.goto('/#/text');
  await expect(page.getByTestId('race-progress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await page.goto('/#/suites');
  await page.getByRole('button', { name: 'Cancel suite' }).click();
  await expect(report(page)).toContainText('Cancelled');
});

test('opens a past suite, and deletes it while its races stay', async ({ page }) => {
  await setUp(page, {
    machines: [MAC.name],
    presets: ['Short'],
    thinking: ['Off'],
    maxTokens: '32',
  });
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(report(page)).toContainText('Done', { timeout: 30_000 });
  const raceLink = rows(page)
    .first()
    .getByRole('link', { name: /^Open race 1/ });
  const raceHref = (await raceLink.getAttribute('href')) ?? '';
  expect(raceHref).toMatch(/^#\/text\/[0-9a-f-]{36}$/);

  const list = page.getByTestId('suite-list-row');
  const count = await list.count();
  expect(count).toBeGreaterThanOrEqual(2);
  await expect(list.first()).toHaveAttribute('aria-current', 'true');
  await list
    .nth(1)
    .getByRole('link', { name: /^Open the suite/ })
    .click();
  await expect(list.nth(1)).toHaveAttribute('aria-current', 'true');
  await list
    .first()
    .getByRole('link', { name: /^Open the suite/ })
    .click();
  await expect(list.first()).toHaveAttribute('aria-current', 'true');

  await list
    .first()
    .getByRole('button', { name: /^Delete the suite/ })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete suite' }).click();
  await expect(list).toHaveCount(count - 1);
  await page.goto(`/${raceHref}`);
  await expect(page.getByTestId('run-state')).toHaveText('Done');
});

test('works from the keyboard and fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/suites');
  await expect(page.getByRole('heading', { level: 1, name: 'Suites' })).toBeVisible();
  const code = chip(page, 'Prompts', 'Code');
  await expect(code).toHaveAttribute('aria-pressed', 'false');
  await code.focus();
  await page.keyboard.press('Space');
  await expect(code).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(code).toHaveAttribute('aria-pressed', 'false');
  await expect(report(page)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
