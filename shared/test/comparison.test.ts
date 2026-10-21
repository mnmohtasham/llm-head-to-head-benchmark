import { describe, expect, it } from 'vitest';
import {
  cannotCompare,
  compareRuns,
  likeForLikeNote,
  parseResultsLink,
  ratioText,
  ratioTo,
  requestDifferences,
  resultsLink,
} from '../src/comparison';
import { deviceRuns } from '../src/runs';
import { makeDeviceRun, makeRun, makeSession, makeStatus } from './make';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

/** The same machine before and after an update, and a second machine. */
function three() {
  const before = makeDeviceRun({ sessionId: S1 });
  const after = makeDeviceRun({
    sessionId: S2,
    createdAt: '2026-10-02T12:00:00.000Z',
    llamaCpp: 'b9650',
    kvCache: 'q8_0',
    metrics: { decode: 28, decodeServer: 31, ttft: 320, ttftServer: 300, finish: 'stop ×3' },
    means: { decode: 27, decodeServer: 30, ttft: 330, ttftServer: 310, finish: 'stop ×3' },
  });
  const amd = makeDeviceRun({
    sessionId: S3,
    machineId: 'amd',
    machine: 'lenovo',
    gpu: 'AMD Radeon 780M Graphics',
    gpuMemoryGb: 28,
    platform: 'ROCm',
    metrics: { decode: 101.2, decodeServer: 104.88, ttft: 80, ttftServer: null, finish: 'length' },
    means: { decode: 100, decodeServer: 104, ttft: 82, ttftServer: null, finish: 'length' },
  });
  return [before, after, amd];
}

const row = (comparison: ReturnType<typeof compareRuns>, key: string) => {
  const found =
    comparison.metrics.find((r) => r.key === key) ?? comparison.setup.find((r) => r.id === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};

describe('which runs can be compared', () => {
  it('takes 2 to 6 runs of one workload, and says why not otherwise', () => {
    const run = (i: number, kind: 'text' | 'image' = 'text') =>
      makeDeviceRun({ sessionId: `s${i}`, kind, workload: kind });
    expect(cannotCompare([])).toBe('Tick 2 to 6 runs to compare them.');
    expect(cannotCompare([run(1)])).toBe('Tick at least one more run to compare.');
    expect(cannotCompare([run(1), run(2)])).toBeNull();
    expect(cannotCompare([1, 2, 3, 4, 5, 6].map((i) => run(i)))).toBeNull();
    expect(cannotCompare([1, 2, 3, 4, 5, 6, 7].map((i) => run(i)))).toBe(
      'Compare at most 6 runs at once; 7 are ticked.',
    );
    expect(cannotCompare([run(1), run(2), run(3, 'image')])).toBe(
      'These runs are of different workloads (2 Text and 1 Image), which measure different things. Tick runs of one workload.',
    );
  });
});

describe('ratios', () => {
  it('follows which way is better, and gives none without a direction', () => {
    expect(ratioTo(50, 92, 'higher')).toEqual({ times: 1.84, better: true });
    expect(ratioTo(100, 210, 'lower')).toEqual({ times: 2.1, better: false });
    expect(ratioTo(300, 150, 'lower')).toEqual({ times: 2, better: true });
    expect(ratioTo(40, 20, 'higher')).toEqual({ times: 2, better: false });
    expect(ratioTo(100, 120, null)).toBeNull();
    expect(ratioTo(0, 5, 'lower')).toBeNull();
    expect(ratioTo(5, 0, 'lower')).toBeNull();
  });

  it('reads as faster or slower, in the words of the unit', () => {
    expect(ratioText({ times: 1.84, better: true }, 'tok/s')).toBe('1.84× faster');
    expect(ratioText({ times: 2.1, better: false }, 'ms')).toBe('2.10× slower');
    expect(ratioText({ times: 12.34, better: true }, 'tok/s')).toBe('12.3× faster');
    expect(ratioText({ times: 1.003, better: false }, 'tok/s')).toBe('same');
    expect(ratioText({ times: 1.5, better: true }, 'J')).toBe('1.50× less energy');
    expect(ratioText({ times: 1.5, better: false }, 'tok/J')).toBe('1.50× less efficient');
    expect(ratioText({ times: 2, better: true }, '%')).toBe('2.00× fewer errors');
  });
});

describe('a comparison', () => {
  it('marks every setting that differs from the first run', () => {
    const comparison = compareRuns(three());
    expect(comparison.kind).toBe('text');
    expect(comparison.setup.map((r) => r.id)).toEqual(
      expect.arrayContaining(['machine', 'gpu', 'llamaCpp', 'kvCache', 'prompt', 'rounds']),
    );
    const llama = row(comparison, 'llamaCpp');
    expect(llama).toMatchObject({ label: 'llama.cpp', differs: true });
    expect('cells' in llama && llama.cells).toEqual([
      { text: 'b9601', differs: false },
      { text: 'b9650', differs: true },
      { text: 'b9601', differs: false },
    ]);
    const kv = row(comparison, 'kvCache');
    expect('cells' in kv && kv.cells.map((c) => c.text)).toEqual(['default', 'q8_0', 'default']);
    expect(row(comparison, 'gpu')).toMatchObject({ differs: true });
    expect(row(comparison, 'model')).toMatchObject({ differs: false });
    // Settings no run has are left out: no run here has a GPU memory mode.
    expect(comparison.setup.some((r) => r.id === 'gpuMemoryMode')).toBe(false);
  });

  it('stars the best value and gives each run’s ratio to the first', () => {
    const comparison = compareRuns(three());
    const decode = comparison.metrics.find((r) => r.key === 'decodeServer');
    expect(decode?.cells.map((c) => [c.text, c.best, c.versus])).toEqual([
      ['57.0 tok/s', false, null],
      ['31.0 tok/s', false, '1.84× slower'],
      ['104.9 tok/s', true, '1.84× faster'],
    ]);
    const ttft = comparison.metrics.find((r) => r.key === 'ttft');
    expect(ttft?.cells.map((c) => [c.best, c.versus])).toEqual([
      [false, null],
      [false, '2.00× slower'],
      [true, '2.00× faster'],
    ]);
    // A run without the number says so, and has no ratio.
    const server = comparison.metrics.find((r) => r.key === 'ttftServer');
    expect(server?.cells[2]).toMatchObject({ text: 'n/a', best: false, ratio: null });
    // The finish reason has no direction, so no ratio and no star.
    const finish = comparison.metrics.find((r) => r.key === 'finish');
    expect(finish?.cells.map((c) => [c.text, c.best, c.versus])).toEqual([
      ['stop ×3', false, null],
      ['stop ×3', false, null],
      ['length', false, null],
    ]);
    // Metrics none of the runs has are left out.
    expect(comparison.metrics.some((r) => r.key === 'energy')).toBe(false);
  });

  it('follows the median or average', () => {
    const [before, after] = three();
    const decode = (statistic: 'median' | 'mean') =>
      compareRuns([before!, after!], statistic).metrics.find((r) => r.key === 'decode')?.cells;
    expect(decode('median')?.map((c) => c.text)).toEqual(['55.0 tok/s', '28.0 tok/s']);
    expect(decode('mean')?.map((c) => c.text)).toEqual(['54.0 tok/s', '27.0 tok/s']);
    expect(decode('mean')?.[1]?.versus).toBe('2.00× slower');
  });

  it('stars nothing when every run has the same value', () => {
    const a = makeDeviceRun({ sessionId: S1 });
    const b = makeDeviceRun({ sessionId: S2 });
    const decode = compareRuns([a, b]).metrics.find((r) => r.key === 'decode');
    expect(decode?.cells.map((c) => [c.best, c.versus])).toEqual([
      [false, null],
      [false, 'same'],
    ]);
  });

  it('compares rows built from real races, of other kinds too', () => {
    const session = makeSession(
      ['rtx', 'amd'],
      [
        [
          makeRun('rtx', { decodeTokPerSec: 57, ttftMs: 150 }),
          makeRun('amd', { decodeTokPerSec: 19, ttftMs: 320 }),
        ],
      ],
    );
    session.provenance = ['rtx', 'amd'].map((machineId) => ({
      machineId,
      probedAt: null,
      versions: { unsloth: null, studio: '0.1.815-beta', llamaCpp: 'b9601' },
      platform: { os: 'Linux', backend: 'cuda', memoryTotalGb: 32 },
      gpus: [{ name: machineId === 'rtx' ? 'RTX 3060' : 'Radeon 780M', memoryGb: 12 }],
      statusBefore: makeStatus(),
      statusAfter: null,
      request: { model: 'm', enable_thinking: false },
      sttBefore: null,
      sttAfter: null,
      imageBefore: null,
      imageAfter: null,
      restore: null,
    }));
    const comparison = compareRuns(deviceRuns(session));
    expect(comparison.requestDiffers).toEqual([]);
    expect(comparison.metrics.find((r) => r.key === 'decode')?.cells[1]?.versus).toBe(
      '3.00× slower',
    );
    expect(row(comparison, 'gpu')).toMatchObject({ differs: true });

    const images = [1, 2].map((i) =>
      makeDeviceRun({
        sessionId: `s${i}`,
        kind: 'image',
        workload: 'image',
        chatModel: false,
        prompt: null,
        promptText: null,
        thinking: null,
        maxTokens: null,
        prefill: null,
        settings: 'Custom, 512×512, 4 steps, guidance 3.5, seed 7',
        metrics: { stepsPerSec: i, imageTime: 10_000 / i },
        means: { stepsPerSec: i, imageTime: 10_000 / i },
      }),
    );
    const image = compareRuns(images);
    expect(image.metrics.map((r) => r.key)).toEqual(['imageTime', 'stepsPerSec']);
    expect(image.metrics[1]?.cells[1]?.versus).toBe('2.00× faster');
    expect(image.setup.some((r) => r.id === 'kvCache')).toBe(false);
    expect(image.setup.find((r) => r.id === 'settings')?.differs).toBe(false);
  });
});

describe('like for like', () => {
  it('names what the runs were asked differently', () => {
    const base = makeDeviceRun({ sessionId: S1 });
    expect(requestDifferences([base, makeDeviceRun({ sessionId: S2 })])).toEqual([]);
    const other = makeDeviceRun({
      sessionId: S2,
      prompt: 'Custom: Why is the sky blue?',
      promptText: 'Why is the sky blue?',
      maxTokens: 2048,
    });
    expect(requestDifferences([base, other])).toEqual(['prompt', 'Max tokens']);
    expect(likeForLikeNote(['prompt', 'Max tokens'])).toBe(
      'Not like for like: these runs did not answer the same request, since their prompt and Max tokens differ. That moves the numbers as much as the hardware does.',
    );
    expect(likeForLikeNote(['thinking'])).toMatch(/since their thinking differs\./);
    expect(likeForLikeNote([])).toBeNull();
  });

  it('tells two custom prompts apart even when they start alike', () => {
    const start = 'Summarise the following text in five points, please, and keep it short';
    const a = makeDeviceRun({ sessionId: S1, prompt: 'Custom: …', promptText: `${start}: A` });
    const b = makeDeviceRun({ sessionId: S2, prompt: 'Custom: …', promptText: `${start}: B` });
    expect(requestDifferences([a, b])).toEqual(['prompt']);
    expect(compareRuns([a, b]).setup.find((r) => r.id === 'prompt')?.cells[1]?.differs).toBe(true);
  });

  it('checks prefill, thinking and requests at once too', () => {
    const base = makeDeviceRun({ sessionId: S1, kind: 'throughput', concurrency: 4 });
    const other = makeDeviceRun({
      sessionId: S2,
      kind: 'throughput',
      concurrency: 8,
      prefill: 'warm',
      thinking: 'on, low',
    });
    expect(requestDifferences([base, other])).toEqual(['thinking', 'prefill', 'requests at once']);
  });
});

describe('links', () => {
  it('writes and reads the comparison and history in the hash', () => {
    const keys = [`${S1}/rtx`, `${S2}/amd`];
    const hash = resultsLink({ compare: keys });
    expect(hash).toBe(`#/results?compare=${S1}/rtx,${S2}/amd`);
    expect(parseResultsLink(hash)).toEqual({ compare: keys, history: null });
    const both = resultsLink({ compare: keys, history: keys[0] });
    expect(parseResultsLink(both)).toEqual({ compare: keys, history: keys[0] });
    expect(resultsLink({})).toBe('#/results');
    expect(resultsLink({ compare: [], history: null })).toBe('#/results');
  });

  it('survives encoded, repeated and broken parts', () => {
    expect(parseResultsLink(`#/results?compare=${S1}%2Frtx,,${S1}/rtx`).compare).toEqual([
      `${S1}/rtx`,
    ]);
    expect(parseResultsLink('#/results?compare=%E0%A4%A,ok').compare).toEqual(['ok']);
    expect(parseResultsLink('#/results')).toEqual({ compare: [], history: null });
    expect(parseResultsLink('#/text/abc?compare=x')).toEqual({ compare: [], history: null });
    expect(parseResultsLink('#/results?other=1&history=')).toEqual({ compare: [], history: null });
    // A key with a comma or an ampersand would come back whole.
    const odd = 'a,b&c/d';
    expect(parseResultsLink(resultsLink({ compare: [odd], history: odd }))).toEqual({
      compare: [odd],
      history: odd,
    });
  });
});
