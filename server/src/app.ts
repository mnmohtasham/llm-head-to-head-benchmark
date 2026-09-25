import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { ApiErrorBody } from '@duel/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AudioStore } from './audio';
import { ImageStore } from './imagestore';
import { chatRestorer } from './restore';
import { DEFAULT_LOAD_TIMINGS, LoadManager, type LoadTimings } from './loads';
import { ModelCatalog } from './models';
import { DEFAULT_PROBE_TIMEOUTS, type ProbeTimeouts } from './probe';
import { registerMachineRoutes } from './routes/machines';
import { registerModelRoutes } from './routes/models';
import { registerSessionRoutes } from './routes/sessions';
import { registerTelemetryRoutes } from './routes/telemetry';
import { SessionStore } from './session-store';
import { DEFAULT_RUN_TIMINGS, SessionManager, type RunTimings } from './sessions';
import { SettingsStore } from './settings';
import { MachineStore } from './store';
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
}

/** Log paths that could carry a key, blanked even if a future change logs them by mistake. */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  'apiKey',
  '*.apiKey',
  'body.apiKey',
];

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

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const logger =
    options.logger && typeof options.logger === 'object'
      ? { redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' }, ...options.logger }
      : (options.logger ?? false);
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });

  app.addHook('onRequest', async (request, reply) => {
    if (isAllowedHost(request.headers.host, options.allowedHosts)) return;
    const body: ApiErrorBody = {
      error: 'forbidden_host',
      message:
        "Model Duel answers only requests addressed to localhost, an IP address or this computer's name. Start it with --allow-host <name> to add another name.",
    };
    return reply.code(403).send(body);
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
  registerModelRoutes(app, { store, catalog, loads, timings });
  const settings = new SettingsStore(options.dataDir);
  await settings.init();
  const telemetry = new TelemetryHub(store, settings, {
    ...DEFAULT_TELEMETRY,
    ...options.telemetry,
  });
  registerTelemetryRoutes(app, { store, telemetry });
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
  const sessions = new SessionManager({
    machines: store,
    sessions: sessionStore,
    timings: { ...DEFAULT_RUN_TIMINGS, ...options.runTimings },
    log: app.log,
    isLoading: (machineId) => loads.isActive(machineId),
    telemetry,
    audio,
    images,
    restoreText: chatRestorer({ catalog, loads, store }),
  });
  registerSessionRoutes(app, {
    store,
    sessions,
    isLoading: (id) => loads.isActive(id),
    audio,
    images,
  });
  app.addHook('onClose', async () => {
    await loads.close();
    await sessions.close();
    telemetry.close();
  });

  if (hasClient) {
    await app.register(fastifyStatic, { root: clientDir, prefix: '/' });
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
