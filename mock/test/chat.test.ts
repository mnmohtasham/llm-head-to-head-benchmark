import { interpretMessage, SseParser, type ChatEvent } from '@duel/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type RunningMock } from '../src/server';

const KEY = 'sk-unsloth-mockchat-000000000000000001';
let mock: RunningMock;

async function control(body: unknown) {
  await fetch(`${mock.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface Streamed {
  status: number;
  headers: Headers;
  events: ChatEvent[];
  comments: number;
}

async function chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Streamed> {
  const response = await fetch(`${mock.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'x',
      messages: [{ role: 'user', content: 'Why is the sky blue?' }],
      stream: true,
      stream_options: { include_usage: true },
      ...body,
    }),
    signal,
  });
  const parser = new SseParser();
  const events: ChatEvent[] = [];
  let comments = 0;
  const take = (messages: ReturnType<SseParser['push']>) => {
    for (const message of messages) {
      if (message.kind === 'comment') comments += 1;
      events.push(...interpretMessage(message));
    }
  };
  if (response.body && response.headers.get('content-type')?.includes('event-stream')) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        take(parser.push(value, performance.now()));
      }
    } catch {
      // the connection was cut
    }
    take(parser.end(performance.now()));
  } else {
    events.push({ type: 'error', message: await response.text(), code: null });
  }
  return { status: response.status, headers: response.headers, events, comments };
}

const kinds = (events: ChatEvent[]) => [...new Set(events.map((e) => e.type))];

beforeAll(async () => {
  mock = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(async () => {
  await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  await control({
    latencyMs: 0,
    stream: { startupMs: 30, tokenMs: 2, jitterMs: 0, reasoningTokens: 5, answerTokens: 8 },
  });
});

describe('streaming like Unsloth', () => {
  it('sends thinking, then the answer, the finish, usage with timings, and [DONE]', async () => {
    const { status, headers, events } = await chat({});
    expect(status).toBe(200);
    expect(headers.get('connection')).toBe('close');
    expect(kinds(events)).toEqual(['ignored', 'reasoning', 'content', 'finish', 'usage', 'done']);
    expect(events.filter((e) => e.type === 'reasoning')).toHaveLength(5);
    expect(events.filter((e) => e.type === 'content')).toHaveLength(8);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { completionTokens: 13 }, timings: { predictedN: 13 } });
  });

  it('leaves out thinking when it is off, and usage when it was not asked for', async () => {
    const { events } = await chat({ enable_thinking: false, stream_options: undefined });
    expect(kinds(events)).toEqual(['ignored', 'content', 'finish', 'done']);
  });

  it('stops on max_tokens with finish reason length', async () => {
    const { events } = await chat({ max_tokens: 3 });
    expect(events.find((e) => e.type === 'finish')).toEqual({ type: 'finish', reason: 'length' });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { completionTokens: 3 },
    });
  });

  it('refuses to chat with no model loaded, in the OpenAI error shape', async () => {
    await fetch(`${mock.url}/api/inference/unload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model_path: 'unsloth/Qwen3.8-27B-GGUF' }),
    });
    const { status, events } = await chat({});
    expect(status).toBe(400);
    expect(events[0]).toMatchObject({
      type: 'error',
      message: expect.stringContaining('No model loaded'),
    });
  });

  it('sends keep-alive comments while the prompt is processed', async () => {
    await control({ stream: { startupMs: 120, keepaliveEveryMs: 25 } });
    const { comments, events } = await chat({});
    expect(comments).toBeGreaterThanOrEqual(3);
    expect(events.filter((e) => e.type === 'keepalive').length).toBe(comments);
  });

  it('can send the thinking as answer text, like a model that skipped its thinking block', async () => {
    await control({ stream: { thinkingInAnswer: true } });
    const { events } = await chat({});
    expect(kinds(events)).toEqual(['ignored', 'content', 'finish', 'usage', 'done']);
    expect(events.filter((e) => e.type === 'content')).toHaveLength(13);
  });

  it('reports cached prompt tokens and speculative drafts when told to', async () => {
    await control({ stream: { cachedPromptTokens: 3, draftAcceptRate: 0.5 } });
    const { events } = await chat({});
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({
      usage: { cachedTokens: 3 },
      timings: { cacheN: 3, draftN: 13, draftAccepted: 7 },
    });
    if (usage?.type !== 'usage') throw new Error('no usage');
    expect((usage.timings?.promptN ?? 0) + 3).toBe(usage.usage?.promptTokens);
  });

  it('ends with an in-band error frame when told to', async () => {
    await control({ stream: { errorAfterTokens: 2 } });
    const { events } = await chat({});
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      code: 'context_length_exceeded',
    });
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});

describe('prompt caching and token counts', () => {
  const usageOf = (events: ChatEvent[]) => {
    const usage = events.find((e) => e.type === 'usage');
    return usage?.type === 'usage' ? usage : null;
  };
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');

  it('counts tokens the way the chat route does', async () => {
    const response = await fetch(`${mock.url}/v1/chat/count_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'one two three' }] }),
    });
    expect(await response.json()).toMatchObject({ input_tokens: 7 });
  });

  it('reuses a cached prompt start, except for seeded requests on llama.cpp', async () => {
    const messages = [{ role: 'user', content: long }];
    await chat({ messages });
    expect(usageOf((await chat({ messages })).events)?.usage?.cachedTokens).toBe(200);
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    await chat({ messages, seed: 42 });
    expect(usageOf((await chat({ messages, seed: 42 })).events)?.usage?.cachedTokens).toBe(0);
  });

  it('keeps the cache for seeded requests on MLX, as Unsloth does', async () => {
    const mlxKey = 'sk-unsloth-mockchat-mlx-0000000000000002';
    const mlx = await startMockServer({ profile: 'mac-mlx', apiKey: mlxKey });
    try {
      await fetch(`${mlx.url}/__mock/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ latencyMs: 0, stream: { startupMs: 10, tokenMs: 1 } }),
      });
      const send = async () => {
        const response = await fetch(`${mlx.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${mlxKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'x',
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 4,
            seed: 42,
            messages: [{ role: 'user', content: long }],
          }),
        });
        return response.text();
      };
      expect(await send()).toContain('"cached_tokens":0');
      expect(await send()).toContain('"cached_tokens":200');
    } finally {
      await mlx.close();
    }
  });
});

describe('cancelling and the monitor', () => {
  it('stops generating on cancel by id, and records the row as cancelled', async () => {
    await control({ stream: { tokenMs: 30, answerTokens: 200 } });
    const pending = chat({ cancel_id: 'run-1' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cancel = await fetch(`${mock.url}/api/inference/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cancel_id: 'run-1' }),
    });
    expect(await cancel.json()).toEqual({ cancelled: 1 });
    const { events } = await pending;
    expect(events.filter((e) => e.type === 'content').length).toBeLessThan(200);
    const monitor = (await (
      await fetch(`${mock.url}/api/inference/monitor`, {
        headers: { authorization: `Bearer ${KEY}` },
      })
    ).json()) as { entries: Array<Record<string, unknown>> };
    expect(monitor.entries[0]).toMatchObject({
      status: 'cancelled',
      prompt_preview: 'user: Why is the sky blue?',
    });
  });

  it('records the server-side time to first token', async () => {
    await control({ stream: { startupMs: 100 } });
    await chat({});
    const monitor = (await (
      await fetch(`${mock.url}/api/inference/monitor`, {
        headers: { authorization: `Bearer ${KEY}` },
      })
    ).json()) as { server_time: number; entries: Array<Record<string, unknown>> };
    const row = monitor.entries[0];
    expect(row).toMatchObject({
      status: 'done',
      endpoint: '/v1/chat/completions',
      completion_tokens: 13,
      stop_reason: 'stop',
    });
    expect(Number(row?.ttft_ms)).toBeGreaterThanOrEqual(100);
    expect(Number(row?.ttft_ms)).toBeLessThan(150);
    expect(typeof monitor.server_time).toBe('number');
  });
});
