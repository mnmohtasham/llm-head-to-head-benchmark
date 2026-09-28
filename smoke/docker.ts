/**
 * Smoke test of the Docker setup: builds the image from docker-compose.yml, starts it on a spare
 * port with its own container and volume, runs the smoke test against it without a password and
 * again with one, and removes the container, volume and image afterwards.
 *
 *   npm run smoke:docker                 the HTTP checks
 *   npm run smoke:docker -- --browser    the browser checks too (needs Chrome or Playwright's)
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { browser: { type: 'boolean', default: false } } });
const PROJECT = 'llm-h2h-smoke';
const PASSWORD = 'smoke-test-password';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function run(command: string, args: string[], env: Record<string, string> = {}): number {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

async function waitForHealth(port: number): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (answer.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const port = await freePort();
const compose = [
  'compose',
  '-p',
  PROJECT,
  '-f',
  'docker-compose.yml',
  '-f',
  path.join('smoke', 'docker-compose.smoke.yml'),
];
const url = `http://127.0.0.1:${port}`;
let failed = false;

try {
  for (const password of ['', PASSWORD]) {
    const env = { SMOKE_PORT: String(port), SMOKE_PASSWORD: password };
    const label = password ? 'with a password' : 'without a password';
    process.stdout.write(`\n== Docker ${label} ==\n`);
    if (
      run('docker', [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '120'], env) !==
      0
    ) {
      failed = true;
      break;
    }
    if (!(await waitForHealth(port))) {
      process.stderr.write(`The container did not answer at ${url} within 90 s.\n`);
      run('docker', [...compose, 'logs'], env);
      failed = true;
      break;
    }
    const checks: Array<[string, string[]]> = [['npx', ['tsx', 'smoke/smoke.ts', '--url', url]]];
    if (values.browser) {
      checks.push(['npx', ['playwright', 'test', '-c', 'smoke/playwright.config.ts']]);
    }
    for (const [command, args] of checks) {
      if (run(command, args, { ...env, SMOKE_URL: url }) !== 0) failed = true;
    }
    if (failed) {
      run('docker', [...compose, 'logs'], env);
      break;
    }
  }
} finally {
  run('docker', [...compose, 'down', '-v'], { SMOKE_PORT: String(port) });
  run('docker', ['image', 'rm', '-f', 'llm-h2h:smoke']);
}

process.stdout.write(failed ? '\nDocker smoke test failed.\n' : '\nDocker smoke test passed.\n');
process.exit(failed ? 1 : 0);
