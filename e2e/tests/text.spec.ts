import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 4 demo script: race two machines side by side, see the faster one win, lose one machine
// mid-race, cancel, reload mid-race, reopen and delete past races. The phase 3 single-machine
// checks still hold when one machine is picked.
const [MAC, LINUX] = DEMO_MACHINES;
const MAC_MOCK = `http://127.0.0.1:${E2E_MOCK_PORTS[0]}`;
const LINUX_MOCK = `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`;
const MOCKS = [MAC_MOCK, LINUX_MOCK] as const;

test.describe.configure({ mode: 'serial' });

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

async function stream(request: APIRequestContext, mock: string, settings: Record<string, unknown>) {
  await request.post(`${mock}/__mock/config`, { data: { stream: settings } });
}

interface SetUp {
  thinking?: boolean;
  rounds?: number;
  warmup?: boolean;
  pause?: number;
  turns?: boolean;
  preset?: string;
  prefill?: 'Cold' | 'Warm';
  maxTokens?: number;
  /** Set false when pre-flight is expected to hold the race back. */
  ready?: boolean;
}

/**
 * Opens the Text tab and sets which machines race, whether they think, and the run plan. Unless
 * a test asks for more, that is one round, no warm-up and no pause.
 */
async function setUp(page: Page, names: string[], options: SetUp = {}) {
  await page.goto('/#/text');
  for (const machine of DEMO_MACHINES) {
    const box = page.getByRole('checkbox', { name: new RegExp(machine.name) });
    await expect(box).toBeEnabled();
    await box.setChecked(names.includes(machine.name));
  }
  const choose = async (group: string, option: string) =>
    page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();
  await choose('Thinking', options.thinking === false ? 'Off' : 'On');
  await choose('Warm-up', options.warmup ? 'On' : 'Off');
  await choose('Order', options.turns ? 'Take turns' : 'Together');
  await page
    .getByRole('textbox', { name: 'Rounds', exact: true })
    .fill(String(options.rounds ?? 1));
  await page.getByLabel('Pause between rounds, seconds').fill(String(options.pause ?? 0));
  await choose('Prompt', options.preset ?? 'Custom');
  await choose('Prefill', options.prefill ?? 'Cold');
  if (options.maxTokens !== undefined) {
    await page.getByLabel('Max tokens').fill(String(options.maxTokens));
  }
  if (options.ready !== false) {
    await expect(page.getByTestId('preflight-status')).toContainText('All clear');
    await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  }
}

const pane = (page: Page, name: string) =>
  page.getByTestId('run-pane').and(page.locator(`[data-machine="${name}"]`));

async function startAndFinish(page: Page, names: string[]) {
  await page.getByRole('button', { name: 'Start' }).click();
  for (const name of names) {
    await expect(pane(page, name).getByTestId('run-state')).toHaveText(/Done|Failed/, {
      timeout: 20_000,
    });
  }
}

test.beforeAll(async ({ request }) => {
  await ensureMachines(request);
});

test.beforeEach(async ({ request }) => {
  for (const mock of MOCKS) {
    await request.post(`${mock}/__mock/reset`);
    await stream(request, mock, {
      startupMs: 300,
      tokenMs: 20,
      reasoningTokens: 60,
      answerTokens: 60,
    });
  }
});

test.describe('racing two machines', () => {
  test('runs both side by side, and the faster one wins', async ({ page, request }) => {
    await stream(request, LINUX_MOCK, {
      startupMs: 200,
      tokenMs: 12,
      reasoningTokens: 30,
      answerTokens: 40,
    });
    await stream(request, MAC_MOCK, {
      startupMs: 400,
      tokenMs: 30,
      reasoningTokens: 30,
      answerTokens: 40,
    });
    await setUp(page, [MAC.name, LINUX.name]);
    await page.getByRole('button', { name: 'Start' }).click();

    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText(/Thinking|Answering/);
    await expect(pane(page, MAC.name).getByTestId('run-state')).toHaveText(
      /Waiting|Thinking|Answering/,
    );
    const macBox = await pane(page, MAC.name).boundingBox();
    const linuxBox = await pane(page, LINUX.name).boundingBox();
    expect(macBox && linuxBox && Math.abs(macBox.y - linuxBox.y) < 2).toBe(true);
    expect(macBox && linuxBox && Math.abs(macBox.x - linuxBox.x) > 100).toBe(true);

    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Done', {
      timeout: 20_000,
    });
    await expect(pane(page, MAC.name).getByTestId('run-state')).toHaveText('Done', {
      timeout: 20_000,
    });
    await expect(page).toHaveURL(/#\/text\/[0-9a-f-]{36}$/);

    const compare = page.getByTestId('compare');
    const cell = (key: string, name: string) =>
      compare.locator(`tr[data-key="${key}"] td[data-machine="${name}"]`);
    for (const key of ['firstAnswer', 'decode', 'decodeServer']) {
      await expect(cell(key, LINUX.name)).toHaveAttribute('data-best', 'true');
      await expect(cell(key, MAC.name)).not.toHaveAttribute('data-best', 'true');
    }
    await expect(compare.getByTestId('send-skew')).toContainText('within');
    const setup = page.getByTestId('setup');
    await expect(setup).toContainText('unsloth/Qwen3.8-27B-GGUF');
    await expect(setup.locator('tr.differs')).toHaveCount(0);

    const latest = page.getByTestId('session-row').first();
    await expect(latest).toContainText(MAC.name);
    await expect(latest).toContainText(LINUX.name);
    await expect(latest).toHaveAttribute('aria-current', 'true');
  });

  test('a machine that drops out mid-race fails alone, and the other finishes', async ({
    page,
    request,
  }) => {
    await stream(request, MAC_MOCK, { disconnectAfterTokens: 10 });
    await setUp(page, [MAC.name, LINUX.name]);
    await startAndFinish(page, [MAC.name, LINUX.name]);
    await expect(pane(page, MAC.name).getByTestId('run-state')).toHaveText('Failed');
    await expect(pane(page, MAC.name).getByTestId('run-error')).toContainText(
      'broke after 10 chunks',
    );
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Done');
    const compare = page.getByTestId('compare');
    await expect(compare.locator('thead')).toContainText('failed');
    // One finished machine is no contest.
    await expect(compare.locator('td[data-best]')).toHaveCount(0);
  });

  test('cancel stops every machine', async ({ page, request }) => {
    for (const mock of MOCKS) await stream(request, mock, { tokenMs: 80, answerTokens: 400 });
    await setUp(page, [MAC.name, LINUX.name]);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText(/Thinking|Answering/);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Cancelled');
    await expect(pane(page, MAC.name).getByTestId('run-state')).toHaveText('Cancelled');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  });

  test('reloading the page mid-race picks the race up again', async ({ page, request }) => {
    for (const mock of MOCKS) {
      await stream(request, mock, { tokenMs: 40, reasoningTokens: 10, answerTokens: 80 });
    }
    await setUp(page, [MAC.name, LINUX.name]);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Answering', {
      timeout: 10_000,
    });
    await page.reload();
    await expect(pane(page, LINUX.name).getByTestId('answer')).not.toBeEmpty();
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText(/Answering|Done/);
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Done', {
      timeout: 20_000,
    });
    await expect(pane(page, MAC.name).getByTestId('run-state')).toHaveText('Done', {
      timeout: 20_000,
    });
    const words = (await pane(page, LINUX.name).getByTestId('answer').textContent())
      ?.trim()
      .split(/\s+/);
    expect(words).toHaveLength(80);
  });

  test('warns before a race when the machines run different quants', async ({ page, request }) => {
    await request.post(`${LINUX_MOCK}/api/inference/load`, {
      headers: { authorization: `Bearer ${LINUX.apiKey}` },
      data: {
        model_path: 'unsloth/Qwen3.8-27B-GGUF',
        gguf_variant: 'UD-IQ2_XXS',
        max_seq_length: 0,
      },
      timeout: 20_000,
    });
    await setUp(page, [MAC.name, LINUX.name], { ready: false });
    await expect(page.getByTestId('race-warnings')).toContainText(
      `The machines run different quants: ${MAC.name} has Q4_K_M, ${LINUX.name} has UD-IQ2_XXS.`,
    );
    // Warnings hold the race until it is started on purpose.
    await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Race anyway' }).check();
    await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  test('opens a past race from the results log, and deletes one', async ({ page }) => {
    await setUp(page, [LINUX.name]);
    await startAndFinish(page, [LINUX.name]);
    await setUp(page, [MAC.name]);
    await startAndFinish(page, [MAC.name]);

    const rows = page.getByTestId('session-row');
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await rows.nth(1).getByRole('link', { name: 'Open' }).click();
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Done');
    await expect(page.getByTestId('run-pane')).toHaveCount(1);

    const count = await rows.count();
    await rows
      .nth(1)
      .getByRole('button', { name: /^Delete/ })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete race' }).click();
    await expect(rows).toHaveCount(count - 1);
    await expect(page).toHaveURL(/#\/text$/);
  });

  test('fits a phone screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await setUp(page, [MAC.name, LINUX.name]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('rounds', () => {
  test('three rounds after a warm-up give a round table and medians', async ({ page, request }) => {
    await stream(request, LINUX_MOCK, {
      startupMs: 150,
      tokenMs: 8,
      reasoningTokens: 10,
      answerTokens: 20,
    });
    await stream(request, MAC_MOCK, {
      startupMs: 300,
      tokenMs: 20,
      reasoningTokens: 10,
      answerTokens: 20,
    });
    await setUp(page, [MAC.name, LINUX.name], { rounds: 3, warmup: true, pause: 0.2 });
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('race-progress')).toContainText(/Warm-up|round/);
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });

    const rows = page.getByTestId('round-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText('Warm-up, not counted');
    await expect(rows.nth(3)).toContainText('Round 3');
    await expect(rows.nth(1).locator(`td[data-machine="${LINUX.name}"]`)).toContainText('RTT');

    const compare = page.getByTestId('compare');
    await expect(compare).toContainText('medians of 3 rounds');
    const decode = compare.locator('tr[data-key="decode"]');
    await expect(decode).toHaveAttribute('data-verdict', 'win');
    await expect(decode.locator(`td[data-machine="${LINUX.name}"]`)).toHaveAttribute(
      'data-best',
      'true',
    );
    await expect(decode.getByTestId('verdict')).toContainText(LINUX.name);

    // Picking a round shows it in the panes.
    await rows.nth(1).getByRole('button', { name: 'Round 1' }).click();
    await expect(page.getByTestId('race-progress')).toContainText('Showing round 1 of 3');
    await expect(page.getByTestId('session-row').first()).toContainText('3 rounds, medians');
  });

  test('two machines at the same speed are a tie, not a win', async ({ page, request }) => {
    for (const mock of MOCKS) {
      await stream(request, mock, {
        startupMs: 250,
        tokenMs: 15,
        reasoningTokens: 10,
        answerTokens: 30,
        speedFactors: [1, 1.15, 0.9],
      });
    }
    await setUp(page, [MAC.name, LINUX.name], { rounds: 3 });
    await startAndFinish(page, [MAC.name, LINUX.name]);
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
    const compare = page.getByTestId('compare');
    for (const key of ['decode', 'firstAnswer', 'ttft']) {
      await expect(compare.locator(`tr[data-key="${key}"]`)).toHaveAttribute('data-verdict', 'tie');
      await expect(compare.locator(`tr[data-key="${key}"]`).getByTestId('verdict')).toHaveText(
        'Tie',
      );
    }
    // Timing is a tie; energy is not, since the fake Mac draws far less power than the fake RTX.
    await expect(
      compare.locator('tr:not([data-key="energy"]):not([data-key="tokensPerJoule"]) td[data-best]'),
    ).toHaveCount(0);
    await expect(compare.locator('tr[data-key="energy"]')).toHaveAttribute('data-verdict', 'win');
  });

  test('machines on one computer are asked to take turns, and then they do', async ({ page }) => {
    await setUp(page, [MAC.name, LINUX.name], { rounds: 2 });
    // Both fake machines listen on 127.0.0.1.
    await expect(page.getByTestId('same-host')).toContainText('run on the same computer');
    await page.getByRole('button', { name: 'Take turns instead' }).click();
    await expect(
      page.getByRole('radiogroup', { name: 'Order' }).getByRole('radio', { name: 'Take turns' }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('same-host')).toHaveCount(0);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Waiting its turn');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('round-row')).toHaveCount(2);
    await expect(page.getByTestId('compare')).toContainText('took turns, in ABBA order');
  });
});

test.describe('presets, prefill and pre-flight', () => {
  test('warm prefill shows cache hits from round two, cold shows none', async ({ page }) => {
    for (const prefill of ['Warm', 'Cold'] as const) {
      await setUp(page, [MAC.name, LINUX.name], {
        rounds: 2,
        preset: '8K',
        prefill,
        thinking: false,
        maxTokens: 80,
      });
      await expect(page.getByTestId('preset-preview')).toContainText('On Liberty');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
      const rows = page.getByTestId('round-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.first().locator('.round-flags')).not.toContainText('reused');
      if (prefill === 'Warm') {
        await expect(rows.nth(1).locator('.round-flags')).toContainText('reused');
      } else {
        await expect(rows.nth(1).locator('.round-flags')).not.toContainText('reused');
      }
    }
  });

  test('the 32K preset is stopped by pre-flight on a 16K context', async ({ page, request }) => {
    await request.post(`${LINUX_MOCK}/api/inference/load`, {
      headers: { authorization: `Bearer ${LINUX.apiKey}` },
      data: {
        model_path: 'unsloth/Qwen3.8-27B-GGUF',
        gguf_variant: 'Q4_K_M',
        max_seq_length: 16384,
      },
      timeout: 20_000,
    });
    await setUp(page, [LINUX.name], { preset: '32K', ready: false });
    await expect(page.getByTestId('start-blockers')).toContainText(
      `longer than ${LINUX.name}'s context of 16,384`,
    );
    await expect(page.getByTestId('preflight-status')).toContainText('This race cannot start.');
    await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  test('fixed length makes every machine stop on length', async ({ page }) => {
    await setUp(page, [MAC.name, LINUX.name], {
      preset: 'Fixed length',
      thinking: false,
      maxTokens: 20,
      rounds: 2,
    });
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
    const finish = page.getByTestId('compare').locator('tr[data-key="finish"]');
    await expect(finish.locator(`td[data-machine="${MAC.name}"]`)).toHaveText('length ×2');
    await expect(finish.locator(`td[data-machine="${LINUX.name}"]`)).toHaveText('length ×2');
    for (const row of await page.getByTestId('round-row').all()) {
      await expect(row.locator('.round-flags')).toHaveText('');
    }
  });
});

test.describe('telemetry', () => {
  test('the chips follow a race, and energy lands in the measurements', async ({
    page,
    request,
  }) => {
    for (const mock of MOCKS) await stream(request, mock, { tokenMs: 40, answerTokens: 120 });
    await setUp(page, [MAC.name, LINUX.name]);
    const gpu = pane(page, LINUX.name)
      .getByTestId('telemetry')
      .locator('li[data-kind="GPU"] .telemetry-value');
    await expect(gpu).toHaveText(/^\d+%$/);
    const idle = Number.parseInt((await gpu.textContent()) ?? '0', 10);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect
      .poll(async () => Number.parseInt((await gpu.textContent()) ?? '0', 10), { timeout: 10_000 })
      .toBeGreaterThan(Math.max(idle, 40));
    // Apple's unified memory has no separate VRAM chip.
    await expect(
      pane(page, MAC.name).getByTestId('telemetry').locator('li[data-kind="VRAM"]'),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
    const energy = page.getByTestId('compare').locator('tr[data-key="energy"]');
    await expect(energy.locator(`td[data-machine="${LINUX.name}"]`)).toHaveText(/ J/);
  });

  test('the switch turns telemetry off everywhere, and on again', async ({ page }) => {
    await setUp(page, [LINUX.name]);
    await expect(pane(page, LINUX.name).getByTestId('telemetry')).toBeVisible();
    const group = page.getByRole('radiogroup', { name: 'Telemetry' });
    await group.getByRole('radio', { name: 'Off' }).click();
    await expect(pane(page, LINUX.name).getByTestId('telemetry')).toHaveCount(0);
    await page.goto('/#/machines');
    await expect(page.getByTestId('machine-card').first().getByTestId('telemetry')).toHaveCount(0);
    await page
      .getByRole('radiogroup', { name: 'Telemetry' })
      .getByRole('radio', { name: 'On' })
      .click();
    await expect(page.getByTestId('machine-card').first().getByTestId('telemetry')).toBeVisible();
  });
});

test.describe('the report', () => {
  test('shows a scoreboard and charts, and exports JSON, CSV and Markdown', async ({
    page,
    request,
  }) => {
    await stream(request, LINUX_MOCK, { tokenMs: 8 });
    await setUp(page, [MAC.name, LINUX.name], { rounds: 2 });
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('scoreboard')).toContainText(`${LINUX.name} decodes`);
    await expect(page.getByTestId('race-chart').locator('canvas')).toBeVisible();
    await expect(page.getByTestId('telemetry-chart').locator('canvas')).toBeVisible();

    const exported = async (label: string) => {
      const download = page.waitForEvent('download');
      await page.getByTestId('exports').getByRole('link', { name: label }).click();
      return readFile(await (await download).path(), 'utf8');
    };
    const json = JSON.parse(await exported('JSON')) as {
      schemaVersion: number;
      rounds: Array<{ runs: Array<{ raw: { events: unknown[] } }> }>;
    };
    expect(json.schemaVersion).toBe(7);
    expect(json.rounds).toHaveLength(2);
    expect(json.rounds[0]?.runs[0]?.raw.events.length).toBeGreaterThan(10);
    const csv = await exported('CSV');
    const blocks = csv.trim().split('\r\n\r\n');
    expect(blocks[0]?.split('\r\n')[0]).toBe(`Metric,Unit,${MAC.name},${LINUX.name},Result`);
    expect(blocks[1]?.split('\r\n')).toHaveLength(3);
    const markdown = await exported('Markdown');
    expect(markdown.split('\n')[0]).toBe(`# Model Duel: ${MAC.name} against ${LINUX.name}`);
    expect(markdown).toContain(`${LINUX.name} decodes`);
    expect(markdown).toContain('## How to read this');
  });

  test('a blind vote hides the machines until the reveal', async ({ page }) => {
    await setUp(page, [MAC.name, LINUX.name], { rounds: 2 });
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Blind vote' }).click();
    await expect(page.getByTestId('blind-round')).toHaveCount(2);
    const before = (await page.locator('body').textContent()) ?? '';
    expect(before).not.toContain(MAC.name);
    expect(before).not.toContain(LINUX.name);
    expect(before).not.toContain('Qwen');
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeDisabled();
    for (const round of await page.getByTestId('blind-round').all()) {
      await round.getByRole('radio', { name: 'Left is better' }).click();
      await expect(round.getByRole('radio', { name: 'Left is better' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    }
    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    const reveal = page.getByTestId('blind-reveal');
    await expect(reveal).toContainText(MAC.name);
    await expect(reveal).toContainText(LINUX.name);
    await expect(reveal.getByTestId('tally')).toContainText('unsloth/Qwen3.8-27B-GGUF');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('2 blind votes cast')).toBeVisible();
  });
});

test.describe('one machine', () => {
  test('streams thinking, folds it at the first answer word, and fills the measurements', async ({
    page,
  }) => {
    await setUp(page, [LINUX.name]);
    await page.getByRole('button', { name: 'Start' }).click();
    const linux = pane(page, LINUX.name);
    await expect(linux.getByTestId('run-state')).toHaveText('Thinking');
    await expect(linux.getByTestId('thinking')).toHaveAttribute('open', '');
    await expect(linux.getByTestId('answer-empty')).toContainText('Thinking…');
    await expect(linux.getByTestId('answer-empty')).toHaveCount(0, { timeout: 10_000 });
    await expect(linux.getByTestId('thinking')).not.toHaveAttribute('open');
    await expect(linux.getByTestId('run-state')).toHaveText('Done', { timeout: 15_000 });
    await expect(linux.getByTestId('first-word')).toHaveText(/^\d+\.\d\d$/);

    const table = page.getByTestId('run-metrics');
    const cell = (label: string, column: 'measured' | 'reported') =>
      table
        .getByRole('row', { name: new RegExp(`^${label}`) })
        .locator(`td[data-column="${column}"]`);
    await expect(cell('Time to first token', 'measured')).toHaveText(/^\d+ ms$/);
    await expect(cell('Time to first token', 'reported')).toHaveText(/^\d+ ms$/);
    await expect(cell('Decode speed', 'measured')).toHaveText(/ tok\/s$/);
    await expect(cell('Output tokens', 'measured')).toHaveText('120');
    await expect(table.getByTestId('network-share')).toBeVisible();
    for (const note of ['thinking-missing', 'speculative', 'prompt-cache', 'hit-max-tokens']) {
      await expect(table.getByTestId(note)).toHaveCount(0);
    }
    await expect(page.getByTestId('compare')).toHaveCount(0);
    await expect(page.getByTestId('setup')).toContainText('Q4_K_M');
    await expect(page.getByRole('region', { name: 'Activity' })).toContainText('First word');
  });

  test('runs without thinking when it is switched off', async ({ page }) => {
    await setUp(page, [LINUX.name], { thinking: false });
    await startAndFinish(page, [LINUX.name]);
    await expect(pane(page, LINUX.name).getByTestId('thinking')).toHaveCount(0);
    const table = page.getByTestId('run-metrics');
    await expect(
      table.getByRole('row', { name: /^Thinking time/ }).locator('td[data-column="measured"]'),
    ).toHaveText('n/a');
  });

  test('says why there is no answer when the model thinks until Max tokens', async ({ page }) => {
    await setUp(page, [LINUX.name]);
    await page.getByLabel('Max tokens').fill('30');
    await startAndFinish(page, [LINUX.name]);
    await expect(pane(page, LINUX.name).getByTestId('answer-empty')).toContainText(
      'No answer: the model used all 30 tokens thinking',
    );
    await expect(pane(page, LINUX.name).getByTestId('thinking')).toHaveAttribute('open', '');
    await expect(page.getByTestId('hit-max-tokens')).toContainText('before the answer started');
  });

  test('warns when thinking was on but the model wrote it into the answer', async ({
    page,
    request,
  }) => {
    await stream(request, LINUX_MOCK, { thinkingInAnswer: true });
    await setUp(page, [LINUX.name]);
    await startAndFinish(page, [LINUX.name]);
    await expect(pane(page, LINUX.name).getByTestId('thinking')).toHaveCount(0);
    await expect(page.getByTestId('thinking-missing')).toContainText('skipped its thinking block');
  });

  test('flags speculative decoding and a prompt cache hit', async ({ page, request }) => {
    await stream(request, LINUX_MOCK, { cachedPromptTokens: 12, draftAcceptRate: 0.6 });
    await setUp(page, [LINUX.name]);
    await startAndFinish(page, [LINUX.name]);
    const table = page.getByTestId('run-metrics');
    const row = (label: string) => table.getByRole('row', { name: new RegExp(`^${label}`) });
    await expect(table.getByTestId('speculative')).toContainText('Speculative decoding was on');
    await expect(table.getByTestId('prompt-cache')).toContainText('12 of');
    await expect(
      row('Speculative drafts accepted').locator('td[data-column="reported"]'),
    ).toHaveText(/^\d+ of \d+ \(60%\)$/);
    const measured = await row('Prompt tokens').locator('td[data-column="measured"]').textContent();
    await expect(row('Prompt tokens').locator('td[data-column="reported"]')).toHaveText(
      measured ?? '',
    );
  });

  test('shows an error Unsloth sends in the middle of the stream', async ({ page, request }) => {
    await stream(request, LINUX_MOCK, { errorAfterTokens: 5 });
    await setUp(page, [LINUX.name]);
    await startAndFinish(page, [LINUX.name]);
    await expect(pane(page, LINUX.name).getByTestId('run-error')).toContainText(
      'Unsloth reported: Context size has been exceeded.',
    );
    await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Failed');
  });

  test('will not start while a chosen machine has no model', async ({ page, request }) => {
    await request.post(`${MAC_MOCK}/api/inference/unload`, {
      headers: { authorization: `Bearer ${MAC.apiKey}` },
      data: { model_path: 'unsloth/Qwen3.8-27B-GGUF' },
    });
    await page.goto('/#/text');
    const box = page.getByRole('checkbox', { name: new RegExp(MAC.name) });
    await box.setChecked(true);
    await expect(page.getByTestId('start-blockers')).toContainText(
      `No model is loaded on ${MAC.name}. Load one on the Models tab.`,
    );
    await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  });
});
