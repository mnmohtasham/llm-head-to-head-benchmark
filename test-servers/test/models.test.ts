import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type RunningMock } from '../src/server';

const KEY = 'sk-unsloth-mockmodels-00000000000000001';
let mock: RunningMock;

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${mock.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
}

const control = (body: unknown) => call('POST', '/__mock/config', body);
const load = (body: Record<string, unknown>) =>
  call('POST', '/api/inference/load', {
    max_seq_length: 0,
    n_parallel: 1,
    speculative_type: 'off',
    ...body,
  });

beforeAll(async () => {
  mock = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(async () => {
  await call('POST', '/__mock/reset');
  await control({ loadMs: 150 });
});

describe('model inventory', () => {
  it('lists what is on disk, with partial downloads flagged', async () => {
    const { body } = await call('GET', '/api/models/local');
    const rows = body.models as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.id === 'unsloth/gemma-4-12B-it-qat-GGUF')?.partial).toBe(true);
    expect(rows.map((r) => r.id)).toContain('unsloth/gemma-4-12b-it-GGUF');
  });

  it('answers the offline quant listing like Unsloth, including its 404', async () => {
    const ok = await call(
      'GET',
      '/api/models/gguf-variants?repo_id=unsloth/Qwen3.8-8B-GGUF&offline=true',
    );
    const variants = ok.body.variants as Array<Record<string, unknown>>;
    expect(variants.map((v) => [v.quant, v.downloaded, v.partial])).toEqual([
      ['Q4_K_M', true, false],
      ['Q8_0', false, true],
    ]);
    const missing = await call(
      'GET',
      '/api/models/gguf-variants?repo_id=nobody/Nothing-GGUF&offline=true',
    );
    expect(missing).toMatchObject({
      status: 404,
      body: { detail: 'No cached GGUF variants available while offline.' },
    });
  });
});

describe('the load cycle', () => {
  it('reports progress while loading, then the new model and its settings', async () => {
    await control({ loadMs: 400 });
    const pending = load({
      model_path: 'unsloth/gemma-4-12b-it-GGUF',
      gguf_variant: 'q4_k_m',
      max_seq_length: 8192,
      load_request_id: 'r1',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const progress = await call('GET', '/api/inference/load-progress');
    expect(progress.body.phase).toBe('mmap');
    expect(progress.body.fraction).toBeGreaterThan(0);
    const during = await call('GET', '/api/inference/status');
    expect(during.body).toMatchObject({
      active_model: null,
      loading: ['unsloth/gemma-4-12b-it-GGUF'],
    });

    const done = await pending;
    expect(done).toMatchObject({
      status: 200,
      body: { status: 'loaded', model: 'unsloth/gemma-4-12b-it-GGUF' },
    });
    const after = await call('GET', '/api/inference/status');
    expect(after.body).toMatchObject({
      active_model: 'unsloth/gemma-4-12b-it-GGUF',
      gguf_variant: 'Q4_K_M',
      context_length: 8192,
      speculative_type: 'off',
      parallel_slots: 1,
      loading: [],
    });
    expect((await call('GET', '/api/inference/load-progress')).body.phase).toBeNull();
  });

  it('answers already_loaded for the same model and settings', async () => {
    const same = {
      model_path: 'unsloth/Qwen3.8-27B-GGUF',
      gguf_variant: 'Q4_K_M',
      max_seq_length: 32768,
      cache_type_kv: 'f16',
      reasoning_budget: -1,
    };
    expect((await load(same)).body.status).toBe('already_loaded');
  });

  it('refuses unknown models, quants that are not on disk, image models and a busy GPU', async () => {
    expect((await load({ model_path: 'nobody/x' })).body).toEqual({
      detail: 'Invalid model identifier: nobody/x',
    });
    expect(
      (await load({ model_path: 'unsloth/Qwen3.8-8B-GGUF', gguf_variant: 'Q8_0' })).status,
    ).toBe(400);
    expect(
      (await load({ model_path: 'unsloth/Qwen-Image-2.1-GGUF', gguf_variant: 'Q4_K_M' })).status,
    ).toBe(400);
    await control({ gpuBusy: true });
    const busy = await load({ model_path: 'unsloth/gemma-4-12b-it-GGUF', gguf_variant: 'Q4_K_M' });
    expect(busy).toMatchObject({ status: 409, body: { detail: { error: 'gpu_busy' } } });
  });

  it('fails a load on demand and cancels one by its request id', async () => {
    await control({ failNextLoad: 'Failed to load GGUF model: gemma-4-12b-it-GGUF' });
    const failed = await load({
      model_path: 'unsloth/gemma-4-12b-it-GGUF',
      gguf_variant: 'Q4_K_M',
    });
    expect(failed).toMatchObject({
      status: 500,
      body: { detail: 'Failed to load GGUF model: gemma-4-12b-it-GGUF' },
    });

    await control({ loadMs: 2000 });
    const pending = load({
      model_path: 'unsloth/gemma-4-12b-it-GGUF',
      gguf_variant: 'Q4_K_M',
      load_request_id: 'r2',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await call('POST', '/api/inference/unload', {
      model_path: 'unsloth/gemma-4-12b-it-GGUF',
      cancel_load_request_id: 'r2',
    });
    expect(await pending).toMatchObject({ status: 409, body: { detail: 'Model load cancelled' } });
  });

  it('pads a slow load and reports a late failure in the body, like Unsloth', async () => {
    await control({ loadMs: 400, padAfterMs: 100, padEveryMs: 40 });
    const slow = await load({ model_path: 'unsloth/gemma-4-12b-it-GGUF', gguf_variant: 'Q4_K_M' });
    expect(slow.status).toBe(200);
    expect(slow.raw).toMatch(/^ +\{/);
    expect(slow.body.status).toBe('loaded');

    await control({ failNextLoad: 'Failed late', loadMs: 600 });
    const late = await load({ model_path: 'unsloth/Qwen3.8-8B-GGUF', gguf_variant: 'Q4_K_M' });
    expect(late.status).toBe(200);
    expect(late.body).toEqual({ _deferred_error: { status_code: 500, detail: 'Failed late' } });
  });

  it('unloads the model', async () => {
    const result = await call('POST', '/api/inference/unload', {
      model_path: 'unsloth/Qwen3.8-27B-GGUF',
    });
    expect(result.body).toEqual({ status: 'unloaded', model: 'unsloth/Qwen3.8-27B-GGUF' });
    expect((await call('GET', '/api/inference/status')).body).toMatchObject({
      active_model: null,
      loaded: [],
    });
  });
});
