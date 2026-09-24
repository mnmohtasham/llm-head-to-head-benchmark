import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyProbe,
  detailOf,
  median,
  networkCategory,
  type ProbeExport,
  type ProbeRaw,
  type RouteKey,
  type RouteResult,
} from '../src/probe';

function fixture(name: string): ProbeExport {
  const url = new URL(`../../fixtures/probe/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ProbeExport;
}

function route(
  status: number | null,
  body: unknown,
  extra: Partial<RouteResult> = {},
): RouteResult {
  return {
    path: '/x',
    status,
    ms: 5,
    contentType: status === null ? null : 'application/json',
    body,
    error: null,
    ...extra,
  };
}

const failed = (code: string, message = code): RouteResult =>
  route(null, null, { error: { code, message } });

const HEALTHY = route(200, { status: 'healthy', service: 'Unsloth UI Backend' });
const STATUS = route(200, { active_model: null, is_gguf: false });

function probe(
  routes: Partial<Record<RouteKey, RouteResult>>,
  extra: Partial<ProbeRaw> = {},
): ProbeRaw {
  return {
    schemaVersion: 1,
    baseUrl: 'http://192.168.1.20:8888',
    keyConfigured: true,
    startedAt: '2026-09-24T10:00:00.000Z',
    finishedAt: '2026-09-24T10:00:00.100Z',
    durationMs: 100,
    routes,
    rttMs: [2, 3, 4],
    ...extra,
  };
}

const statuses = (raw: ProbeRaw) =>
  Object.fromEntries(
    Object.entries(classifyProbe(raw).capabilities).map(([key, cap]) => [key, cap.status]),
  );

describe('classifyProbe on recorded probes', () => {
  it('finds everything on the fake Mac, with a note that whisper.cpp is missing', () => {
    const report = classifyProbe(fixture('mock-mac-mlx').raw);
    expect(report.overall).toBe('ok');
    expect(Object.values(report.capabilities).map((c) => c.status)).toEqual(Array(6).fill('ok'));
    expect(report.versions).toMatchObject({ unsloth: '2026.9.2', llamaCpp: 'b9585', cuda: null });
    expect(report.platform).toMatchObject({
      backend: 'mlx',
      deviceType: 'mac',
      appleSilicon: true,
    });
    expect(report.gpus).toEqual([{ name: 'Apple M3 Ultra', memoryGb: 512 }]);
    expect(report.text).toMatchObject({ backend: 'gguf', quant: 'Q4_K_M', contextLength: 32768 });
    expect(report.telemetry.powerW).toBeNull(); // Apple's first power reading is always empty
    expect(report.capabilities.telemetry.summary).toContain('power n/a');
    expect(report.issues).toEqual([
      expect.objectContaining({
        capability: 'stt',
        severity: 'info',
        title: expect.stringMatching(/whisper\.cpp/),
      }),
    ]);
    expect(report.rtt.samplesMs).toHaveLength(3);
  });

  it('finds everything on the fake Linux machine, whisper.cpp included', () => {
    const report = classifyProbe(fixture('mock-linux-cuda').raw);
    expect(report.overall).toBe('ok');
    expect(report.issues).toEqual([]);
    expect(report.stt.engines.every((engine) => engine.available)).toBe(true);
    expect(report.telemetry.powerW).not.toBeNull();
    expect(report.gpus[0]?.name).toBe('NVIDIA GeForce RTX 5090');
  });

  it('asks for a key on the real Unsloth probed without one', () => {
    const recorded = fixture('real-linux-no-key');
    expect(recorded.raw.routes.status?.body).toEqual({ detail: 'Not authenticated' });
    const report = classifyProbe(recorded.raw);
    expect(statuses(recorded.raw)).toEqual({
      reachable: 'ok',
      key: 'error',
      text: 'unknown',
      stt: 'unknown',
      image: 'unknown',
      telemetry: 'unknown',
    });
    expect(report.issues[0]?.title).toBe('This machine needs an API key.');
  });
});

describe('classifyProbe on failures', () => {
  it.each([
    ['ECONNREFUSED', /Nothing is listening at 192\.168\.1\.20:8888/, 'Nothing listening'],
    ['TIMEOUT', /did not answer in time/, 'No answer'],
    ['UND_ERR_CONNECT_TIMEOUT', /did not answer in time/, 'No answer'],
    ['EHOSTUNREACH', /cannot be reached from this computer/, 'Unreachable'],
    ['ECONNRESET', /was cut off/, 'Connection cut'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', /secure connection/, 'TLS failed'],
    ['SOMETHING_ODD', /Could not connect/, 'Failed'],
  ])('explains %s in plain words', (code, title, summary) => {
    const report = classifyProbe(probe({ health: failed(code) }));
    expect(report.overall).toBe('error');
    expect(report.capabilities.reachable).toEqual({ status: 'error', summary });
    expect(report.capabilities.key.status).toBe('unknown');
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.title).toMatch(title);
  });

  it('names the host when it cannot be resolved', () => {
    const raw = probe({ health: failed('ENOTFOUND') }, { baseUrl: 'http://mac-studio.local:8888' });
    expect(classifyProbe(raw).issues[0]?.title).toBe(
      'The name mac-studio.local could not be found.',
    );
  });

  it('recognises a web server that is not Unsloth', () => {
    const page = route(404, '<html>Not found</html>', { contentType: 'text/html' });
    const report = classifyProbe(probe({ health: page }));
    expect(report.capabilities.reachable).toEqual({ status: 'error', summary: 'Not Unsloth' });
    expect(report.issues[0]?.title).toMatch(/not Unsloth Studio/);
    expect(report.issues[0]?.hint).toMatch(/HTTP 404 \(a web page\)/);
  });

  it('reports a rejected key', () => {
    const raw = probe({
      health: HEALTHY,
      status: route(401, { detail: 'Invalid or expired API key' }),
    });
    const report = classifyProbe(raw);
    expect(report.capabilities.key).toEqual({ status: 'error', summary: 'Rejected' });
    expect(report.issues[0]?.title).toBe('The API key was rejected.');
    expect(report.capabilities.text.status).toBe('unknown');
  });

  it('reports a machine that has not finished its first-run setup', () => {
    const raw = probe({
      health: HEALTHY,
      status: route(403, { detail: 'Password change required' }),
    });
    expect(classifyProbe(raw).issues[0]?.title).toMatch(/first-run setup/);
  });

  it('accepts a machine with keyless access and says so', () => {
    const raw = probe({ health: HEALTHY, status: STATUS }, { keyConfigured: false });
    const report = classifyProbe(raw);
    expect(report.capabilities.key).toEqual({ status: 'ok', summary: 'Not needed' });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ severity: 'info', capability: 'key' }),
    );
  });

  it('marks what an older Unsloth lacks as missing, not failed', () => {
    const notFound = route(404, { detail: 'API endpoint not found' });
    const raw = probe({
      health: HEALTHY,
      status: STATUS,
      models: notFound,
      props: notFound,
      stt: notFound,
      image: notFound,
      telemetry: notFound,
    });
    const report = classifyProbe(raw);
    expect(statuses(raw)).toMatchObject({
      text: 'ok',
      stt: 'missing',
      image: 'missing',
      telemetry: 'missing',
    });
    expect(report.overall).toBe('warning');
    expect(report.issues.map((issue) => issue.severity)).toEqual([
      'warning',
      'info',
      'info',
      'info',
    ]);
  });

  it('checks the key through the system route when the status route is missing', () => {
    const raw = probe({
      health: HEALTHY,
      status: route(404, { detail: 'API endpoint not found' }),
      system: route(200, { platform: 'Linux-6.17' }),
    });
    expect(statuses(raw)).toMatchObject({ key: 'ok', text: 'missing' });
  });

  it('warns about a model that does not fit in memory and a slow model listing', () => {
    const raw = probe({
      health: HEALTHY,
      status: route(200, {
        active_model: 'unsloth/Big-GGUF',
        is_gguf: true,
        memory_warning: 'Paging from disk.',
      }),
      models: failed('TIMEOUT', 'No answer before the timeout.'),
    });
    const report = classifyProbe(raw);
    expect(report.capabilities.text.status).toBe('ok');
    expect(report.issues.map((issue) => issue.title)).toEqual([
      'Listing the models failed.',
      'The loaded model does not fit in memory.',
    ]);
  });

  it('treats a machine without GPU telemetry or speech engines as missing those', () => {
    const raw = probe({
      health: HEALTHY,
      status: STATUS,
      telemetry: route(200, { available: false, backend: 'cpu', devices: [] }),
      stt: route(200, {
        available: false,
        transformers: { available: false },
        gguf: { available: false },
        mtmd: { available: false },
      }),
    });
    expect(statuses(raw)).toMatchObject({ telemetry: 'missing', stt: 'missing' });
    expect(classifyProbe(raw).overall).toBe('ok');
  });
});

describe('helpers', () => {
  it('computes the median', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('reads error details from FastAPI and OpenAI style bodies', () => {
    expect(detailOf({ detail: 'Not authenticated' })).toBe('Not authenticated');
    expect(detailOf({ error: { message: 'Not authenticated' } })).toBe('Not authenticated');
    expect(detailOf('plain text')).toBe('plain text');
    expect(detailOf(null)).toBe('');
  });

  it('groups network error codes', () => {
    expect(networkCategory('HPE_INVALID_CONSTANT')).toBe('reset');
    expect(networkCategory('CERT_HAS_EXPIRED')).toBe('tls');
    expect(networkCategory('EAI_AGAIN')).toBe('dns');
  });
});
