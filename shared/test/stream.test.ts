import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeClientMetrics,
  findMonitorRow,
  gapStats,
  interpretMessage,
  nextThinkingState,
  thinkingMissing,
  type ChatEvent,
  type ClientMetrics,
  type MonitorRow,
  type RunTimeline,
  type ThinkingState,
  type TimedEvent,
  type Timings,
} from '../src/chat';
import { SseParser, type SseMessage } from '../src/sse';

const encoder = new TextEncoder();

/** A stream in Unsloth's exact wire format, with thinking, multibyte text and a keep-alive. */
const UNSLOTH_STREAM = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
  '',
  ': keep-alive',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"","reasoning_content":"Let me think about café 🙂"}}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"","reasoning_content":" and naïve 日本語."}}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"The answer is déjà vu"}}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" 🚀."}}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21,"prompt_tokens_details":{"cached_tokens":0}},"timings":{"prompt_n":12,"prompt_ms":40.5,"prompt_per_second":296.3,"predicted_n":9,"predicted_ms":300,"predicted_per_second":30,"cache_n":0}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

function parse(bytes: Uint8Array, cuts: readonly number[]): SseMessage[] {
  const parser = new SseParser();
  const out: SseMessage[] = [];
  let start = 0;
  cuts.forEach((cut, index) => {
    out.push(...parser.push(bytes.slice(start, cut), index));
    start = cut;
  });
  out.push(...parser.push(bytes.slice(start), cuts.length));
  out.push(...parser.end(cuts.length + 1));
  return out;
}

const shape = (messages: SseMessage[]) =>
  messages.map((m) => (m.kind === 'data' ? `data:${m.data}` : `comment:${m.text}`));

/** Every split offset for short streams; for long ones, a sample plus every offset inside a multibyte character. */
function offsets(bytes: Uint8Array): number[] {
  const all = Array.from({ length: bytes.length - 1 }, (_, i) => i + 1);
  if (bytes.length <= 6000) return all;
  const step = Math.ceil(bytes.length / 1500);
  return all.filter((i) => i % step === 0 || ((bytes[i] ?? 0) & 0xc0) === 0x80);
}

interface StreamFixture {
  reads: Array<{ t: number; b64: string }>;
}

function recordedStreams(): Array<[string, Uint8Array]> {
  const dir = new URL('../../fixtures/streams/', import.meta.url);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const fixture = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as StreamFixture;
      const parts = fixture.reads.map((r) => Buffer.from(r.b64, 'base64'));
      return [name, new Uint8Array(Buffer.concat(parts))];
    });
}

describe('SseParser', () => {
  const bytes = encoder.encode(UNSLOTH_STREAM);
  const whole = parse(bytes, []);

  it('reads the Unsloth stream as data events and one keep-alive comment', () => {
    expect(whole.filter((m) => m.kind === 'data')).toHaveLength(8);
    expect(
      whole.filter((m) => m.kind === 'comment').map((m) => (m.kind === 'comment' ? m.text : '')),
    ).toEqual(['keep-alive']);
  });

  it('gives the same events however the bytes are split, even inside multibyte characters', () => {
    const expected = shape(whole);
    for (const cut of offsets(bytes)) expect(shape(parse(bytes, [cut]))).toEqual(expected);
    // and one byte at a time
    expect(
      shape(
        parse(
          bytes,
          Array.from({ length: bytes.length - 1 }, (_, i) => i + 1),
        ),
      ),
    ).toEqual(expected);
  });

  it('gives the same events for every recorded stream split anywhere', () => {
    for (const [name, recorded] of recordedStreams()) {
      const expected = shape(parse(recorded, []));
      expect(expected.length, name).toBeGreaterThan(0);
      for (const cut of offsets(recorded))
        expect(shape(parse(recorded, [cut])), `${name} @${cut}`).toEqual(expected);
    }
  });

  it('stamps each event with the read that completed it', () => {
    const parser = new SseParser();
    expect(parser.push(encoder.encode('data: {"a"'), 10)).toEqual([]);
    expect(parser.push(encoder.encode(':1}\n\ndata: x\n\n'), 25)).toEqual([
      { kind: 'data', data: '{"a":1}', t: 25, read: 1 },
      { kind: 'data', data: 'x', t: 25, read: 1 },
    ]);
  });

  it('handles CRLF, lone CR split across reads, multi-line data and other fields', () => {
    expect(shape(parse(encoder.encode('data: a\r\ndata: b\r\n\r\n'), []))).toEqual(['data:a\nb']);
    expect(shape(parse(encoder.encode('data: a\r\rdata: c\n\n'), [8]))).toEqual([
      'data:a',
      'data:c',
    ]);
    expect(shape(parse(encoder.encode('event: x\nid: 1\nretry: 5\ndata:y\n\n'), []))).toEqual([
      'data:y',
    ]);
    expect(shape(parse(encoder.encode('data:\n\n'), []))).toEqual(['data:']);
  });

  it('drops an event the stream cut off before its blank line', () => {
    expect(shape(parse(encoder.encode('data: done\n\ndata: half'), []))).toEqual(['data:done']);
  });
});

describe('interpretMessage', () => {
  const data = (value: unknown) =>
    interpretMessage({ kind: 'data', data: JSON.stringify(value), t: 0, read: 0 });

  it('reads thinking, answer, finish and usage', () => {
    expect(data({ choices: [{ delta: { content: '', reasoning_content: 'hm' } }] })).toEqual([
      { type: 'reasoning', text: 'hm' },
    ]);
    expect(data({ choices: [{ delta: { reasoning: 'alias' } }] })).toEqual([
      { type: 'reasoning', text: 'alias' },
    ]);
    expect(data({ choices: [{ delta: { content: 'hi' }, finish_reason: 'length' }] })).toEqual([
      { type: 'content', text: 'hi' },
      { type: 'finish', reason: 'length' },
    ]);
    const [usage] = data({
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
      timings: { predicted_per_second: 41.5 },
    });
    expect(usage).toMatchObject({
      type: 'usage',
      usage: { promptTokens: 5, completionTokens: 7, cachedTokens: null },
      timings: { predictedPerSecond: 41.5 },
    });
  });

  it('recognises the end, keep-alives, errors, truncation and UI frames', () => {
    expect(interpretMessage({ kind: 'data', data: '[DONE]', t: 0, read: 0 })).toEqual([
      { type: 'done' },
    ]);
    expect(interpretMessage({ kind: 'comment', text: 'keep-alive', t: 0, read: 0 })).toEqual([
      { type: 'keepalive' },
    ]);
    expect(
      data({
        error: {
          message: 'Context too long',
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }),
    ).toEqual([{ type: 'error', message: 'Context too long', code: 'context_length_exceeded' }]);
    expect(data({ choices: [], context_truncated: { dropped: 3 } })).toEqual([
      { type: 'truncated', info: { dropped: 3 } },
    ]);
    expect(data({ type: 'tool_start', name: 'web_search' })).toEqual([
      { type: 'ignored', why: 'tool_start' },
    ]);
    expect(data({ choices: [{ delta: { role: 'assistant' } }] })).toEqual([
      { type: 'ignored', why: 'no output' },
    ]);
    expect(interpretMessage({ kind: 'data', data: 'not json', t: 0, read: 0 })).toEqual([
      { type: 'ignored', why: 'not JSON' },
    ]);
  });
});

describe('computeClientMetrics', () => {
  const at = (t: number, read: number, event: ChatEvent): TimedEvent => ({ t, read, event });
  const timeline: RunTimeline = {
    requestAt: 1000,
    headersAt: 1005,
    endAt: 2800,
    events: [
      at(1010, 0, { type: 'keepalive' }),
      at(1300, 1, { type: 'reasoning', text: 'ab' }),
      at(1320, 2, { type: 'reasoning', text: 'cd' }),
      at(1700, 3, { type: 'content', text: 'é🙂' }),
      at(1700, 3, { type: 'content', text: 'x' }),
      at(1800, 4, { type: 'content', text: 'yz' }),
      at(1800, 4, { type: 'finish', reason: 'stop' }),
      at(1801, 4, {
        type: 'usage',
        usage: { promptTokens: 20, completionTokens: 11, cachedTokens: 0 },
        timings: null,
      }),
      at(1802, 5, { type: 'done' }),
    ],
  };

  it('measures every waiting time from the request', () => {
    expect(computeClientMetrics(timeline)).toMatchObject({
      ttfbMs: 5,
      ttftMs: 300,
      firstReasoningMs: 300,
      firstAnswerMs: 700,
      thinkingMs: 400,
      totalMs: 802,
      decodeMs: 500,
      promptTokens: 20,
      outputTokens: 11,
      finishReason: 'stop',
      keepalives: 1,
      sawDone: true,
      tokensEstimated: false,
    });
  });

  it('computes rates from usage, and characters as people count them', () => {
    const m = computeClientMetrics(timeline);
    expect(m.decodeTokPerSec).toBeCloseTo(20); // (11 - 1) tokens over 0.5 s
    expect(m.endToEndTokPerSec).toBeCloseTo(11 / 0.802);
    expect(m.reasoningChars).toBe(4);
    expect(m.answerChars).toBe(5); // é, 🙂, x, y, z
    expect(m.charsPerSec).toBeCloseTo(18);
  });

  it('reports gaps between chunks and counts chunks that shared a read', () => {
    const m = computeClientMetrics(timeline);
    expect(m.chunks).toBe(5);
    expect(m.coalescedChunks).toBe(1);
    expect(m.interChunk).toEqual({ meanMs: 125, medianMs: 60, p95Ms: 380, maxMs: 380 });
  });

  it('falls back to the chunk count and says so when there is no usage', () => {
    const noUsage = {
      ...timeline,
      events: timeline.events.filter((e) => e.event.type !== 'usage'),
    };
    const m = computeClientMetrics(noUsage);
    expect(m.outputTokens).toBeNull();
    expect(m.tokensEstimated).toBe(true);
    expect(m.decodeTokPerSec).toBeCloseTo(8); // (5 chunks - 1) over 0.5 s
  });

  it('handles a run that produced nothing', () => {
    const empty = computeClientMetrics({ requestAt: 0, headersAt: null, endAt: 50, events: [] });
    expect(empty).toMatchObject({
      ttftMs: null,
      decodeTokPerSec: null,
      interChunk: null,
      totalMs: 50,
      sawDone: false,
    });
  });

  it('summarises gaps', () => {
    expect(gapStats([])).toBeNull();
    expect(gapStats([10, 30])).toEqual({ meanMs: 20, medianMs: 20, p95Ms: 30, maxMs: 30 });
  });
});

describe('the thinking block', () => {
  it('opens on the first thinking token and folds at the first answer token', () => {
    const steps: ChatEvent[] = [
      { type: 'keepalive' },
      { type: 'reasoning', text: 'a' },
      { type: 'reasoning', text: 'b' },
      { type: 'content', text: 'c' },
      { type: 'reasoning', text: 'late' },
    ];
    const states: ThinkingState[] = [];
    let state: ThinkingState = 'waiting';
    for (const step of steps) {
      state = nextThinkingState(state, step);
      states.push(state);
    }
    expect(states).toEqual(['waiting', 'thinking', 'thinking', 'answering', 'answering']);
    expect(nextThinkingState('waiting', { type: 'content', text: 'x' })).toBe('answering');
  });
});

describe('findMonitorRow', () => {
  const entry = (over: Record<string, unknown>) => ({
    endpoint: '/v1/chat/completions',
    prompt_preview: 'user: Why is the sky blue?',
    started_at: 100,
    finished_at: 110,
    status: 'done',
    ttft_ms: 250,
    tok_per_sec: 41.2,
    prompt_tok_per_sec: 900,
    duration_ms: 5000,
    decode_ms: 4700,
    prompt_tokens: 14,
    completion_tokens: 200,
    stop_reason: 'stop',
    ...over,
  });

  it('picks the newest matching chat completion near the monitor clock', () => {
    const body = {
      server_time: 115,
      entries: [
        entry({ started_at: 50, finished_at: 60, ttft_ms: 999 }),
        entry({ started_at: 100, finished_at: 110 }),
        entry({ prompt_preview: 'user: something else', started_at: 105 }),
        entry({ endpoint: '/v1/audio/transcriptions', started_at: 106 }),
      ],
    };
    expect(findMonitorRow(body, 'Why is the sky blue?')).toMatchObject({
      ttftMs: 250,
      tokPerSec: 41.2,
      stopReason: 'stop',
    });
  });

  it('ignores rows that finished long before the run', () => {
    const body = { server_time: 1000, entries: [entry({ finished_at: 100 })] };
    expect(findMonitorRow(body, 'Why is the sky blue?')).toBeNull();
    expect(findMonitorRow(null, 'x')).toBeNull();
  });
});

interface Recording {
  request: { enable_thinking?: boolean };
  headersAtMs: number | null;
  endAtMs: number;
  reads: Array<{ t: number; b64: string }>;
  metrics: ClientMetrics;
  server: { timings: Timings | null; monitor: MonitorRow | null };
}

function recordings(): Array<[string, Recording]> {
  const dir = new URL('../../fixtures/streams/', import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => [name, JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as Recording]);
}

/** Feeds a recording through the parser at its original read times, as the controller does. */
function replay(recording: Recording): ClientMetrics {
  return computeClientMetrics(replayTimeline(recording));
}

function finalTimings(recording: Recording): Timings | null {
  const usage = replayTimeline(recording).events.findLast((e) => e.event.type === 'usage')?.event;
  return usage?.type === 'usage' ? usage.timings : null;
}

function replayTimeline(recording: Recording): RunTimeline {
  const parser = new SseParser();
  const events: TimedEvent[] = [];
  const take = (messages: SseMessage[]) => {
    for (const message of messages)
      for (const event of interpretMessage(message))
        events.push({ t: message.t, read: message.read, event });
  };
  for (const read of recording.reads) take(parser.push(Buffer.from(read.b64, 'base64'), read.t));
  take(parser.end(recording.endAtMs));
  return { requestAt: 0, headersAt: recording.headersAtMs, endAt: recording.endAtMs, events };
}

describe('recorded streams', () => {
  const all = recordings();

  it('include one stream from each real machine', () => {
    const names = all.map(([name]) => name);
    expect(names).toContain('linux-rtx3060-thinking.json');
    expect(names).toContain('linux-radeon780m-thinking.json');
  });

  it('replay to the metrics measured when they were recorded', () => {
    for (const [name, recording] of all) {
      const metrics = replay(recording);
      const saved = recording.metrics;
      expect(metrics.ttftMs, name).toBeCloseTo(saved.ttftMs ?? Number.NaN, 1);
      expect(metrics.firstAnswerMs ?? -1, name).toBeCloseTo(saved.firstAnswerMs ?? -1, 1);
      expect(metrics.decodeTokPerSec, name).toBeCloseTo(saved.decodeTokPerSec ?? Number.NaN, 2);
      expect(metrics.outputTokens, name).toBe(saved.outputTokens);
      expect(metrics.chunks, name).toBe(saved.chunks);
      expect(metrics.coalescedChunks, name).toBe(saved.coalescedChunks);
      expect(metrics.sawDone, name).toBe(true);
    }
  });

  it('agree with what Unsloth measured on the machine', () => {
    for (const [name, recording] of all) {
      const metrics = replay(recording);
      const { timings, monitor } = recording.server;
      const serverDecode = timings?.predictedPerSecond ?? null;
      expect(serverDecode, name).not.toBeNull();
      const gap =
        Math.abs((metrics.decodeTokPerSec ?? 0) - (serverDecode ?? 0)) / (serverDecode ?? 1);
      expect(gap, `${name} decode gap`).toBeLessThan(0.1);
      expect(monitor, name).not.toBeNull();
      // The first token cannot reach this computer before Unsloth produced it.
      expect(metrics.ttftMs ?? 0, name).toBeGreaterThanOrEqual((monitor?.ttftMs ?? 0) - 1);
    }
  });

  it('carry the prompt cache and speculative decoding counts Unsloth reports', () => {
    const byName = new Map(all);
    const lenovo = byName.get('linux-radeon780m-thinking.json');
    const rtx = byName.get('linux-rtx3060-thinking.json');
    if (!lenovo || !rtx) throw new Error('real recordings missing');
    expect(finalTimings(lenovo)).toMatchObject({ draftN: 336, draftAccepted: 202, cacheN: 30 });
    expect(finalTimings(rtx)).toMatchObject({ draftN: 64, draftAccepted: 0, cacheN: 58 });
    for (const [name, recording] of all) {
      const timings = finalTimings(recording);
      // llama-server counts the cached prompt tokens apart from the ones it processed.
      expect((timings?.promptN ?? 0) + (timings?.cacheN ?? 0), name).toBe(
        replay(recording).promptTokens,
      );
    }
  });

  it('keep thinking apart from the answer, and flag the run where the model skipped it', () => {
    for (const [name, recording] of all) {
      const metrics = replay(recording);
      const requested = recording.request.enable_thinking !== false;
      const skipped = name.includes('thinking-in-answer');
      expect(thinkingMissing(requested, metrics), name).toBe(skipped);
      if (requested && !skipped) {
        expect(metrics.reasoningChars, name).toBeGreaterThan(0);
        expect(metrics.firstReasoningMs ?? Infinity, name).toBeLessThan(
          metrics.firstAnswerMs ?? -Infinity,
        );
      }
    }
  });
});
