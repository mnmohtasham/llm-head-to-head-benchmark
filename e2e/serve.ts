/**
 * Starts the stand-in servers the browser tests race against, then the production build of the
 * app on its own data folder, e2e/.data, which it empties first. With --auth it starts only a
 * second copy of the app, with a password, on e2e/.data-auth. Playwright runs this (see
 * playwright.config.ts); it is part of the tests, not of the app.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startMockServer } from '@duel/test-servers';
import { startCloudMock } from '@duel/test-servers/cloud';
import { startLmStudioMock } from '@duel/test-servers/lmstudio';
import {
  E2E_APP_PORT,
  E2E_AUTH_APP_PORT,
  E2E_CLOUD_PORTS,
  E2E_LMSTUDIO_PORT,
  E2E_MOCK_PORTS,
  E2E_PASSWORD,
} from './ports';
import { TEST_CLOUDS, TEST_MACHINES } from './stand-ins';

const root = fileURLToPath(new URL('..', import.meta.url));
const auth = process.argv.includes('--auth');
const dataDir = path.join(root, 'e2e', auth ? '.data-auth' : '.data');
const host = '127.0.0.1';

for (const file of ['server/dist/index.js', 'client/dist/index.html']) {
  if (!existsSync(path.join(root, file))) {
    process.stderr.write(`[e2e] ${file} is missing. Run npm run build first.\n`);
    process.exit(1);
  }
}
await rm(dataDir, { recursive: true, force: true });

const standIns = auth
  ? []
  : await Promise.all([
      ...TEST_MACHINES.map((machine, index) =>
        startMockServer({
          port: E2E_MOCK_PORTS[index],
          host,
          profile: machine.profile,
          apiKey: machine.apiKey,
          name: machine.name,
        }),
      ),
      ...TEST_CLOUDS.map((cloud, index) =>
        startCloudMock({
          provider: cloud.provider,
          apiKey: cloud.apiKey,
          port: E2E_CLOUD_PORTS[index],
          host,
        }),
      ),
      startLmStudioMock({ port: E2E_LMSTUDIO_PORT, host, token: null }),
    ]);

let stopping = false;
const app = spawn(
  process.execPath,
  [
    path.join(root, 'server/dist/index.js'),
    '--port',
    String(auth ? E2E_AUTH_APP_PORT : E2E_APP_PORT),
    '--data-dir',
    dataDir,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
      ...(auth ? { DUEL_PASSWORD: E2E_PASSWORD } : {}),
    },
  },
);
for (const stream of [app.stdout, app.stderr]) {
  readline.createInterface({ input: stream }).on('line', (line) => {
    process.stdout.write(`[app] ${line}\n`);
  });
}

async function stop(code: number): Promise<never> {
  stopping = true;
  app.kill('SIGTERM');
  await Promise.allSettled(standIns.map((server) => server.close()));
  process.exit(code);
}

app.on('exit', (code) => {
  if (stopping) return;
  process.stderr.write(`[e2e] The app stopped (exit ${code}).\n`);
  void stop(1);
});
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
