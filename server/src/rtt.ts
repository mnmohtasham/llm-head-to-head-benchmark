import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { RttResult } from '@duel/shared';

/** Time for one TCP handshake: exactly one network round trip, with no HTTP handling in it. */
function connectOnce(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      const ms = performance.now() - started;
      clearTimeout(timer);
      socket.destroy();
      resolve(ms);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Round trips to a machine, measured as TCP handshakes to its Unsloth port. HTTP requests on a
 * reused connection are no good for this: Unsloth's answers there stall for about 40 ms (Nagle's
 * algorithm meeting delayed ACKs), which would swamp the network time. The name is resolved
 * once, so DNS is not counted either.
 */
export async function measureRtt(
  baseUrl: string,
  options: { count?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RttResult> {
  const count = options.count ?? 3;
  const samples: number[] = [];
  try {
    const url = new URL(baseUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const name = url.hostname.replace(/^\[|\]$/g, '');
    const host = net.isIP(name) !== 0 ? name : (await lookup(name)).address;
    for (let i = 0; i < count && !options.signal?.aborted; i += 1) {
      const ms = await connectOnce(host, port, options.timeoutMs ?? 3000);
      samples.push(Math.round(ms * 1000) / 1000);
    }
  } catch {
    // A machine that does not answer gets no RTT; its run will say why.
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samplesMs: samples,
    medianMs: sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] ?? null) : null,
  };
}
