import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { problemResponse } from './problem.js';

const TOKEN_FILE = 'token';
export const TOKEN_COOKIE = 'introspect_token';
const TOKEN_HEX_LENGTH = 64; // 256 bits

const READ_ATTEMPTS = 20;
const READ_PAUSE_MS = 25;
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Reads `<dataDir>/token`, creating it (mode 0600) on first start. The token is written to a private
 * temp file and hard-linked into place: the link fails if the file exists and never shows a partial
 * token, so concurrent first starts all end up with the winner's complete token.
 */
export function loadOrCreateToken(dataDir: string): string {
  const path = join(dataDir, TOKEN_FILE);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, randomBytes(TOKEN_HEX_LENGTH / 2).toString('hex'), {
      flag: 'wx',
      mode: 0o600,
    });
    linkSync(temp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  } finally {
    rmSync(temp, { force: true });
  }
  chmodSync(path, 0o600);
  // A file left half-written by an older version may be completed by its writer any moment.
  for (let attempt = 1; ; attempt += 1) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= TOKEN_HEX_LENGTH) return token;
    if (attempt === READ_ATTEMPTS) {
      throw new Error(`${path} does not hold a valid token; delete it to generate a new one`);
    }
    pause(READ_PAUSE_MS);
  }
}

/**
 * Replaces the token with a new one (mode 0600, atomic rename). A running server picks it up on its next
 * request (see `tokenReader`), so every cookie and bearer token issued so far stops working.
 */
export function rotateToken(dataDir: string): string {
  const path = join(dataDir, TOKEN_FILE);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(TOKEN_HEX_LENGTH / 2).toString('hex');
  const temp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, token, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return token;
}

/** The current token, re-read when `rotateToken` replaced the file (one `stat` per call). */
export function tokenReader(dataDir: string): () => string {
  const path = join(dataDir, TOKEN_FILE);
  let token = loadOrCreateToken(dataDir);
  let stamp = '';
  const stampOf = (): string => {
    const st = statSync(path);
    return `${String(st.ino)}:${String(st.mtimeMs)}:${String(st.size)}`;
  };
  stamp = stampOf();
  return () => {
    try {
      const now = stampOf();
      if (now !== stamp) {
        // A rotation writes atomically, but a short or empty read must never become the token.
        const next = readFileSync(path, 'utf8').trim();
        if (next.length >= TOKEN_HEX_LENGTH) {
          token = next;
          stamp = now;
        }
      }
    } catch {
      // Keep the token we have.
    }
    return token;
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function tokenMatches(expected: string, candidate: string | undefined): boolean {
  return (
    candidate !== undefined &&
    candidate !== '' &&
    timingSafeEqual(digest(expected), digest(candidate))
  );
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * DNS-rebinding and cross-site defence (ADR-0008): only loopback Host values, same-origin Origin values,
 * and on `/v1` a state-changing request must either carry the bearer header (CLI, curl: a page cannot set
 * it cross-site), an Origin, or `Sec-Fetch-Site: same-origin`. Request bodies must be JSON, which a
 * cross-site form cannot send without a preflight.
 */
export function localGuard(port: number): MiddlewareHandler {
  const hosts = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return async (c, next) => {
    if (!hosts.has(new URL(c.req.url).host)) {
      return problemResponse(c, 403, 'Forbidden', {
        detail: 'Host header is not a loopback address',
      });
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.has(origin)) {
      return problemResponse(c, 403, 'Forbidden', { detail: 'Cross-origin request' });
    }
    if (c.req.path.startsWith('/v1/') && !SAFE_METHODS.has(c.req.method)) {
      const bearer = c.req.header('authorization')?.startsWith('Bearer ') === true;
      if (!bearer && origin === undefined && c.req.header('sec-fetch-site') !== 'same-origin') {
        return problemResponse(c, 403, 'Forbidden', {
          detail: 'A state-changing request needs an Origin or a bearer token',
        });
      }
      const length = c.req.header('content-length');
      const hasBody =
        (length !== undefined && length !== '0') || c.req.header('transfer-encoding') !== undefined;
      if (hasBody && !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
        return problemResponse(c, 415, 'Unsupported media type', {
          detail: 'The body must be application/json',
        });
      }
    }
    await next();
  };
}

/** Bearer token (CLI, curl) or the HttpOnly cookie set by `/auth` (SPA). */
export function requireToken(
  token: string | (() => string),
  openPaths: ReadonlySet<string>,
): MiddlewareHandler {
  return async (c, next) => {
    if (openPaths.has(c.req.path)) return next();
    const expected = typeof token === 'function' ? token() : token;
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!tokenMatches(expected, bearer) && !tokenMatches(expected, getCookie(c, TOKEN_COOKIE))) {
      c.header('www-authenticate', 'Bearer');
      return problemResponse(c, 401, 'Unauthorized', {
        detail: 'A valid Introspect token is required',
      });
    }
    await next();
  };
}

export function setTokenCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
}

/** `introspect open` prints `/auth#<token>`; the fragment never reaches the server or its logs. */
const AUTH_SCRIPT = `
const token = location.hash.slice(1);
history.replaceState(null, '', '/auth');
fetch('/v1/auth/session', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
}).then((r) => { if (r.ok) location.replace('/'); else document.body.textContent = 'Invalid token. Run "introspect open" again.'; });
`;
export const AUTH_PAGE = `<!doctype html><meta charset="utf-8"><title>Introspect</title><body>
<script>${AUTH_SCRIPT}</script>`;
/** The one inline script of the app: the CSP allows exactly this hash on `/auth`. */
export const AUTH_SCRIPT_HASH = `'sha256-${createHash('sha256').update(AUTH_SCRIPT).digest('base64')}'`;
