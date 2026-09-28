import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { streamChatCompletion } from '../src/chat-stream';
import { readBytes, readText, readTextStart, TooLargeError } from '../src/limits';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A server that answers every request with `write`, which may go on for as long as it likes. */
async function serve(write: (response: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer((_request, response) => write(response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Writes `total` bytes of `fill` in 64 KB pieces, or until the client goes away. */
function flood(response: http.ServerResponse, total: number, fill = 'x') {
  const piece = fill.repeat(64 * 1024);
  let sent = 0;
  const more = () => {
    while (sent < total && !response.destroyed) {
      sent += piece.length;
      if (!response.write(piece)) return void response.once('drain', more);
    }
    response.end();
  };
  more();
}

describe('reading answers within limits', () => {
  it('reads a body under the limit and stops at one over it', async () => {
    const url = await serve((response) => flood(response, 256 * 1024));
    expect((await readText((await request(url)).body, 1024 * 1024)).length).toBe(256 * 1024);
    await expect(readBytes((await request(url)).body, 100 * 1024)).rejects.toBeInstanceOf(
      TooLargeError,
    );
    expect((await readTextStart((await request(url)).body, 1000)).length).toBe(1000);
  });

  it('stops a stream that never ends a line instead of buffering it', async () => {
    const url = await serve((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ');
      flood(response, 64 * 1024 * 1024);
    });
    const outcome = await streamChatCompletion(
      url,
      null,
      {},
      {
        signal: new AbortController().signal,
        idleTimeoutMs: 10_000,
        totalTimeoutMs: 30_000,
      },
    );
    expect(outcome.failure).toBe('too-large');
    expect(outcome.timeline.events).toEqual([]);
  });
});
