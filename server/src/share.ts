import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  checkShareEndpoint,
  maskApiKey,
  shareSigningText,
  type ShareEnvelope,
  type ShareRecord,
} from '@duel/shared';
import { Agent, request } from 'undici';
import { writeFileAtomic } from './store';
import { toNetworkError } from './unsloth';

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A record that reached the service. */
export interface SentRecord {
  at: string;
  /** The service's host, for "sent to". */
  host: string;
  sha256: string;
  id: string | null;
  url: string | null;
}

/** What the page may see: never the token or the private key. */
export interface ShareSettingsView {
  endpoint: string | null;
  hasToken: boolean;
  tokenMasked: string | null;
  /** The sender's public key, base64url, and a short fingerprint of it to show. */
  publicKey: string;
  fingerprint: string;
  /** By `sessionId/machineId`, as the Results rows are keyed. */
  sent: Record<string, SentRecord>;
}

interface ShareFile {
  schemaVersion: 1;
  endpoint: string | null;
  token: string | null;
  /** PKCS #8 PEM. Stays in this file. */
  privateKey: string;
  publicKey: string;
  sent: Record<string, SentRecord>;
}

const MAX_SENT = 5000;

/**
 * Sharing: the results service's address and optional token, the Ed25519 key that signs every
 * record this installation sends, and which records went where. Kept in `<dataDir>/share.json`,
 * readable by this user only.
 */
export class ShareStore {
  private data: ShareFile | null = null;
  private key: KeyObject | null = null;

  constructor(readonly dataDir: string) {}

  get file(): string {
    return path.join(this.dataDir, 'share.json');
  }

  async init(): Promise<void> {
    let saved: Partial<ShareFile> | null;
    try {
      saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<ShareFile>;
    } catch {
      saved = null;
    }
    if (saved?.privateKey && saved.publicKey) {
      this.data = {
        schemaVersion: 1,
        endpoint: typeof saved.endpoint === 'string' ? saved.endpoint : null,
        token: typeof saved.token === 'string' ? saved.token : null,
        privateKey: saved.privateKey,
        publicKey: saved.publicKey,
        sent: saved.sent && typeof saved.sent === 'object' ? saved.sent : {},
      };
      this.key = createPrivateKey(saved.privateKey);
      return;
    }
    // A new sender: one key pair for this installation, never shown or sent.
    const pair = generateKeyPairSync('ed25519');
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.data = {
      schemaVersion: 1,
      endpoint: null,
      token: null,
      privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      publicKey: String(jwk.x),
      sent: {},
    };
    this.key = pair.privateKey;
    await this.save();
  }

  private get state(): ShareFile {
    if (!this.data) throw new Error('The share store is not ready.');
    return this.data;
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  get publicKey(): string {
    return this.state.publicKey;
  }

  get endpoint(): string | null {
    return this.state.endpoint;
  }

  get token(): string | null {
    return this.state.token;
  }

  view(): ShareSettingsView {
    const s = this.state;
    return {
      endpoint: s.endpoint,
      hasToken: s.token !== null,
      tokenMasked: maskApiKey(s.token),
      publicKey: s.publicKey,
      fingerprint: sha256Hex(s.publicKey).slice(0, 16),
      sent: { ...s.sent },
    };
  }

  /** `endpoint` null removes it; `token` undefined keeps it, null removes it. */
  async update(patch: {
    endpoint: string | null;
    token?: string | null;
  }): Promise<ShareSettingsView> {
    const s = this.state;
    s.endpoint = patch.endpoint;
    if (patch.token !== undefined) s.token = patch.token;
    // No address, no token: a token must never go to an address it was not meant for.
    if (s.endpoint === null) s.token = null;
    await this.save();
    return this.view();
  }

  async markSent(key: string, entry: SentRecord): Promise<void> {
    const s = this.state;
    s.sent[key] = entry;
    const keys = Object.keys(s.sent);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SENT))) delete s.sent[old];
    await this.save();
  }

  /** The envelope for a record: its SHA-256 and this installation's signature. */
  envelope(record: ShareRecord): ShareEnvelope {
    if (!this.key) throw new Error('The share store is not ready.');
    const text = shareSigningText(record);
    return {
      record,
      sha256: sha256Hex(text),
      signature: {
        algorithm: 'Ed25519',
        publicKey: this.state.publicKey,
        value: sign(null, Buffer.from(text, 'utf8'), this.key).toString('base64url'),
      },
    };
  }
}

export type SendOutcome =
  | { ok: true; status: number; id: string | null; url: string | null; message: string | null }
  | { ok: false; status: number | null; message: string };

const RESPONSE_LIMIT = 64 * 1024;
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Text from the service, shown as plain text: unsafe characters out, and short. */
function serviceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned.slice(0, 300);
}

/** A link from the service, kept only when it points at the service's own host. */
function serviceLink(value: unknown, endpoint: URL): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value, endpoint);
    if (url.host !== endpoint.host || url.protocol !== endpoint.protocol) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Sends one envelope. No redirects are followed, the answer is read up to 64 KB and only its
 * `id`, `url` and `message` are used, each checked.
 */
export async function sendEnvelope(
  endpoint: string,
  token: string | null,
  envelope: ShareEnvelope,
  version: string,
  timeouts: { connectMs: number; totalMs: number } = { connectMs: 10_000, totalMs: 20_000 },
): Promise<SendOutcome> {
  const checked = checkShareEndpoint(endpoint);
  if (!checked.ok) return { ok: false, status: null, message: checked.error };
  const target = new URL(checked.url);
  const agent = new Agent({ connect: { timeout: timeouts.connectMs } });
  try {
    const response = await request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': `ModelDuel/${version}`,
        'idempotency-key': envelope.record.submissionId,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(envelope),
      dispatcher: agent,
      signal: AbortSignal.timeout(timeouts.totalMs),
    });
    let received = '';
    for await (const chunk of response.body) {
      received += Buffer.from(chunk as Uint8Array).toString('utf8');
      if (received.length > RESPONSE_LIMIT) {
        response.body.destroy();
        break;
      }
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(received.slice(0, RESPONSE_LIMIT));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }
    const status = response.statusCode;
    const message = serviceText(body.message) ?? serviceText(body.error);
    if (status >= 300 && status < 400) {
      return {
        ok: false,
        status,
        message:
          'The service answered with a redirect, which Model Duel does not follow. Check the address.',
      };
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        status,
        message: `The service answered HTTP ${status}${message ? `: ${message}` : '.'}`,
      };
    }
    const id =
      typeof body.id === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(body.id) ? body.id : null;
    return { ok: true, status, id, url: serviceLink(body.url, target), message };
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: `The service is not answering: ${toNetworkError(error).message}`,
    };
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}
