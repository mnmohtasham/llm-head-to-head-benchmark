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

/** The secret sessions are signed with, made once and kept in `<dataDir>/auth.json`. */
async function loadSecret(dataDir: string): Promise<Buffer> {
  const file = path.join(dataDir, 'auth.json');
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as { secret?: unknown };
    if (typeof saved.secret === 'string') {
      const secret = Buffer.from(saved.secret, 'base64');
      if (secret.length >= 32) return secret;
    }
  } catch {
    // Missing or unreadable: make a new one, which signs everyone out.
  }
  const secret = randomBytes(32);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    file,
    `${JSON.stringify({ schemaVersion: 1, secret: secret.toString('base64') }, null, 2)}\n`,
  );
  return secret;
}

/**
 * An optional password for the whole app. With one set, every /api route but the health check and
 * signing in needs the session cookie that POST /api/login sets; the page itself loads and shows a
 * sign-in form. Sessions carry only an expiry signed with a key made from the stored secret and
 * the password, so a restart keeps people signed in and a new password signs everyone out.
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
  const secret = await loadSecret(dataDir);
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

  const tokenFor = (expires: number) =>
    `${expires}.${sign(key, String(expires)).toString('base64url')}`;
  const isValid = (token: string | null): boolean => {
    if (!token) return false;
    const [expires, mac] = token.split('.', 2);
    const until = Number(expires);
    if (!Number.isSafeInteger(until) || until <= now() || !mac) return false;
    const given = Buffer.from(mac, 'base64url');
    const wanted = sign(key, String(until));
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };
  const signedIn = (request: FastifyRequest) =>
    isValid(cookieValue(request.headers.cookie, SESSION_COOKIE));
  const cookie = (value: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict`;

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
    const address = request.ip;
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
      if (timingSafeEqual(await passwordKey(given, secret), key)) {
        failures.delete(address);
        return { kind: 'ok', at };
      }
      if (failures.size < 10_000 || record) {
        failures.set(address, { count: (record?.count ?? 0) + 1, since: record?.since ?? at });
      }
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
      .header('set-cookie', cookie(tokenFor(outcome.at + maxAge * 1000), maxAge))
      .send({ required: true, signedIn: true });
  });

  app.post('/api/logout', async (_request, reply) =>
    reply.header('set-cookie', cookie('', 0)).send({ required: true, signedIn: false }),
  );

  return { required: true };
}
