import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildShareRecord,
  checkShareEndpoint,
  cleanDisplayName,
  osFamily,
  shareJsonSchema,
  shareRecordSchema,
} from '../src/share';
import type { MachineProvenance } from '../src/session';
import { makeRun, makeSession, makeStatus } from './make';

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const SENDER = { publicKey: 'A'.repeat(43), version: '1.7.0', build: null };

function race() {
  const session = makeSession(
    ['rtx', 'amd'],
    [
      [makeRun('rtx', { decodeTokPerSec: 57 }), makeRun('amd', { decodeTokPerSec: 18 })],
      [makeRun('rtx', { decodeTokPerSec: 56 }), makeRun('amd', {}, 'failed')],
    ],
  );
  session.id = '055d9daf-e177-4abc-ad5f-601db07b75cd';
  session.machines = [
    {
      id: 'rtx',
      name: 'Sina’s machine',
      color: '#fff',
      baseUrl: 'http://10.1.2.3:8888',
      notes: 'desk',
    },
    { id: 'amd', name: 'lenovo', color: '#fff', baseUrl: 'http://10.1.2.4:8888', notes: '' },
  ];
  const provenance = (machineId: string): MachineProvenance => ({
    machineId,
    probedAt: null,
    versions: { unsloth: null, studio: '0.1.815-beta', llamaCpp: 'b9601' },
    platform: {
      os: 'Linux-6.17.0-41-generic-x86_64-with-glibc2.42',
      backend: 'cuda',
      memoryTotalGb: 30,
    },
    gpus: [{ name: 'NVIDIA GeForce RTX 3060', memoryGb: 12 }],
    statusBefore: makeStatus({ activeModel: '/home/mani/models/secret-model.gguf' }),
    statusAfter: null,
    request: { enable_thinking: false },
    sttBefore: null,
    sttAfter: null,
    imageBefore: null,
    imageAfter: null,
    restore: null,
    agent: null,
  });
  session.provenance = [provenance('rtx'), provenance('amd')];
  return session;
}

describe('share records', () => {
  it('follow the strict schema, with the rounds’ values and nothing identifying', () => {
    const record = buildShareRecord(
      race(),
      'rtx',
      { displayName: '', includePrompt: false },
      SENDER,
      digest,
    );
    expect(shareRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      raceId: '055d9daf-e177-4abc-ad5f-601db07b75cd',
      race: { state: 'done', rounds: 2, roundsDone: 2, machines: 2 },
      machine: { os: 'Linux 6.17', platform: 'CUDA' },
      model: { id: '~/models/secret-model.gguf', kvCache: 'default' },
      settings: { prompt: 'custom', promptText: null },
    });
    expect(record?.metrics.find((m) => m.key === 'decode')).toMatchObject({
      values: [57, 56],
      median: 56.5,
      mean: 56.5,
      n: 2,
    });
    const text = JSON.stringify(record);
    for (const secret of ['Sina', 'lenovo', '10.1.2.3', 'desk', '/home/mani']) {
      expect(text).not.toContain(secret);
    }
  });

  it('keep a stable id per sender, race and machine', () => {
    const a = buildShareRecord(
      race(),
      'rtx',
      { displayName: '', includePrompt: false },
      SENDER,
      digest,
    );
    const b = buildShareRecord(
      race(),
      'rtx',
      { displayName: 'x', includePrompt: true },
      SENDER,
      digest,
    );
    const other = buildShareRecord(
      race(),
      'rtx',
      { displayName: '', includePrompt: false },
      { ...SENDER, publicKey: 'B'.repeat(43) },
      digest,
    );
    expect(a?.submissionId).toBe(b?.submissionId);
    expect(a?.submissionId).not.toBe(other?.submissionId);
  });

  it('mark a machine with failed rounds as partial, with null for those rounds', () => {
    const record = buildShareRecord(
      race(),
      'amd',
      { displayName: '', includePrompt: false },
      SENDER,
      digest,
    );
    expect(record?.race).toMatchObject({ state: 'partial', roundsDone: 1 });
    expect(record?.metrics.find((m) => m.key === 'decode')?.values).toEqual([18, null]);
  });

  it('are refused for a machine that never finished a round', () => {
    const session = race();
    session.rounds = session.rounds.map((round) => ({
      ...round,
      runs: round.runs.map((run) =>
        run.machineId === 'amd' ? { ...run, state: 'failed' as const } : run,
      ),
    }));
    expect(
      buildShareRecord(session, 'amd', { displayName: '', includePrompt: false }, SENDER, digest),
    ).toBeNull();
    expect(
      buildShareRecord(
        session,
        'nobody',
        { displayName: '', includePrompt: false },
        SENDER,
        digest,
      ),
    ).toBeNull();
  });

  it('match the JSON Schema in docs, which npm run result-schema writes', async () => {
    const committed = JSON.parse(
      await readFile(new URL('../../docs/share-format.schema.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify(shareJsonSchema())));
  });
});

describe('cleaning and checking', () => {
  it('keeps the OS family and version only', () => {
    expect(osFamily('Linux-6.17.0-41-generic-x86_64-with-glibc2.42')).toBe('Linux 6.17');
    expect(osFamily('macOS-15.6.1-arm64-arm-64bit')).toBe('macOS 15.6');
    expect(osFamily('Windows-11-10.0.26100-SP0')).toBe('Windows 11');
    expect(osFamily(null)).toBeNull();
  });

  it('turns a display name into short plain text', () => {
    expect(cleanDisplayName('  ')).toBeNull();
    expect(cleanDisplayName('Mani\u202e\u200b box\n\t2')).toBe('Mani box 2');
    expect(cleanDisplayName('see http://10.0.0.1/x now')).toBe('see <address> now');
    expect(cleanDisplayName('x'.repeat(100))).toHaveLength(60);
  });

  it('allows https, and http only to this computer', () => {
    expect(checkShareEndpoint('https://results.example.com/api/runs')).toEqual({
      ok: true,
      url: 'https://results.example.com/api/runs',
    });
    expect(checkShareEndpoint('http://127.0.0.1:18888/api/runs').ok).toBe(true);
    expect(checkShareEndpoint('http://localhost/api/runs').ok).toBe(true);
    for (const bad of [
      'http://results.example.com/api/runs',
      'http://192.168.1.5/api/runs',
      'https://me:secret@results.example.com/',
      'https://results.example.com/#top',
      'javascript:alert(1)',
      'results.example.com',
    ]) {
      expect(checkShareEndpoint(bad).ok, bad).toBe(false);
    }
  });
});
