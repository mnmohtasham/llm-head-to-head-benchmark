import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiErrorBody } from '@duel/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeFileAtomic } from './store';

/** Shortest password the app starts with. */
export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_COOKIE = 'duel_session';
const SESSION_DAYS = 30;
/** Failed sign-ins allowed from one address in a window before it has to wait. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
/** Addresses tracked at once; past it, new ones wait like an address that failed too often. */
const MAX_TRACKED = 10_000;
/**
 * Failures from all addresses in a window past which every check is slowed down, so guesses
 * spread over many addresses still come slowly, while the right password still signs in.
 */
const GLOBAL_FAILURES = 100;
const SLOWDOWN_MS = 2000;
/** Routes that answer without a session: the health check, and signing in and out. */
const PUBLIC_API = new Set(['/api/health', '/api/auth', '/api/login', '/api/logout']);

type SignIn = { kind: 'ok'; at: number } | { kind: 'wrong' } | { kind: 'wait'; seconds: number };

export interface AuthOptions {
  /** The password; null or missing leaves the app open, as before. */
  password?: string | null;
  /** Tests move the clock. */
  now?: () => number;
}

const sign = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();

/**
 * scrypt at about 32 MB and a few tens of milliseconds: slow enough that someone holding the data
 * folder and a session cookie cannot quickly try passwords against them offline.
 */
const SCRYPT: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function passwordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, 32, SCRYPT, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** A session ended by signing out, kept until it would have expired anyway. */
interface Revoked {
  id: string;
  until: number;
}

/**
 * `<dataDir>/auth.json`: the secret sessions are signed with, made once, and the sessions ended
 * by signing out, so a copied cookie stops working when its owner signs out.
 */
class AuthFile {
  constructor(
    private readonly file: string,
    readonly secret: Buffer,
    private revoked: Revoked[],
  ) {}

  static async load(dataDir: string): Promise<AuthFile> {
    const file = path.join(dataDir, 'auth.json');
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as {
        secret?: unknown;
        revoked?: unknown;
      };
      if (typeof saved.secret === 'string') {
        const secret = Buffer.from(saved.secret, 'base64');
        const revoked = Array.isArray(saved.revoked)
          ? saved.revoked.filter(
              (r): r is Revoked =>
                typeof (r as Revoked)?.id === 'string' && typeof (r as Revoked)?.until === 'number',
            )
          : [];
        if (secret.length >= 32) return new AuthFile(file, secret, revoked);
      }
    } catch {
      // Missing or unreadable: make a new one, which signs everyone out.
    }
    const made = new AuthFile(file, randomBytes(32), []);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await made.save();
    return made;
  }

  isRevoked(id: string): boolean {
    return this.revoked.some((r) => r.id === id);
  }

  async revoke(id: string, until: number, now: number): Promise<void> {
    this.revoked = [...this.revoked.filter((r) => r.until > now && r.id !== id), { id, until }];
    await this.save();
  }

  private save(): Promise<void> {
    return writeFileAtomic(
      this.file,
      `${JSON.stringify(
        { schemaVersion: 2, secret: this.secret.toString('base64'), revoked: this.revoked },
        null,
        2,
      )}\n`,
    );
  }
}

/** The address failures are counted for: an IPv6 address by its /64, which one network holds. */
export function throttleKey(ip: string): string {
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip.replace(/^::ffff:/, '');
  const [head = ''] = ip.split('%');
  const parts = head.split('::');
  const left = (parts[0] ?? '').split(':').filter(Boolean);
  const right = parts.length > 1 ? (parts[1] ?? '').split(':').filter(Boolean) : [];
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${full.slice(0, 4).join(':')}::/64`;
}

/**
 * An optional password for the whole app. With one set, every /api route but the health check and
 * signing in needs the session cookie that POST /api/login sets; the page itself loads and shows a
 * sign-in form. Sessions carry an expiry and an id signed with a key made from the stored secret and
 * the password, so a restart keeps people signed in, signing out ends that session wherever its
 * cookie is, and a new password signs everyone out.
 */
export async function registerAuth(
  app: FastifyInstance,
  dataDir: string,
  options: AuthOptions,
): Promise<{ required: boolean }> {
  const password = options.password ?? null;
  const now = options.now ?? Date.now;
  if (password === null) {
    app.get('/api/auth', async () => ({ required: false, signedIn: true }));
    return { required: false };
  }

  // The key from this password and this data folder's secret both checks a sign-in and signs the
  // sessions, so a new password ends every session.
  const auth = await AuthFile.load(dataDir);
  const secret = auth.secret;
  const key = await passwordKey(password, secret);
  const failures = new Map<string, { count: number; since: number }>();
  // Sign-ins are checked one at a time: a burst of guesses waits its turn, meets the limit on
  // wrong passwords, and cannot run scrypt on every core at once.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const turn = queue.then(task);
    queue = turn.catch(() => undefined);
    return turn;
  };

  // A session is its expiry and a random id, signed: the id lets signing out end that session.
  const tokenFor = (expires: number) => {
    const id = randomBytes(16).toString('base64url');
    return `${expires}.${id}.${sign(key, `${expires}.${id}`).toString('base64url')}`;
  };
  const sessionOf = (token: string | null): { id: string; until: number } | null => {
    if (!token) return null;
    const [expires, id, mac] = token.split('.', 3);
    const until = Number(expires);
    if (!Number.isSafeInteger(until) || until <= now() || !id || !mac) return null;
    const given = Buffer.from(mac, 'base64url');
    const wanted = sign(key, `${until}.${id}`);
    const ok = given.length === wanted.length && timingSafeEqual(given, wanted);
    return ok && !auth.isRevoked(id) ? { id, until } : null;
  };
  const sessionFor = (request: FastifyRequest) =>
    sessionOf(cookieValue(request.headers.cookie, SESSION_COOKIE));
  const signedIn = (request: FastifyRequest) => sessionFor(request) !== null;
  // Secure when the page came over HTTPS, directly or through a proxy the app was told to trust.
  const cookie = (request: FastifyRequest, value: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict${request.protocol === 'https' ? '; Secure' : ''}`;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // The matched route, not the raw URL, so no spelling of a path can slip past; the page's own
    // files and unknown paths hold nothing private.
    const route = request.routeOptions.url ?? '';
    if (!route.startsWith('/api/') || PUBLIC_API.has(route) || signedIn(request)) return;
    const body: ApiErrorBody = { error: 'unauthorized', message: 'Sign in to Model Duel first.' };
    return reply.code(401).send(body);
  });

  app.get('/api/auth', async (request) => ({ required: true, signedIn: signedIn(request) }));

  app.post('/api/login', async (request, reply) => {
    const address = throttleKey(request.ip);
    const parsed = z.object({ password: z.string().max(1024) }).safeParse(request.body);
    const given = parsed.success ? parsed.data.password : '';
    const outcome = await inTurn(async (): Promise<SignIn> => {
      const at = now();
      for (const [ip, entry] of failures) {
        if (at - entry.since > FAILURE_WINDOW_MS) failures.delete(ip);
      }
      const record = failures.get(address);
      if (record && record.count >= MAX_FAILURES) {
        return { kind: 'wait', seconds: Math.ceil((record.since + FAILURE_WINDOW_MS - at) / 1000) };
      }
      // Too many addresses to track: a new one waits, rather than going uncounted.
      if (!record && failures.size >= MAX_TRACKED) {
        return { kind: 'wait', seconds: Math.ceil(FAILURE_WINDOW_MS / 1000) };
      }
      let total = 0;
      for (const entry of failures.values()) total += entry.count;
      if (total >= GLOBAL_FAILURES)
        await new Promise((resolve) => setTimeout(resolve, SLOWDOWN_MS));
      if (timingSafeEqual(await passwordKey(given, secret), key)) {
        failures.delete(address);
        return { kind: 'ok', at };
      }
      failures.set(address, { count: (record?.count ?? 0) + 1, since: record?.since ?? at });
      return { kind: 'wrong' };
    });
    if (outcome.kind === 'wait') {
      const body: ApiErrorBody = {
        error: 'too_many_attempts',
        message: `Too many wrong passwords. Try again in ${Math.ceil(outcome.seconds / 60)} minutes.`,
      };
      return reply.code(429).header('retry-after', String(outcome.seconds)).send(body);
    }
    if (outcome.kind === 'wrong') {
      request.log.warn({ ip: address }, 'wrong password');
      const body: ApiErrorBody = { error: 'wrong_password', message: 'That password is wrong.' };
      return reply.code(401).send(body);
    }
    const maxAge = SESSION_DAYS * 24 * 60 * 60;
    return reply
      .header('set-cookie', cookie(request, tokenFor(outcome.at + maxAge * 1000), maxAge))
      .send({ required: true, signedIn: true });
  });

  app.post('/api/logout', async (request, reply) => {
    const session = sessionFor(request);
    if (session) await auth.revoke(session.id, session.until, now());
    return reply
      .header('set-cookie', cookie(request, '', 0))
      .send({ required: true, signedIn: false });
  });

  return { required: true };
}
