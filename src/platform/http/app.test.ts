import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const webDir = mkdtempSync(join(tmpdir(), 'introspect-web-'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>spa</title>');
const app = createApp(webDir);

describe('http app', () => {
  it('reports health', async () => {
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves the SPA at / and for client-side routes', async () => {
    for (const path of ['/', '/sessions/42']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>spa</title>');
    }
  });

  it('does not fall back to the SPA for unknown API routes', async () => {
    const res = await app.request('/v1/nope');
    expect(res.status).toBe(404);
  });
});
