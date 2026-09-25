import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEMO_MACHINES } from '../../scripts/demo-config';
import { E2E_MOCK_PORTS } from '../ports';

// Phase 9 demo script: race two machines on the bundled LibriSpeech clip, see real-time factor and
// word error rate side by side with the wrong words marked, then transcribe an uploaded file.
const [MAC, LINUX] = DEMO_MACHINES;
const MAC_MOCK = `http://127.0.0.1:${E2E_MOCK_PORTS[0]}`;
const LINUX_MOCK = `http://127.0.0.1:${E2E_MOCK_PORTS[1]}`;

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

const pane = (page: Page, name: string) =>
  page.getByTestId('run-pane').and(page.locator(`[data-machine="${name}"]`));

const choose = (page: Page, group: string, option: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

async function setUp(page: Page, names: string[], engine: string) {
  await page.goto('/#/transcribe');
  for (const machine of DEMO_MACHINES) {
    const box = page.getByRole('checkbox', { name: new RegExp(machine.name) });
    await expect(box).toBeEnabled();
    await box.setChecked(names.includes(machine.name));
  }
  await choose(page, 'Engine', engine);
  await choose(page, 'Warm-up', 'Off');
  await page.getByRole('textbox', { name: 'Rounds', exact: true }).fill('1');
  await page.getByLabel('Pause between rounds, seconds').fill('0');
}

/** A WAV file of silence, as a browser upload. */
function silence(seconds: number) {
  const data = Buffer.alloc(16_000 * 2 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return { name: 'meeting.wav', mimeType: 'audio/wav', buffer: Buffer.concat([header, data]) };
}

test.beforeAll(async ({ request }) => {
  await ensureMachines(request);
});

test.beforeEach(async ({ request }) => {
  await request.post(`${MAC_MOCK}/__mock/reset`);
  await request.post(`${LINUX_MOCK}/__mock/reset`);
  await request.post(`${LINUX_MOCK}/__mock/config`, {
    data: { stt: { loadMs: 100, msPerAudioSecond: 4 } },
  });
  await request.post(`${MAC_MOCK}/__mock/config`, {
    data: { stt: { loadMs: 100, msPerAudioSecond: 10 } },
  });
});

test('races the LibriSpeech clip: real-time factor, word errors marked, and a winner', async ({
  page,
}) => {
  await setUp(page, [MAC.name, LINUX.name], 'Transformers');
  await expect(page.getByTestId('model-on-disk')).toHaveText(
    'On disk on every machine for transformers.',
  );
  await expect(page.getByTestId('preflight-status')).toContainText('All clear');
  await expect(page.getByTestId('preflight-status')).toContainText(
    'librispeech-6930-75918.wav, 70.3 s, 2.2 MB',
  );
  await page.getByRole('button', { name: 'Start' }).click();
  for (const name of [MAC.name, LINUX.name]) {
    await expect(pane(page, name).getByTestId('run-state')).toHaveText('Done', { timeout: 20_000 });
  }
  // Linux transcribes 70.3 s in about 0.28 s, the Mac in about 0.7 s.
  const rtf = async (name: string) =>
    Number((await pane(page, name).getByTestId('rtf').textContent())?.replace('×', ''));
  expect(await rtf(LINUX.name)).toBeGreaterThan(await rtf(MAC.name));
  await expect(pane(page, LINUX.name).getByTestId('wer')).toHaveText('1.6%');
  await expect(pane(page, MAC.name).getByTestId('wer')).toHaveText('2.6%');
  await expect(
    pane(page, LINUX.name).getByTestId('transcript-diff').locator('mark.wer-sub'),
  ).toHaveCount(3);
  await expect(
    pane(page, LINUX.name).getByTestId('transcript-diff').locator('mark.wer-sub').first(),
  ).toHaveAttribute('title', /^Said: /);
  await pane(page, LINUX.name).getByRole('button', { name: 'Show the text as returned' }).click();
  await expect(pane(page, LINUX.name).getByTestId('answer')).toContainText(
    'Concord returned to its place',
  );

  await expect(page.getByTestId('phase-bars')).toContainText('processing');
  const stats = page.getByTestId('compare');
  await expect(stats.getByRole('row', { name: /Real-time factor/ })).toContainText(LINUX.name);
  const row = page.getByTestId('session-row').first();
  await expect(row).toContainText('Transcribe LibriSpeech clip, 70 s with large-v3-turbo');
  await expect(row).toContainText('real time, WER 1.6%');

  // The report reads on its own, with the clip's credit.
  const md = await page.request.get(
    (await page.getByRole('link', { name: 'Markdown' }).getAttribute('href')) ?? '',
  );
  expect(await md.text()).toContain('LibriSpeech test-clean, speaker 6930');

  // The Text tab lists only text races.
  await page.goto('/#/text');
  await expect(page.getByText('Loading past races…')).toBeHidden();
  await expect(page.getByTestId('session-row').filter({ hasText: 'Transcribe' })).toHaveCount(0);
});

test('warns when GGUF falls back, and stops a model that would have to download', async ({
  page,
}) => {
  await setUp(page, [MAC.name, LINUX.name], 'GGUF');
  await expect(page.getByTestId('race-warnings')).toContainText(
    `${MAC.name} cannot run GGUF speech models`,
  );
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  await page.getByLabel('Race anyway').check();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();

  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('tiny');
  await expect(page.getByTestId('model-on-disk')).toHaveText(
    'Not on disk for gguf on any picked machine.',
  );
  await expect(page.getByTestId('start-blockers')).toContainText('tiny is not downloaded');
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
});

test('transcribes an uploaded file, scored against the text pasted with it', async ({ page }) => {
  await setUp(page, [LINUX.name], 'GGUF');
  await choose(page, 'Audio', 'Upload a file');
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  await page.getByLabel('Audio file').setInputFiles(silence(4));
  await expect(page.getByTestId('upload-status')).toContainText('meeting.wav, 0.1 MB, 4.0 s');
  await page
    .getByLabel('What was said, for the word error rate (optional)')
    .fill('The quick brown fox jumps over the lazy dog.');
  await expect(page.getByTestId('preflight-status')).toContainText('All clear');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(pane(page, LINUX.name).getByTestId('run-state')).toHaveText('Done', {
    timeout: 20_000,
  });
  await expect(pane(page, LINUX.name).getByTestId('wer')).not.toHaveText('n/a');
  await expect(
    pane(page, LINUX.name).getByTestId('transcript-diff').locator('mark.wer-ins').first(),
  ).toBeVisible();

  // Opening the race again from its link puts the upload back in the form.
  await page.reload();
  await expect(page.getByTestId('upload-status')).toContainText('meeting.wav');
  await expect(page.getByLabel('What was said, for the word error rate (optional)')).toHaveValue(
    'The quick brown fox jumps over the lazy dog.',
  );
});

test('fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/transcribe');
  await expect(page.getByRole('radiogroup', { name: 'Audio' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
