/**
 * Starts two fake Unsloth machines and the production build of Model Duel, each in its own
 * process, so every feature can be tried without a GPU.
 *
 *   npm run demo                      build, then start with both machines added and probed
 *   tsx scripts/demo.ts --no-seed     start with an empty machine list (used by the browser tests)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEMO_AGENT_PORTS, DEMO_APP_PORT, DEMO_MACHINES, DEMO_MOCK_PORTS } from './demo-config';

const root = fileURLToPath(new URL('..', import.meta.url));

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: String(DEMO_APP_PORT) },
    'mock-ports': { type: 'string', default: DEMO_MOCK_PORTS.join(',') },
    'agent-ports': { type: 'string', default: DEMO_AGENT_PORTS.join(',') },
    'data-dir': { type: 'string', default: '.demo-data' },
    'no-seed': { type: 'boolean', default: false },
    'keep-data': { type: 'boolean', default: false },
  },
});

const appPort = Number(values.port);
const mockPorts = values['mock-ports'].split(',').map(Number);
const agentPorts = values['agent-ports'].split(',').map(Number);
const dataDir = path.resolve(root, values['data-dir']);
const children: ChildProcess[] = [];
let stopping = false;

function stopAll(code: number): never {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

function start(label: string, script: string, args: string[]): ChildProcess {
  const child = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    readline.createInterface({ input: stream }).on('line', (line) => {
      process.stdout.write(`[${label}] ${line}\n`);
    });
  }
  child.on('exit', (code) => {
    if (!stopping) {
      process.stderr.write(`[demo] ${label} stopped (exit ${code}). Stopping the demo.\n`);
      stopAll(1);
    }
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stderr.write(`[demo] ${label} did not start at ${url}.\n`);
  stopAll(1);
}

async function post(url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url} answered HTTP ${response.status}`);
  return response.json();
}

for (const file of [
  'server/dist/index.js',
  'mock/dist/index.js',
  'agent/dist/index.js',
  'client/dist/index.html',
]) {
  if (!existsSync(path.join(root, file))) {
    process.stderr.write(
      `[demo] ${file} is missing. Run npm run build first (npm run demo does).\n`,
    );
    process.exit(1);
  }
}
if (mockPorts.length !== DEMO_MACHINES.length || mockPorts.some((p) => !Number.isInteger(p))) {
  process.stderr.write(`[demo] --mock-ports needs ${DEMO_MACHINES.length} port numbers.\n`);
  process.exit(1);
}

// Start from a clean slate, but only ever wipe the demo's own data folders.
const wipeable = [path.join(root, '.demo-data'), path.join(root, 'e2e', '.data')];
if (!values['keep-data']) {
  if (wipeable.includes(dataDir)) await rm(dataDir, { recursive: true, force: true });
  else process.stdout.write(`[demo] Keeping ${dataDir}: only the demo's own folders are wiped.\n`);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

DEMO_MACHINES.forEach((machine, index) => {
  start(`mock ${machine.profile}`, 'mock/dist/index.js', [
    '--port',
    String(mockPorts[index]),
    '--profile',
    machine.profile,
    '--api-key',
    machine.apiKey,
    '--name',
    machine.name,
  ]);
});
DEMO_MACHINES.forEach((machine, index) => {
  start(`agent ${machine.profile}`, 'agent/dist/index.js', [
    '--port',
    String(agentPorts[index]),
    '--token',
    machine.agentToken,
    '--clips',
    path.join(dataDir, `clips-${index + 1}`),
    '--fake',
    '--fake-fps',
    String(machine.fakeFps),
    '--no-telemetry',
  ]);
});
start('app', 'server/dist/index.js', ['--port', String(appPort), '--data-dir', dataDir]);

await Promise.all(
  mockPorts.map((port, index) =>
    waitFor(`http://127.0.0.1:${port}/api/health`, `mock ${DEMO_MACHINES[index]?.profile}`),
  ),
);
await Promise.all(
  agentPorts.map((port, index) =>
    waitFor(`http://127.0.0.1:${port}/health`, `agent ${DEMO_MACHINES[index]?.profile}`),
  ),
);
const app = `http://127.0.0.1:${appPort}`;
await waitFor(`${app}/api/health`, 'app');

if (!values['no-seed']) {
  const existing = (await (await fetch(`${app}/api/machines`)).json()) as Array<{ name: string }>;
  for (const [index, machine] of DEMO_MACHINES.entries()) {
    if (existing.some((m) => m.name === machine.name)) continue;
    const created = (await post(`${app}/api/machines`, {
      name: machine.name,
      baseUrl: `127.0.0.1:${mockPorts[index]}`,
      apiKey: machine.apiKey,
      agentUrl: `127.0.0.1:${agentPorts[index]}`,
      agentToken: machine.agentToken,
      notes: machine.notes,
      color: machine.color,
    })) as { id: string };
    await post(`${app}/api/machines/${created.id}/probe`);
  }
}

process.stdout.write(
  [
    '',
    `Demo ready: open http://localhost:${appPort}`,
    ...DEMO_MACHINES.map(
      (m, i) =>
        `  ${m.name} (${m.profile}) at http://127.0.0.1:${mockPorts[i]}, key ${m.apiKey}; fake agent at 127.0.0.1:${agentPorts[i]}`,
    ),
    'Break a mock to see the error messages, for example a revoked key:',
    `  curl -X POST http://127.0.0.1:${mockPorts[1]}/__mock/config -H 'content-type: application/json' -d '{"rejectKey":true}'`,
    `  curl -X POST http://127.0.0.1:${mockPorts[1]}/__mock/reset`,
    'Press Ctrl+C to stop.',
    '',
  ].join('\n'),
);
