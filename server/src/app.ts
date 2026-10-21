import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { ApiErrorBody } from '@duel/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AudioStore } from './audio';
import { SECURITY_HEADERS } from './headers';
import { LiveStreams } from './live';
import { registerAuth } from './auth';
import { ImageStore } from './imagestore';
import { chatRestorer } from './restore';
import { ResultStore } from './results';
import { DEFAULT_LOAD_TIMINGS, LoadManager, type LoadTimings } from './loads';
import { ModelCatalog } from './models';
import { DEFAULT_PROBE_TIMEOUTS, type ProbeTimeouts } from './probe';
import { registerMachineRoutes } from './routes/machines';
import { registerModelRoutes } from './routes/models';
import { registerSessionRoutes } from './routes/sessions';
import { registerSuiteRoutes } from './routes/suites';
import { registerRunRoutes } from './routes/runs';
import { registerLmStudioRoutes } from './routes/lmstudio';
import { registerOllamaRoutes } from './routes/ollama';
import { registerShareRoutes } from './routes/share';
import { ShareStore } from './share';
import { DeviceRunIndex } from './runs';
import { registerTelemetryRoutes } from './routes/telemetry';
import { SessionStore } from './session-store';
import { RaceStarter } from './races';
import { DEFAULT_RUN_TIMINGS, SessionManager, type RunTimings } from './sessions';
import { SettingsStore } from './settings';
import { MachineStore } from './store';
import { SuiteStore } from './suite-store';
import { SuiteManager } from './suites';
import { DEFAULT_TELEMETRY, TelemetryHub, type TelemetryOptions } from './telemetry';

export interface AppOptions {
  dataDir: string;
  /** Directory with the built client. null or missing serves the API only. */
  clientDir?: string | null;
  logger?: FastifyServerOptions['logger'];
  probeTimeouts?: Partial<ProbeTimeouts>;
  loadTimings?: Partial<LoadTimings>;
  runTimings?: Partial<RunTimings>;
  telemetry?: Partial<TelemetryOptions>;
  version?: string;
  /** 'dev' when running behind the Vite dev server, which slows measurements. */
  mode?: 'dev' | 'production';
  /** Extra host names the app answers to, besides localhost, IP addresses and this computer's name. */
  allowedHosts?: readonly string[];
  /** How long to wait for the results service; tests shorten it. */
  shareTimeouts?: { connectMs: number; totalMs: number };
  /** Where records go: LLM Bench, unless a test points it at a stand-in service. */
  shareEndpoint?: string;
  /** A password for the whole app; null or missing leaves it open. */
  password?: string | null;
  /**
   * The reverse proxy in front, whose X-Forwarded-For and X-Forwarded-Proto are believed: true for
   * any, or addresses and ranges. Without it, the proxy's own address is the client's.
   */
  trustProxy?: boolean | string;
  /** The clock sessions expire by; tests move it. */
  clock?: () => number;
}

/** Log paths that could carry a key, blanked even if a future change logs them by mistake. */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  'apiKey',
  '*.apiKey',
  'body.apiKey',
  'body.token',
  '*.token',
  'body.password',
  '*.password',
  'req.headers.cookie',
  'headers.cookie',
  'req.headers["x-api-key"]',
  'headers["x-api-key"]',
  'req.headers["x-goog-api-key"]',
  'headers["x-goog-api-key"]',
  'privateKey',
  '*.privateKey',
];

const gzipAsync = promisify(gzip);
/** JSON answers this long or longer are compressed; smaller ones are not worth it. */
const COMPRESS_FROM = 16 * 1024;

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(1, hostHeader.indexOf(']')).toLowerCase();
  return hostHeader.replace(/:\d+$/, '').toLowerCase();
}

/**
 * Whether a request's Host header names this app. A web page that rebinds its own domain to
 * 127.0.0.1 still sends its domain as the Host, so refusing unknown names blocks DNS rebinding.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  extra: readonly string[] = [],
): boolean {
  if (!hostHeader) return true;
  const hostname = hostnameOf(hostHeader);
  if (net.isIP(hostname) !== 0) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const machine = os.hostname().toLowerCase();
  if (hostname === machine || hostname === `${machine}.local`) return true;
  return extra.some((name) => name.toLowerCase() === hostname);
}

/**
 * Changes must come from Model Duel's own page or from outside a browser. Browsers name the page
 * that made a request in `Origin` and, for fetches, `Sec-Fetch-Site`; a request that changes
 * something is refused when either says another site.
 */
export function isSameOriginOrNone(
  method: string,
  headers: { origin?: string | undefined; host?: string | undefined; 'sec-fetch-site'?: unknown },
): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const site = headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    // "null", from sandboxed frames and local files.
    return false;
  }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const logger =
    options.logger && typeof options.logger === 'object'
      ? { redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' }, ...options.logger }
      : (options.logger ?? false);
  // A request body must arrive within ten minutes: long enough for the largest audio file on a
  // slow network, short enough that a stalled upload cannot hold a socket for ever.
  const app = Fastify({
    logger,
    bodyLimit: 64 * 1024,
    requestTimeout: 10 * 60_000,
    trustProxy: options.trustProxy ?? false,
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    // Answers hold machines, runs and settings: no cache keeps a copy, unless the route said how
    // long its answer keeps (the race images and the bundled clip, which never change).
    if (request.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    // Large JSON answers, such as every run or a long race, go gzipped to browsers that take it,
    // compressed on the thread pool so the event loop stays free for a race's timing.
    if (
      typeof payload === 'string' &&
      payload.length >= COMPRESS_FROM &&
      !reply.hasHeader('content-encoding') &&
      /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? '')) &&
      String(reply.getHeader('content-type') ?? '').startsWith('application/json')
    ) {
      reply.header('content-encoding', 'gzip');
      reply.header('vary', 'accept-encoding');
      reply.removeHeader('content-length');
      return gzipAsync(payload, { level: 6 });
    }
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    // A page on another site may make this browser send requests here; only reads are allowed.
    if (!isSameOriginOrNone(request.method, request.headers)) {
      const body: ApiErrorBody = {
        error: 'forbidden_origin',
        message: 'Model Duel refuses changes asked for by another web site.',
      };
      return reply.code(403).send(body);
    }
    if (isAllowedHost(request.headers.host, options.allowedHosts)) return;
    const body: ApiErrorBody = {
      error: 'forbidden_host',
      message:
        "Model Duel answers only requests addressed to localhost, an IP address or this computer's name. Start it with --allow-host <name> to add another name.",
    };
    return reply.code(403).send(body);
  });

  await registerAuth(app, options.dataDir, {
    password: options.password ?? null,
    ...(options.clock ? { now: options.clock } : {}),
  });

  const store = new MachineStore(options.dataDir);
  await store.init();
  const version = options.version ?? '0.0.0';

  const mode = options.mode ?? 'production';
  const clientDir = options.clientDir ?? null;
  const hasClient = clientDir !== null && existsSync(path.join(clientDir, 'index.html'));
  // Read once: a rebuild while the server runs changes the page but not the routes.
  const build = hasClient ? readBuildId(clientDir) : null;
  app.get('/api/health', async () => ({ ok: true, app: 'model-duel', version, mode, build }));
  const catalog = new ModelCatalog();
  const timings = { ...DEFAULT_LOAD_TIMINGS, ...options.loadTimings };
  const loads = new LoadManager(store, timings, app.log);
  registerMachineRoutes(app, store, {
    probeTimeouts: { ...DEFAULT_PROBE_TIMEOUTS, ...options.probeTimeouts },
    version,
    onMachineChanged: (id) => catalog.invalidate(id),
  });
  // Set once the race manager exists: model changes wait for a race on the machine to end.
  let racingOn = (_machineId: string) => false;
  registerModelRoutes(app, {
    store,
    catalog,
    loads,
    timings,
    isRacing: (id) => racingOn(id),
  });
  const settings = new SettingsStore(options.dataDir);
  await settings.init();
  const telemetry = new TelemetryHub(store, settings, {
    ...DEFAULT_TELEMETRY,
    ...options.telemetry,
  });
  const streams = new LiveStreams();
  registerTelemetryRoutes(app, { store, telemetry, streams });
  const audio = new AudioStore(options.dataDir);
  const images = new ImageStore(options.dataDir);
  // Audio arrives as the raw file; the upload route alone raises the size limit.
  app.addContentTypeParser(
    /^(application\/octet-stream|audio\/|video\/)/,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
  const sessionStore = new SessionStore(options.dataDir, app.log);
  await sessionStore.init();
  const results = new ResultStore(options.dataDir, { version, build });
  // Races from before result files get theirs now, in the background; closing waits for them.
  // Set once the race manager exists; until then nothing races.
  let racing = () => false;
  const backfilled = results
    .backfill(
      sessionStore.summaries(),
      (id) => sessionStore.load(id),
      () => racing(),
    )
    .then((written) => {
      if (written > 0) app.log.info({ written }, 'wrote result files for earlier races');
    })
    .catch((error: unknown) => app.log.error({ err: error }, 'could not write earlier results'));
  const sessions = new SessionManager({
    machines: store,
    sessions: sessionStore,
    timings: { ...DEFAULT_RUN_TIMINGS, ...options.runTimings },
    log: app.log,
    isLoading: (machineId) => loads.isActive(machineId),
    telemetry,
    audio,
    images,
    results,
    restoreText: chatRestorer({ catalog, loads, store }),
  });
  racing = () => sessions.racing();
  racingOn = (id) => sessions.racingOn(id);
  const races = new RaceStarter({ store, sessions, isLoading: (id) => loads.isActive(id), audio });
  registerSessionRoutes(app, { store, sessions, races, streams, audio, images, results });
  const suiteStore = new SuiteStore(options.dataDir, app.log);
  await suiteStore.init();
  const suites = new SuiteManager({
    suites: suiteStore,
    races,
    sessions,
    machines: store,
    log: app.log,
  });
  registerSuiteRoutes(app, { suites });
  registerRunRoutes(app, { runs: new DeviceRunIndex(sessionStore, app.log) });
  registerLmStudioRoutes(app, {
    store,
    loadTimeoutMs: options.loadTimings?.loadTimeoutMs ?? 20 * 60_000,
    isRacing: (id) => sessions.racingOn(id),
  });
  registerOllamaRoutes(app, {
    store,
    loadTimeoutMs: options.loadTimings?.loadTimeoutMs ?? 20 * 60_000,
    isRacing: (id) => sessions.racingOn(id),
  });
  const share = new ShareStore(options.dataDir, options.shareEndpoint);
  await share.init();
  registerShareRoutes(app, {
    share,
    sessions,
    version,
    build,
    ...(options.shareTimeouts ? { timeouts: options.shareTimeouts } : {}),
  });
  // Before the server stops taking connections: stop the races and save them, then end the live
  // streams, whose open connections the server would otherwise wait for.
  app.addHook('preClose', async () => {
    // A running suite starts no more races; it is marked interrupted at the next start.
    const suiteStopped = suites.close();
    await sessions.close();
    await suiteStopped;
    streams.endAll();
  });
  app.addHook('onClose', async () => {
    await backfilled;
    await loads.close();
    telemetry.close();
  });

  if (hasClient) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: '/',
      // The build writes .br and .gz copies; browsers that take them get them.
      preCompressed: true,
      setHeaders: (res, file) => {
        // Bundles are named by their content, so they never change; the page itself may.
        res.header(
          'cache-control',
          /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const wantsPage = request.method === 'GET' && !request.url.startsWith('/api/');
    if (hasClient && wantsPage) return reply.sendFile('index.html');
    const body: ApiErrorBody = request.url.startsWith('/api/')
      ? {
          error: 'no_route',
          message: `This Model Duel server has no ${request.method} ${request.url.split('?')[0]}.`,
        }
      : { error: 'not_found', message: 'Not found.' };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error: { statusCode?: number; message?: string }, request, reply) => {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    if (status === 500) request.log.error({ err: error }, 'request failed');
    const body: ApiErrorBody =
      status === 500
        ? { error: 'internal', message: 'Something went wrong in Model Duel. Check its log.' }
        : { error: 'bad_request', message: error.message ?? 'Bad request.' };
    return reply.code(status).send(body);
  });

  return app;
}

/** The id of the client build in `clientDir`, from the build.json that Vite writes next to it. */
function readBuildId(clientDir: string): string | null {
  try {
    const info = JSON.parse(readFileSync(path.join(clientDir, 'build.json'), 'utf8')) as {
      buildId?: unknown;
    };
    return typeof info.buildId === 'string' ? info.buildId : null;
  } catch {
    return null;
  }
}
