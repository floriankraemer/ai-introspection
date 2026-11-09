import { describe, expect, it } from 'vitest';
import { newId, sessionId } from './ids.js';

describe('ids', () => {
  it('derives the same session id from agent and native id, and differs across agents', () => {
    expect(sessionId('claude-code', 'abc')).toBe(sessionId('claude-code', 'abc'));
    expect(sessionId('claude-code', 'abc')).not.toBe(sessionId('codex', 'abc'));
    expect(sessionId('claude-code', 'abc')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/);
  });

  it('pins the namespace: changing it would re-key every stored session', () => {
    expect(sessionId('claude-code', 'abc')).toMatchInlineSnapshot(
      `"9844ac2b-b9e2-5c11-b928-25219926f863"`,
    );
  });

  it('issues time-ordered v7 ids', async () => {
    const a = newId();
    await new Promise((r) => setTimeout(r, 2));
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(a < b).toBe(true);
  });
});
