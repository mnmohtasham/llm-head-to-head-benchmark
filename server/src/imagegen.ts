import {
  detailOf,
  imageLoadBody,
  imageModelReady,
  normalizeImageStatus,
  isImageModel,
  type ImageConfig,
  type ImageModelView,
  type ImageStatus,
  type StepSample,
} from '@duel/shared';
import { Agent, request } from 'undici';
import type { StoredMachine } from './store';
import { toNetworkError, UnslothClient } from './unsloth';

const IMAGES = '/api/inference/images';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client for one call; Unsloth's answers on a reused connection stall for about 40 ms. */
const fresh = (machine: StoredMachine) =>
  new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 3000 });

async function once<T>(
  machine: StoredMachine,
  call: (client: UnslothClient) => Promise<T>,
): Promise<T> {
  const client = fresh(machine);
  try {
    return await call(client);
  } finally {
    await client.close();
  }
}

export async function readImageStatus(
  machine: StoredMachine,
): Promise<{ status: ImageStatus | null; error: string | null }> {
  const answer = await once(machine, (c) => c.getJson(`${IMAGES}/status`, { timeoutMs: 10_000 }));
  if (answer.status === 200) return { status: normalizeImageStatus(answer.body), error: null };
  return {
    status: null,
    error:
      answer.status === 404
        ? 'this Unsloth has no image generation'
        : (answer.error?.message ?? `the image status answered HTTP ${answer.status ?? 'nothing'}`),
  };
}

/** Whether the model's files are on disk, so loading it will not start a download. */
export async function imageFilesOnDisk(
  machine: StoredMachine,
  config: Pick<ImageConfig, 'model' | 'ggufFilename'>,
): Promise<{ ok: boolean; detail: string } | null> {
  if (config.ggufFilename) {
    const answer = await once(machine, (c) =>
      c.getJson(`/api/models/gguf-variants?repo_id=${encodeURIComponent(config.model)}`, {
        timeoutMs: 20_000,
      }),
    );
    if (answer.status !== 200) return null;
    const wanted = config.ggufFilename.split('/').pop()?.toLowerCase();
    const variants = ((answer.body as { variants?: unknown[] } | null)?.variants ?? []) as Array<{
      filename?: string;
      downloaded?: boolean;
      partial?: boolean;
    }>;
    const file = variants.find((v) => v.filename?.split('/').pop()?.toLowerCase() === wanted);
    if (!file) {
      return {
        ok: false,
        detail: `${machine.name} has no file ${config.ggufFilename} in ${config.model}.`,
      };
    }
    return file.downloaded === true && file.partial !== true
      ? { ok: true, detail: 'on disk' }
      : {
          ok: false,
          detail: `${config.ggufFilename} is not fully downloaded on ${machine.name}.`,
        };
  }
  const answer = await once(machine, (c) => c.getJson('/api/models/local', { timeoutMs: 20_000 }));
  if (answer.status !== 200) return null;
  const models = ((answer.body as { models?: unknown[] } | null)?.models ?? []) as Array<{
    id?: string;
    model_id?: string;
    partial?: boolean;
  }>;
  const lower = config.model.toLowerCase();
  const entry = models.find(
    (m) => m.id?.toLowerCase() === lower || m.model_id?.toLowerCase() === lower,
  );
  return entry && entry.partial !== true
    ? { ok: true, detail: 'on disk' }
    : { ok: false, detail: `${config.model} is not fully downloaded on ${machine.name}.` };
}

/** Stops an image load in flight, or unloads the image model; answers once it is done. */
export async function unloadImage(machine: StoredMachine): Promise<void> {
  await once(machine, (c) => c.postJson(`${IMAGES}/unload`, {}, { timeoutMs: 60_000 }));
}

/**
 * Loads the image model unless the right one is resident. The load route answers at once and
 * the load runs on, so this follows load-progress until the model is ready or has failed. A load
 * this app started is stopped again when the race is cancelled or the load runs out of time, so it
 * does not finish later and hold the GPU.
 */
export async function ensureImageModel(
  machine: StoredMachine,
  config: ImageConfig,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    pollMs?: number;
    /** Called just before the load is asked for: from then on the chat model is gone. */
    onLoad?: () => void;
    /** Each progress reading: the phase and, while downloading, the share done. */
    onProgress?: (phase: string | null, fraction: number | null) => void;
  },
): Promise<{ loadMs: number | null; error: string | null }> {
  const before = await readImageStatus(machine);
  if (!before.status) return { loadMs: null, error: before.error };
  if (imageModelReady(before.status, config)) return { loadMs: null, error: null };
  options.onLoad?.();
  const started = performance.now();
  const answer = await once(machine, (c) =>
    c.postJson(`${IMAGES}/load`, imageLoadBody(config), { timeoutMs: options.timeoutMs }),
  );
  if (answer.status !== 200) {
    return {
      loadMs: null,
      error:
        detailOf(answer.body) ||
        answer.error?.message ||
        `Loading ${config.model} failed with HTTP ${answer.status ?? 'nothing'}.`,
    };
  }
  const stop = async (error: string) => {
    await unloadImage(machine).catch(() => undefined);
    return { loadMs: null, error };
  };
  const deadline = started + options.timeoutMs;
  // Unsloth reports no phase when nothing is loading and nothing is loaded. Right after a load
  // starts that can be a moment before its thread registers, so only a long silence counts.
  const graceMs = 30_000;
  while (performance.now() < deadline) {
    if (options.signal.aborted) return stop('The load was cancelled.');
    await sleep(options.pollMs ?? 500);
    const progress = await once(machine, (c) =>
      c.getJson(`${IMAGES}/load-progress`, { timeoutMs: 10_000 }),
    );
    if (progress.status !== 200) continue;
    const body = (progress.body ?? {}) as { phase?: unknown; error?: unknown; fraction?: unknown };
    const phase = typeof body.phase === 'string' ? body.phase : null;
    options.onProgress?.(phase, typeof body.fraction === 'number' ? body.fraction : null);
    if (phase === 'error') {
      return {
        loadMs: null,
        error: typeof body.error === 'string' ? body.error : `Loading ${config.model} failed.`,
      };
    }
    if (phase === 'ready' || phase === null) {
      const after = await readImageStatus(machine);
      if (after.status && imageModelReady(after.status, config)) {
        return { loadMs: performance.now() - started, error: null };
      }
      if (phase === null && performance.now() - started > graceMs) {
        return {
          loadMs: null,
          error: `Unsloth stopped reporting the load of ${config.model} without the model in memory.`,
        };
      }
    }
  }
  const limit =
    options.timeoutMs >= 120_000
      ? `${Math.round(options.timeoutMs / 60_000)} minutes`
      : `${Math.round(options.timeoutMs / 1000)} seconds`;
  return stop(
    `${config.model} did not finish loading in ${limit}, so Model Duel stopped the load.`,
  );
}

export interface ImageOutcome {
  requestAt: number;
  endAt: number;
  status: number | null;
  body: unknown;
  error: string | null;
  cancelled: boolean;
  timeline: StepSample[];
  totalSteps: number;
}

/**
 * Generates one image while polling generate-progress about ten times a second on fresh
 * connections. Each reading is placed at the middle of its own request.
 */
export async function generateImage(
  machine: StoredMachine,
  body: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    pollMs: number;
    onStep?: (step: number, total: number) => void;
  },
): Promise<ImageOutcome> {
  const timeline: StepSample[] = [];
  let totalSteps = 0;
  let polling = true;
  const agent = new Agent({ connect: { timeout: 10_000 } });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (machine.apiKey) headers.authorization = `Bearer ${machine.apiKey}`;
  const total = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([options.signal, total]);
  const requestAt = performance.now();
  const poller = (async () => {
    let lastStep = -1;
    while (polling) {
      const sent = performance.now();
      const progress = await once(machine, (c) =>
        c.getJson(`${IMAGES}/generate-progress`, { timeoutMs: 5000 }),
      );
      const received = performance.now();
      const p = (progress.body ?? {}) as {
        active?: unknown;
        step?: unknown;
        total_steps?: unknown;
      };
      if (polling && progress.status === 200 && p.active === true) {
        const step = typeof p.step === 'number' ? p.step : 0;
        const stepsTotal = typeof p.total_steps === 'number' ? p.total_steps : 0;
        // After the last step the engine clears its state while the PNG is saved: 0 of 0.
        if (stepsTotal > 0) {
          totalSteps = Math.max(totalSteps, stepsTotal);
          timeline.push([Math.round(((sent + received) / 2 - requestAt) * 10) / 10, step]);
          if (step !== lastStep) options.onStep?.(step, stepsTotal);
          lastStep = step;
        }
      }
      await sleep(Math.max(0, options.pollMs - (received - sent)));
    }
  })();
  try {
    const response = await request(`${machine.baseUrl}${IMAGES}/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      dispatcher: agent,
      signal,
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
    });
    const text = await response.body.text();
    const endAt = performance.now();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Not JSON: keep the text for the error.
    }
    return {
      requestAt,
      endAt,
      status: response.statusCode,
      body: parsed,
      error: null,
      cancelled: false,
      timeline,
      totalSteps,
    };
  } catch (error) {
    return {
      requestAt,
      endAt: performance.now(),
      status: null,
      body: null,
      error: options.signal.aborted
        ? null
        : total.aborted
          ? 'The image took too long and was stopped.'
          : toNetworkError(error).message,
      cancelled: options.signal.aborted,
      timeline,
      totalSteps,
    };
  } finally {
    polling = false;
    await poller;
    await agent.destroy().catch(() => undefined);
  }
}

/** Stops the generation running on a machine, for a cancelled race. */
export async function cancelImage(machine: StoredMachine): Promise<void> {
  await once(machine, (c) => c.postJson(`${IMAGES}/generate/cancel`, {}, { timeoutMs: 5000 }));
}

/** The PNG of a gallery image. */
export async function fetchGalleryImage(
  machine: StoredMachine,
  id: string,
): Promise<Uint8Array | null> {
  const agent = new Agent({ connect: { timeout: 10_000 } });
  try {
    const response = await request(
      `${machine.baseUrl}${IMAGES}/gallery/${encodeURIComponent(id)}/file`,
      {
        headers: machine.apiKey ? { authorization: `Bearer ${machine.apiKey}` } : {},
        dispatcher: agent,
        signal: AbortSignal.timeout(60_000),
      },
    );
    const bytes = new Uint8Array(await response.body.arrayBuffer());
    return response.statusCode === 200 ? bytes : null;
  } catch {
    return null;
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}

/**
 * The image models on a machine's disk. Unsloth loads non-GGUF image repos only from unsloth/,
 * so other pipelines are left out.
 */
export async function listImageModels(
  machine: StoredMachine,
): Promise<{ models: ImageModelView[] | null; error: string | null }> {
  const local = await once(machine, (c) => c.getJson('/api/models/local', { timeoutMs: 20_000 }));
  if (local.status !== 200) {
    return {
      models: null,
      error: local.error?.message ?? `the model list answered HTTP ${local.status ?? 'nothing'}`,
    };
  }
  const entries = ((local.body as { models?: unknown[] } | null)?.models ?? []) as Array<{
    id?: string;
    model_id?: string;
    display_name?: string;
    partial?: boolean;
    task?: string | null;
    model_format?: string | null;
  }>;
  const seen = new Set<string>();
  const models: ImageModelView[] = [];
  for (const entry of entries) {
    const repoId = entry.model_id ?? entry.id;
    if (!repoId || entry.partial === true || seen.has(repoId.toLowerCase())) continue;
    if (!isImageModel(repoId, entry.task ?? null)) continue;
    seen.add(repoId.toLowerCase());
    const gguf = entry.model_format === 'gguf' || /gguf/i.test(repoId);
    if (!gguf) {
      if (!/^unsloth\//i.test(repoId)) continue;
      models.push({
        repoId,
        displayName: entry.display_name ?? repoId,
        format: 'pipeline',
        files: [],
      });
      continue;
    }
    const variants = await once(machine, (c) =>
      c.getJson(`/api/models/gguf-variants?repo_id=${encodeURIComponent(repoId)}`, {
        timeoutMs: 20_000,
      }),
    );
    const list = ((variants.body as { variants?: unknown[] } | null)?.variants ?? []) as Array<{
      filename?: string;
      quant?: string;
      size_bytes?: number;
      downloaded?: boolean;
      partial?: boolean;
    }>;
    const files = list
      .filter((v) => v.filename && v.downloaded === true && v.partial !== true)
      .map((v) => ({
        filename: v.filename as string,
        quant: v.quant ?? null,
        sizeBytes: typeof v.size_bytes === 'number' ? v.size_bytes : null,
      }));
    if (files.length > 0) {
      models.push({ repoId, displayName: entry.display_name ?? repoId, format: 'gguf', files });
    }
  }
  models.sort((a, b) => a.repoId.localeCompare(b.repoId, undefined, { sensitivity: 'base' }));
  return { models, error: null };
}
