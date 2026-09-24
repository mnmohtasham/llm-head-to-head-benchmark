import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app';
import type { LoadTimings } from '../src/loads';
import type { ProbeTimeouts } from '../src/probe';
import type { RunTimings } from '../src/sessions';

export function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'model-duel-test-'));
}

/** Collects every log line the app writes, at the most verbose level. */
export function logSink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

export async function testApp(
  options: {
    dataDir?: string;
    probeTimeouts?: Partial<ProbeTimeouts>;
    loadTimings?: Partial<LoadTimings>;
    runTimings?: Partial<RunTimings>;
  } = {},
) {
  const dataDir = options.dataDir ?? (await tempDir());
  const logs = logSink();
  const app = await buildApp({
    dataDir,
    clientDir: null,
    version: 'test',
    logger: { level: 'trace', stream: logs.stream },
    probeTimeouts: {
      connectMs: 1000,
      requestMs: 1500,
      slowRequestMs: 2000,
      ...options.probeTimeouts,
    },
    loadTimings: {
      loadTimeoutMs: 20_000,
      progressEveryMs: 40,
      unloadTimeoutMs: 5000,
      ...options.loadTimings,
    },
    runTimings: { idleTimeoutMs: 5000, totalTimeoutMs: 20_000, ...options.runTimings },
  });
  return { app, dataDir, logs };
}

/** A port on which nothing listens. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Accepts connections and never answers. */
export async function silentServer() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Some other web server, answering every path with an HTML 404. */
export async function otherWebServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<html><body><h1>Not Found</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
