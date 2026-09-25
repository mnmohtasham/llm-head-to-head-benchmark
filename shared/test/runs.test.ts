import { describe, expect, it } from 'vitest';
import type { CloudModel } from '../src/cloud';
import type { MachineProvenance, SessionView } from '../src/session';
import { deviceRuns, quantOfFile, runColumns, runsCsv, type DeviceRun } from '../src/runs';
import { makeRun, makeSession, makeStatus } from './make';

function provenance(machineId: string, over: Partial<MachineProvenance> = {}): MachineProvenance {
  return {
    machineId,
    probedAt: null,
    versions: { unsloth: null, studio: '0.1.815-beta', llamaCpp: 'b9601' },
    platform: { os: 'Linux-6.17.0-41-generic-x86_64', backend: 'cuda', memoryTotalGb: 30.24 },
    gpus: [{ name: 'NVIDIA GeForce RTX 3060', memoryGb: 12 }],
    statusBefore: makeStatus({ totalLayers: 34 }),
    statusAfter: null,
    request: { model: 'unsloth/Qwen3.8-27B-GGUF', enable_thinking: true, reasoning_effort: 'low' },
    sttBefore: null,
    sttAfter: null,
    imageBefore: null,
    imageAfter: null,
    restore: null,
    agent: null,
    ...over,
  };
}

/** RTX and 780M over three rounds: the RTX decodes about three times faster. */
function race(): SessionView {
  const round = (rtx: number, amd: number) => [
    makeRun('rtx', { decodeTokPerSec: rtx, ttftMs: 150, promptTokens: 42 }),
    makeRun('amd', { decodeTokPerSec: amd, ttftMs: 320, promptTokens: 42 }),
  ];
  const session = makeSession(['rtx', 'amd'], [round(57, 18), round(56, 19), round(58, 18.5)]);
  session.machines = [
    { id: 'rtx', name: 'test', color: '#ef8fb0', baseUrl: 'http://10.0.0.1:8888', notes: '' },
    { id: 'amd', name: 'lenovo', color: '#e8a33d', baseUrl: 'http://10.0.0.2:8888', notes: '' },
  ];
  session.provenance = [
    provenance('rtx'),
    provenance('amd', {
      platform: { os: 'Linux-7.0.0-31-generic-x86_64', backend: 'rocm', memoryTotalGb: 26.59 },
      gpus: [{ name: 'AMD Radeon 780M Graphics', memoryGb: 28 }],
      statusBefore: makeStatus({
        quant: 'Q4_0',
        contextLength: 178176,
        cacheTypeKv: 'q4_0',
        gpuLayers: 30,
        totalLayers: 34,
        speculativeType: 'auto',
        specDrafterKind: 'mtp',
      }),
    }),
  ];
  return session;
}

const text = (
  run: DeviceRun | undefined,
  id: string,
  view: Parameters<typeof runColumns>[0] = 'text',
) => {
  const column = runColumns(view).find((c) => c.id === id);
  if (!column || !run) throw new Error(`no column ${id}`);
  return column.text(run);
};

describe('device runs', () => {
  it('makes one row per machine with its hardware, model settings and medians', () => {
    const [rtx, amd] = deviceRuns(race());
    expect(rtx).toMatchObject({
      key: '11111111-1111-4111-8111-111111111111/rtx',
      kind: 'text',
      state: 'done',
      rounds: 3,
      roundsDone: 3,
      machine: 'test',
      others: ['lenovo'],
      gpu: 'NVIDIA GeForce RTX 3060',
      gpuMemoryGb: 12,
      platform: 'CUDA',
      model: 'unsloth/Qwen3.8-27B-GGUF',
      quant: 'Q4_K_M',
      engine: 'GGUF',
      contextLength: 32768,
      kvCache: null,
      gpuLayers: -1,
      slots: 4,
      speculative: 'off',
      prompt: 'Custom: Hi',
      promptTokens: 42,
      thinking: 'on, low',
      maxTokens: 64,
    });
    expect(rtx?.metrics.decode).toBe(57);
    expect(amd?.metrics.decode).toBe(18.5);
    expect(rtx?.metrics.finish).toBe('stop ×3');
    expect(rtx?.wins).toContain('decode');
    expect(amd?.wins).not.toContain('decode');

    expect(text(rtx, 'gpuLayers')).toBe('auto, 34 layers');
    expect(text(amd, 'gpuLayers')).toBe('30 of 34');
    expect(text(rtx, 'kvCache')).toBe('default');
    expect(text(amd, 'kvCache')).toBe('q4_0');
    expect(text(amd, 'speculative')).toBe('auto · mtp');
    expect(text(amd, 'context')).toBe('178,176');
    expect(text(amd, 'contextPerSlot')).toBe('44,544');
    expect(text(amd, 'gpuMemory')).toBe('28 GB');
    expect(text(rtx, 'metric:decode')).toBe('57.0 tok/s');
    expect(text(rtx, 'wins')).toMatch(/decode speed/);
  });

  it('keeps the average beside the median, and shows either', () => {
    const session = race();
    session.rounds[2] = {
      ...session.rounds[2]!,
      runs: [
        makeRun('rtx', { decodeTokPerSec: 20, ttftMs: 150, promptTokens: 42 }),
        makeRun('amd', { decodeTokPerSec: 18.5, ttftMs: 320, promptTokens: 42 }),
      ],
    };
    const [rtx] = deviceRuns(session);
    expect(rtx?.metrics.decode).toBe(56);
    expect(rtx?.means.decode).toBeCloseTo(44.33, 2);
    expect(rtx?.means.finish).toBe('stop ×3');
    const column = (statistic: 'median' | 'mean') =>
      runColumns('text', statistic).find((c) => c.id === 'metric:decode');
    expect(column('median')?.text(rtx!)).toBe('56.0 tok/s');
    expect(column('mean')?.text(rtx!)).toBe('44.3 tok/s');
    expect(column('mean')?.hint).toMatch(/^Average over the counted rounds/);
  });

  it('adds up several GPUs', () => {
    const session = race();
    session.provenance[0] = provenance('rtx', {
      gpus: [
        { name: 'NVIDIA GeForce RTX 4090', memoryGb: 24 },
        { name: 'NVIDIA GeForce RTX 4090', memoryGb: 24 },
      ],
    });
    const [rtx] = deviceRuns(session);
    expect(rtx).toMatchObject({ gpu: '2× NVIDIA GeForce RTX 4090', gpuMemoryGb: 48 });
  });

  it('tells a machine that failed every round from one that failed some', () => {
    const session = race();
    session.state = 'failed';
    session.rounds = session.rounds.map((round, i) => ({
      ...round,
      runs: [
        i === 1 ? { ...makeRun('rtx', {}, 'failed'), error: 'Unsloth stopped' } : round.runs[0]!,
        { ...makeRun('amd', {}, 'failed'), error: 'Out of memory' },
      ],
    }));
    const [rtx, amd] = deviceRuns(session);
    expect(rtx).toMatchObject({ state: 'partial', roundsDone: 2, error: 'Unsloth stopped' });
    expect(amd).toMatchObject({ state: 'failed', roundsDone: 0, error: 'Out of memory' });
    expect(amd?.metrics.decode).toBeNull();
    expect(text(rtx, 'rounds')).toBe('2 of 3, partly failed');
  });

  it('describes a cloud model by its provider and context window', () => {
    const session = race();
    session.config = { ...session.config, thinking: false } as SessionView['config'];
    const model: CloudModel = {
      id: 'gemini-3.8-flash',
      label: 'Gemini 3.8 Flash',
      contextWindow: 1_048_576,
      maxOutput: 65_536,
      thinking: 'always',
      thinkingStyle: 'gemini-level',
      efforts: ['low', 'medium', 'high'],
      sampling: { temperature: false, topP: false, topK: false, seed: true },
    };
    session.provenance[1] = provenance('amd', {
      gpus: [],
      platform: { os: null, backend: null, memoryTotalGb: null },
      statusBefore: null,
      request: { model: 'gemini-3.8-flash' },
      cloud: { provider: 'gemini', model },
    });
    const [, cloud] = deviceRuns(session);
    expect(cloud).toMatchObject({
      cloud: 'gemini',
      gpu: 'Google Gemini, cloud',
      gpuMemoryGb: null,
      model: 'gemini-3.8-flash',
      quant: null,
      engine: 'Google Gemini API',
      contextLength: 1_048_576,
      chatModel: false,
      slots: null,
      thinking: 'on',
    });
    expect(text(cloud, 'kvCache')).toBe('—');
  });

  it('finds the quant in a GGUF file name', () => {
    expect(quantOfFile('flux-2-klein-4b-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantOfFile('models/Qwen-Image-2.1-UD-Q4_K_XL.gguf')).toBe('UD-Q4_K_XL');
    expect(quantOfFile('flux-2-klein-9b-BF16.gguf')).toBe('BF16');
    expect(quantOfFile('model.safetensors')).toBeNull();
    expect(quantOfFile(null)).toBeNull();
  });
});

describe('columns and CSV', () => {
  it('offers the metrics of the chosen kind, and a headline for every kind at once', () => {
    const textIds = runColumns('text').map((c) => c.id);
    expect(textIds).toEqual(
      expect.arrayContaining(['gpu', 'kvCache', 'gpuLayers', 'slots', 'metric:decode']),
    );
    expect(runColumns('image').map((c) => c.id)).not.toContain('kvCache');
    expect(runColumns('command').map((c) => c.id)).not.toContain('model');
    const all = runColumns('all');
    expect(all.map((c) => c.id)).toContain('headline');
    expect(all.some((c) => c.id.startsWith('metric:'))).toBe(false);
    const [rtx] = deviceRuns(race());
    expect(text(rtx, 'headline', 'all')).toBe('57.0 tok/s decode speed');
  });

  it('exports the columns’ raw values, with units in the header', () => {
    const runs = deviceRuns(race());
    const columns = runColumns('text').filter((c) =>
      ['machine', 'gpu', 'gpuMemory', 'metric:decode', 'prompt'].includes(c.id),
    );
    runs[0]!.prompt = 'Custom: say "hi", then stop';
    expect(runsCsv(runs, columns)).toBe(
      [
        'Machine,GPU,GPU memory (GB),Prompt,Decode speed (tok/s)',
        'test,NVIDIA GeForce RTX 3060,12,"Custom: say ""hi"", then stop",57',
        'lenovo,AMD Radeon 780M Graphics,28,Custom: Hi,18.5',
        '',
      ].join('\n'),
    );
  });
});
