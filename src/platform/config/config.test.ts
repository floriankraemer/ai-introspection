import { existsSync } from 'node:fs';
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
      intake: undefined,
      logMaxBytes: 64 * 1024 * 1024,
      s3AllowHttp: false,
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

  it('turns the intake listener on with its port; any host, a size cap in MiB', () => {
    const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
    expect(loadConfig({ INTROSPECT_INTAKE_PORT: '7318' }).intake).toEqual({
      port: 7318,
      host: inContainer ? '0.0.0.0' : '127.0.0.1',
      maxBytes: 64 * 1024 * 1024,
      quotaBytes: 2048 * 1024 * 1024,
    });
    expect(
      loadConfig({
        INTROSPECT_INTAKE_PORT: '7318',
        INTROSPECT_INTAKE_HOST: '192.168.1.5',
        INTROSPECT_INTAKE_MAX_MB: '2',
        INTROSPECT_INTAKE_QUOTA_MB: '10',
      }).intake,
    ).toEqual({
      port: 7318,
      host: '192.168.1.5',
      maxBytes: 2 * 1024 * 1024,
      quotaBytes: 10 * 1024 * 1024,
    });
  });

  it('allows plain-http S3 endpoints only when INTROSPECT_S3_ALLOW_HTTP=1', () => {
    expect(loadConfig({ INTROSPECT_S3_ALLOW_HTTP: '1' }).s3AllowHttp).toBe(true);
    expect(() => loadConfig({ INTROSPECT_S3_ALLOW_HTTP: 'yes' })).toThrow();
  });

  it('keeps the main port on loopback when the intake binds elsewhere', () => {
    expect(() =>
      loadConfig({
        INTROSPECT_HOST: '192.168.1.5',
        INTROSPECT_INTAKE_PORT: '7318',
        INTROSPECT_INTAKE_HOST: '0.0.0.0',
      }),
    ).toThrow(/loopback/);
  });

  it('rejects an intake port equal to the main port and a bad size cap', () => {
    expect(() => loadConfig({ INTROSPECT_INTAKE_PORT: '7317' })).toThrow(/must differ/);
    expect(() => loadConfig({ INTROSPECT_INTAKE_MAX_MB: '0' })).toThrow(/INTROSPECT_INTAKE_MAX_MB/);
  });
});
