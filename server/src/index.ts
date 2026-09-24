import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp } from './app';

const HELP = `Model Duel controller.

Usage: npm start -- [options]

  --port <n>          Port (default 3000, or PORT)
  --host <addr>       Address to bind (default 127.0.0.1, or HOST). The app has no login,
                      so bind to a network address only on a network you trust.
  --data-dir <dir>    Where machines and probes are stored (default ./data, or DUEL_DATA_DIR)
  --client-dir <dir>  Built client to serve (default ./client/dist)
  --api-only          Serve only /api, for development behind the Vite dev server
  --allow-host <name> Also answer requests addressed to this host name (repeatable)
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

const port = Number(values.port ?? process.env.PORT ?? 3000);
const host = values.host ?? process.env.HOST ?? '127.0.0.1';
const dataDir = path.resolve(
  values['data-dir'] ?? process.env.DUEL_DATA_DIR ?? path.join(repoRoot, 'data'),
);
const clientDir = values['api-only']
  ? null
  : path.resolve(values['client-dir'] ?? path.join(repoRoot, 'client', 'dist'));

const app = await buildApp({
  dataDir,
  clientDir,
  version: readVersion(),
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  allowedHosts: values['allow-host'],
  mode: values['api-only'] ? 'dev' : 'production',
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
} else {
  process.stdout.write(`Model Duel on http://${shownHost}:${port}  (data: ${dataDir})\n`);
  if (clientDir && !app.hasReplyDecorator('sendFile')) {
    process.stdout.write('The client is not built yet. Run npm run build, or use npm run dev.\n');
  }
}
if (!loopback) {
  process.stderr.write(
    `Warning: Model Duel has no login. Anyone who can reach port ${port} on this computer can see your machines and use their API keys through it.\n`,
  );
}

const stop = () => {
  void app.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
