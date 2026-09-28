import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type RunningMock } from '../src/server';
import { parseMultipart } from '../src/stt';

// Unsloth's answers are loosely shaped; the tests read them by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const KEY = 'sk-unsloth-stttest-0000000000000000001';
let mock: RunningMock;
const auth = { authorization: `Bearer ${KEY}` };

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${mock.url}${path}`, {
    method,
    headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

/** One second of 16 kHz mono silence per second asked for. */
function wav(seconds: number): Uint8Array {
  const data = 16_000 * 2 * seconds;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) =>
    [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, data, true);
  return out;
}

async function transcribe(audio: Uint8Array, fields: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'a.wav');
  const response = await fetch(`${mock.url}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: auth,
    body: form,
  });
  return { status: response.status, body: (await response.json()) as Json };
}

beforeAll(async () => {
  mock = await startMockServer({ profile: 'mac-mlx', apiKey: KEY });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(async () => {
  await call('POST', '/__mock/reset');
  await call('POST', '/__mock/config', { stt: { loadMs: 20, msPerAudioSecond: 5 } });
});

describe('the fake speech-to-text', () => {
  it('reads multipart bodies from browsers and from Model Duel', () => {
    const body = Buffer.from(
      '--xyz\r\nContent-Disposition: form-data; name="model"\r\n\r\nsmall\r\n' +
        '--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n\r\nRIFF\r\n--xyz--\r\n',
    );
    const parts = parseMultipart(body, 'multipart/form-data; boundary=xyz');
    expect(parts?.map((p) => [p.name, p.filename, p.data.toString()])).toEqual([
      ['model', null, 'small'],
      ['file', 'a.wav', '\r\nRIFF'],
    ]);
  });

  it('falls back from GGUF to transformers on a Mac, and refuses to download', async () => {
    const status = await call('GET', '/api/inference/audio/stt/status');
    expect(status.body.gguf.available).toBe(false);
    expect(status.body.mtmd.models).toEqual(['qwen3-asr-0.6b', 'qwen3-asr-1.7b']);
    const loaded = await call('POST', '/api/inference/audio/stt/load', {
      model: 'small',
      engine: 'gguf',
    });
    expect(loaded.body).toMatchObject({ status: 'loaded', engine: 'transformers' });
    const after = await call('GET', '/api/inference/audio/stt/status');
    expect(after.body.transformers.loaded_model).toBe('small');
    expect(after.body.loaded_model).toBe('small');
    const tiny = await call('POST', '/api/inference/audio/stt/load', { model: 'tiny' });
    expect(tiny.status).toBe(409);
  });

  it('transcribes, logs a monitor row that DELETE clears, and unloads when idle', async () => {
    const answer = await transcribe(wav(2), {
      model: 'small',
      language: 'en',
      response_format: 'verbose_json',
    });
    expect(answer.body).toMatchObject({ task: 'transcribe', language: 'en', duration: 2 });
    expect(answer.body.text).toMatch(/^The quick brown fox/);
    const monitor = await call('GET', '/api/inference/monitor');
    expect(monitor.body.entries[0]).toMatchObject({
      endpoint: '/v1/audio/transcriptions',
      status: 'done',
    });
    expect(monitor.body.entries[0].duration_ms).toBeGreaterThanOrEqual(9);
    expect((await call('DELETE', '/api/inference/monitor')).body).toEqual({ cleared: 1 });
    expect((await call('GET', '/api/inference/monitor')).body.entries).toEqual([]);

    await call('POST', '/__mock/config', { stt: { idleUnloadMs: 50 } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const idle = await call('GET', '/api/inference/audio/stt/status');
    expect(idle.body.loaded_model).toBeNull();
  });
});
