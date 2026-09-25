import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildResult,
  canonicalJson,
  METRICS,
  redactDeep,
  redactText,
  resultJsonSchema,
  resultSchema,
  type StoredSession,
} from '../src';
import { makeRun, makeSession, makeStatus } from './make';

const generator = { version: '1.3.0', build: 'build-1' };

function session(): StoredSession {
  const s = makeSession(
    ['aaaa', 'bbbb'],
    [
      [makeRun('aaaa', { decodeTokPerSec: 50 }), makeRun('bbbb', { decodeTokPerSec: 20 })],
      [makeRun('aaaa', { decodeTokPerSec: 52 }), makeRun('bbbb', { decodeTokPerSec: 21 })],
    ],
  ) as unknown as StoredSession;
  s.machines = s.machines.map((m) => ({
    ...m,
    baseUrl: 'http://192.168.99.150:8888',
    notes: 'desk',
  }));
  s.provenance = s.machines.map((m) => ({
    machineId: m.id,
    probedAt: null,
    versions: { unsloth: '2026.9.2', studio: '0.1.815-beta', llamaCpp: 'b11139' },
    platform: { os: 'Linux', backend: 'cuda', memoryTotalGb: 30 },
    gpus: [{ name: 'NVIDIA GeForce RTX 3060', memoryGb: 12 }],
    statusBefore: makeStatus({ modelIdentifier: '/home/mani/models/qwen.gguf' }),
    statusAfter: null,
    request: { model: 'qwen', messages: [{ role: 'user', content: 'Hi' }] },
    sttBefore: null,
    sttAfter: null,
    imageBefore: null,
    imageAfter: null,
    restore: null,
    agent: null,
  }));
  const run = s.rounds[0]?.runs[1];
  if (run) {
    run.state = 'failed';
    run.error =
      'Nothing is listening at http://192.168.99.150:8888 (connect ECONNREFUSED 192.168.99.150:8888).';
  }
  return s;
}

describe('the result file', () => {
  it('follows its own schema, with a metric for every run and indexes for machines', () => {
    const result = buildResult(session(), generator);
    const parsed = resultSchema.safeParse({ ...result, sha256: 'a'.repeat(64) });
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    expect(result).toMatchObject({
      format: 'model-duel-result',
      formatVersion: 1,
      kind: 'text',
      generator: { app: 'Model Duel', version: '1.3.0', build: 'build-1', sessionSchemaVersion: 9 },
    });
    expect(result.metricDefinitions.map((m) => m.key)).toEqual(METRICS.map((m) => m.key));
    expect(result.rounds[1]?.runs.map((r) => [r.machine, r.metrics.decode])).toEqual([
      [0, 52],
      [1, 21],
    ]);
    expect(result.rounds[0]?.order).toEqual([0, 1]);
    const decode = result.summary.stats.find((s) => s.key === 'decode');
    // The failed run of round 1 does not count.
    expect(decode?.machines.map((m) => m.median)).toEqual([51, 21]);
    expect(result.machines[0]).toMatchObject({
      index: 0,
      label: 'aaaa',
      hardware: { gpus: [{ name: 'NVIDIA GeForce RTX 3060', memoryGb: 12 }] },
      software: { studio: '0.1.815-beta' },
    });
  });

  it('leaves out addresses, notes and home folders, but keeps prompts and answers', () => {
    const result = buildResult(session(), generator);
    const text = JSON.stringify(result);
    expect(text).not.toContain('192.168.99.150');
    expect(text).not.toContain('desk');
    expect(text).not.toContain('/home/mani');
    expect(result.machines[0]?.state.textBefore?.modelIdentifier).toBe('~/models/qwen.gguf');
    expect(result.rounds[0]?.runs[1]?.error).toBe(
      'Nothing is listening at <address> (connect ECONNREFUSED <address>).',
    );
    expect(result.machines[0]?.setup.map((row) => row.key)).not.toContain('address');
    expect(result.settings.config.prompt).toBe('Hi');
  });

  it('redacts paths and addresses in messages', () => {
    expect(redactText('open /Users/ann/clips/a.mp4 failed')).toBe('open ~/clips/a.mp4 failed');
    expect(redactText('-i /srv/data/clips/ref.mp4 -y /tmp/out.mp4')).toBe(
      '-i <path>/ref.mp4 -y <path>/out.mp4',
    );
    expect(redactText('see https://abc.trycloudflare.com/v1 and [fe80::1]:8888')).toBe(
      'see <address> and <address>',
    );
    expect(redactText('C:\\Users\\Ann\\models\\x.gguf')).toBe('~\\models\\x.gguf');
    expect(redactDeep({ a: ['10.0.0.2:8888'], b: 3 })).toEqual({ a: ['<address>'], b: 3 });
  });

  it('writes canonical JSON: sorted keys, the same text for the same content', () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }], e: undefined })).toBe(
      '{"a":[{"c":"x","d":null}],"b":1}',
    );
    const one = buildResult(session(), generator);
    const two = buildResult(session(), generator);
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it('matches the JSON Schema in docs, which npm run result-schema writes', async () => {
    const committed = JSON.parse(
      await readFile(new URL('../../docs/result-format.schema.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(committed).toEqual(resultJsonSchema());
  });
});
