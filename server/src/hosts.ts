import { lookup } from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';

const LOCAL = 'this computer';

function localAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) addresses.add(entry.address.toLowerCase());
  }
  return addresses;
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';
}

/**
 * A key per machine that is the same when two machines are the same computer: a loopback or one
 * of this computer's own addresses counts as this computer, and a name counts as whatever it
 * resolves to. Two machines on one host compete for it, so they should take turns.
 */
export async function hostKeys(
  machines: ReadonlyArray<{ id: string; baseUrl: string }>,
): Promise<Record<string, string>> {
  const own = localAddresses();
  const keyOf = async (baseUrl: string): Promise<string> => {
    let host: string;
    try {
      host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
      return baseUrl;
    }
    const addresses =
      net.isIP(host) !== 0
        ? [host]
        : host === 'localhost'
          ? ['127.0.0.1']
          : await lookup(host, { all: true })
              .then((list) => list.map((entry) => entry.address.toLowerCase()))
              .catch(() => [host]);
    if (addresses.some((address) => isLoopback(address) || own.has(address))) return LOCAL;
    return [...addresses].sort().join(',');
  };
  const entries = await Promise.all(
    machines.map(async (machine) => [machine.id, await keyOf(machine.baseUrl)] as const),
  );
  return Object.fromEntries(entries);
}
