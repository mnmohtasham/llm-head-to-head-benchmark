import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp } from './app';
import { MIN_PASSWORD_LENGTH } from './auth';

const HELP = `Model Duel controller.

Usage: npm start -- [options]

Every option can also be set in the environment (shown in brackets); an option given here wins.

  --port <n>          Port (default 3000) [PORT]
  --host <addr>       Address to bind (default 127.0.0.1) [HOST]. The app has no login,
                      so bind to a network address only on a network you trust.
  --data-dir <dir>    Where machines and probes are stored (default ./data) [DUEL_DATA_DIR]
  --client-dir <dir>  Built client to serve (default ./client/dist) [DUEL_CLIENT_DIR]
  --api-only          Serve only /api, for development behind the Vite dev server
  --allow-host <name> Also answer requests addressed to this host name (repeatable)
                      [DUEL_ALLOW_HOSTS, comma separated]

Environment only:
  DUEL_PASSWORD                Ask for this password before anything else (at least 8 characters)
  DUEL_PASSWORD_FILE           Read the password from this file instead, e.g. a Docker secret
  LOG_LEVEL                    fatal, error, warn (default), info, debug or trace
  DUEL_TELEMETRY_BASELINE_MS   Idle hardware sampled before and after a race (default 5000)
  DUEL_IN_CONTAINER            1 when running in Docker, for the startup message
`;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    'data-dir': { type: 'string' },
    'client-dir': { type: 'string' },
    'api-only': { type: 'boolean', default: false },
    'allow-host': { type: 'string', multiple: true, default: [] },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

/** Stops with a message instead of starting on a setting that cannot work. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** A whole number from an option or the environment, or the default when neither is set. */
function whole(text: string | undefined, name: string, fallback: number, min: number, max: number) {
  if (text === undefined || text.trim() === '') return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`${name} must be a whole number from ${min} to ${max}, not "${text}".`);
  return n;
}

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const port = whole(values.port ?? env('PORT'), 'The port', 3000, 1, 65535);
const host = values.host ?? env('HOST') ?? '127.0.0.1';
const dataDir = path.resolve(
  values['data-dir'] ?? env('DUEL_DATA_DIR') ?? path.join(repoRoot, 'data'),
);
const clientDir = values['api-only']
  ? null
  : path.resolve(
      values['client-dir'] ?? env('DUEL_CLIENT_DIR') ?? path.join(repoRoot, 'client', 'dist'),
    );
const allowedHosts = [
  ...values['allow-host'],
  ...(env('DUEL_ALLOW_HOSTS') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
];
const baselineMs = env('DUEL_TELEMETRY_BASELINE_MS');
const inContainer = env('DUEL_IN_CONTAINER') === '1';

/** The password from DUEL_PASSWORD, or from the file DUEL_PASSWORD_FILE names; null for none. */
function readPassword(): string | null {
  const file = env('DUEL_PASSWORD_FILE');
  let password = process.env.DUEL_PASSWORD ?? '';
  if (file) {
    try {
      password = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (error) {
      fail(`Could not read DUEL_PASSWORD_FILE (${file}): ${(error as Error).message}`);
    }
  }
  // Nothing started from here needs it.
  delete process.env.DUEL_PASSWORD;
  if (password === '') return null;
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  return password;
}
const password = readPassword();

const app = await buildApp({
  dataDir,
  clientDir,
  version: readVersion(),
  logger: { level: env('LOG_LEVEL') ?? 'warn' },
  allowedHosts,
  password,
  mode: values['api-only'] ? 'dev' : 'production',
  // The telemetry baseline before and after a race; tests shorten it.
  ...(baselineMs
    ? {
        runTimings: {
          telemetryBaselineMs: whole(baselineMs, 'DUEL_TELEMETRY_BASELINE_MS', 5000, 0, 600_000),
        },
      }
    : {}),
});

try {
  await app.listen({ port, host });
} catch (error) {
  const code = (error as { code?: string }).code;
  process.stderr.write(
    code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Stop the other program or pass --port.\n`
      : `Could not start: ${(error as Error).message}\n`,
  );
  process.exit(1);
}

const shownHost = host.includes(':') ? `[${host}]` : host;
const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
if (values['api-only']) {
  process.stdout.write(
    `API for development on http://${shownHost}:${port}. Open http://localhost:3000.\n`,
  );
} else if (inContainer) {
  process.stdout.write(
    `Model Duel is running in a container on port ${port} (data: ${dataDir}). Open the address in the ports line of docker-compose.yml, http://localhost:3000 unless you changed it.\n`,
  );
} else {
  process.stdout.write(`Model Duel on http://${shownHost}:${port}  (data: ${dataDir})\n`);
}
if (clientDir && !app.hasReplyDecorator('sendFile')) {
  process.stdout.write('The client is not built yet. Run npm run build, or use npm run dev.\n');
}
if (password !== null) {
  process.stdout.write('A password is required to use it.\n');
} else if (inContainer) {
  process.stdout.write(
    'Who can open it is set by the ports line: with 127.0.0.1 in front, only this computer. Set DUEL_PASSWORD before opening it to your network.\n',
  );
} else if (!loopback) {
  process.stderr.write(
    `Warning: Model Duel has no password. Anyone who can reach port ${port} on this computer can see your machines and use their API keys through it. Set DUEL_PASSWORD to require one.\n`,
  );
}

const stop = () => {
  void app.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
