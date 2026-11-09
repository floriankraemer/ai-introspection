import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  it('applies defaults and derives the SQLite path from the data dir', () => {
    const c = loadConfig({ INTROSPECT_DATA_DIR: '/data' });
    expect(c).toEqual({
      dataDir: '/data',
      port: 7317,
      host: '127.0.0.1',
      databaseUrl: '/data/introspect.db',
    });
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
