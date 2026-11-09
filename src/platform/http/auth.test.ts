import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateToken } from './auth.js';

const fresh = (): string => join(mkdtempSync(join(tmpdir(), 'introspect-token-')), 'data');

describe('loadOrCreateToken', () => {
  it('creates a complete 0600 token atomically and leaves no temp file behind', () => {
    const dir = fresh();
    const token = loadOrCreateToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['token']);
    expect(loadOrCreateToken(dir)).toBe(token);
    expect(readdirSync(dir)).toEqual(['token']);
  });

  it('keeps an existing token, however many starts race for it', () => {
    const dir = fresh();
    const tokens = Array.from({ length: 8 }, () => loadOrCreateToken(dir));
    expect(new Set(tokens).size).toBe(1);
  });

  it('gives up on a token file that stays truncated', () => {
    const dir = fresh();
    loadOrCreateToken(dir);
    writeFileSync(join(dir, 'token'), 'abc');
    expect(() => loadOrCreateToken(dir)).toThrow(/does not hold a valid token/);
  });
});
