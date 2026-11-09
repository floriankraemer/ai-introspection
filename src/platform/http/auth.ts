import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { problemResponse } from './problem.js';

const TOKEN_FILE = 'token';
export const TOKEN_COOKIE = 'introspect_token';
const TOKEN_HEX_LENGTH = 64; // 256 bits

/** Reads `<dataDir>/token`, creating it (mode 0600) on first start. */
export function loadOrCreateToken(dataDir: string): string {
  const path = join(dataDir, TOKEN_FILE);
  mkdirSync(dataDir, { recursive: true });
  try {
    // 'wx' makes concurrent first starts agree: the loser reads the winner's file.
    writeFileSync(path, randomBytes(TOKEN_HEX_LENGTH / 2).toString('hex'), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  chmodSync(path, 0o600);
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < TOKEN_HEX_LENGTH) {
    throw new Error(`${path} does not hold a valid token; delete it to generate a new one`);
  }
  return token;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function tokenMatches(expected: string, candidate: string | undefined): boolean {
  return candidate !== undefined && timingSafeEqual(digest(expected), digest(candidate));
}

/** DNS-rebinding and cross-site defence (ADR-0008): only loopback Host values, and same-origin Origin values. */
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
    await next();
  };
}

/** Bearer token (CLI, curl) or the HttpOnly cookie set by `/auth` (SPA). */
export function requireToken(token: string, openPaths: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    if (openPaths.has(c.req.path)) return next();
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!tokenMatches(token, bearer) && !tokenMatches(token, getCookie(c, TOKEN_COOKIE))) {
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
    maxAge: 400 * 24 * 3600,
  });
}

/** `introspect open` prints `/auth#<token>`; the fragment never reaches the server or its logs. */
export const AUTH_PAGE = `<!doctype html><meta charset="utf-8"><title>Introspect</title><body>
<script>
const token = location.hash.slice(1);
history.replaceState(null, '', '/auth');
fetch('/v1/auth/session', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
}).then((r) => { if (r.ok) location.replace('/'); else document.body.textContent = 'Invalid token. Run "introspect open" again.'; });
</script>`;
