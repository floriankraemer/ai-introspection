import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  it('applies defaults and derives the SQLite path from the data dir', () => {
    const c = loadConfig({ INTROSPECT_DATA_DIR: '/data', INTROSPECT_WATCH_POLL: '0' });
    expect(c).toEqual({
      dataDir: '/data',
      port: 7317,
      host: '127.0.0.1',
      databaseUrl: '/data/introspect.db',
      watchPoll: false,
      claudeHome: '/data/claude-home',
      claudeSeedCredentials: undefined,
      timeZone: 'UTC',
      judgeOverride: undefined,
      improverOverride: undefined,
      fixedNow: undefined,
    });
  });

  it('accepts the fake judge only as the literal `fake`', () => {
    expect(
      loadConfig({ INTROSPECT_DATA_DIR: '/data', INTROSPECT_JUDGE: 'fake' }).judgeOverride,
    ).toBe('fake');
    expect(() => loadConfig({ INTROSPECT_DATA_DIR: '/data', INTROSPECT_JUDGE: 'real' })).toThrow();
  });

  it('takes a fixed clock start from INTROSPECT_NOW and rejects other text', () => {
    expect(
      loadConfig({ INTROSPECT_DATA_DIR: '/data', INTROSPECT_NOW: '2026-11-09T08:00:00Z' }).fixedNow,
    ).toBe('2026-11-09T08:00:00Z');
    expect(() => loadConfig({ INTROSPECT_DATA_DIR: '/data', INTROSPECT_NOW: 'soon' })).toThrow();
  });

  it('polls for file changes when asked to, or when Docker sets CHOKIDAR_USEPOLLING', () => {
    expect(loadConfig({ INTROSPECT_WATCH_POLL: '1' }).watchPoll).toBe(true);
    expect(loadConfig({ CHOKIDAR_USEPOLLING: '1' }).watchPoll).toBe(true);
  });

  it('prefers DATABASE_URL', () => {
    const c = loadConfig({ INTROSPECT_DATA_DIR: '/d', DATABASE_URL: 'postgres://u:p@h/db' });
    expect(c.databaseUrl).toBe('postgres://u:p@h/db');
  });

  it('rejects an invalid port with a readable message', () => {
    expect(() => loadConfig({ INTROSPECT_PORT: 'abc' })).toThrow(/INTROSPECT_PORT/);
  });

  it('refuses a non-loopback bind in local mode', () => {
    expect(() => loadConfig({ INTROSPECT_HOST: '192.168.1.5' })).toThrow(/loopback/);
  });
});
