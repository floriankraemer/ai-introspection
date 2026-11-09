import { describe, expect, it } from 'vitest';
import type { RedactedTrace, TraceRecord } from '../ingest/index.js';
import { condenseTrace, estimateTokens } from './condense.js';

const ev = (seq: number, over: Partial<TraceRecord> = {}): TraceRecord => ({
  id: `id-${String(seq)}`,
  seq,
  ts: new Date(Date.UTC(2026, 0, 1, 12, 0, seq)).toISOString(),
  kind: 'tool_call',
  name: 'bash',
  summary: `bash: \`ls ${String(seq)}\``,
  input: null,
  output: 'ok',
  isError: false,
  ...over,
});
const trace = (events: TraceRecord[]): RedactedTrace =>
  ({ sessionId: 's', agent: 'claude_code', title: 't', events }) as unknown as RedactedTrace;

const failing = (seq: number): TraceRecord =>
  ev(seq, { isError: true, summary: 'bash: `pnpm test`', output: 'FAIL: connection refused' });

describe('condenseTrace', () => {
  it('labels every event with its stable sequence number and maps labels to ids', () => {
    const c = condenseTrace(trace([ev(0, { kind: 'user', output: 'do it' }), ev(1), failing(2)]));
    expect(c.text).toContain('[e0] +0s user do it');
    expect(c.text).toContain('[e2] +2s tool_call ✕');
    expect([...c.labels.entries()]).toEqual([
      ['e0', 'id-0'],
      ['e1', 'id-1'],
      ['e2', 'id-2'],
    ]);
  });

  it('is deterministic', () => {
    const t = trace(Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? failing(i) : ev(i))));
    expect(condenseTrace(t, 2000).text).toBe(condenseTrace(t, 2000).text);
  });

  it('folds repeated identical errors into the first one and keeps their labels', () => {
    const c = condenseTrace(trace([failing(1), ev(2), failing(3), failing(4)]));
    expect(c.text).toContain('(repeated 2 more times: e3, e4)');
    expect(c.text).not.toContain('[e3]');
    expect(c.labels.has('e3')).toBe(true);
  });

  it('drops successful middle events first when over the cap and keeps errors and the final message', () => {
    const events = [
      ev(0, { kind: 'user', output: 'start' }),
      ...Array.from({ length: 400 }, (_, i) => ev(i + 1, { output: 'x'.repeat(300) })),
      ev(401, { isError: true, summary: 'bash: `boom`', output: 'boom' }),
      ev(402, { kind: 'assistant', output: 'all done' }),
    ];
    const c = condenseTrace(trace(events), 4000);
    expect(c.estimatedTokens).toBeLessThanOrEqual(4000);
    expect(c.omittedEvents).toBeGreaterThan(0);
    expect(c.text).toContain('[e0]');
    expect(c.text).toContain('[e401]');
    expect(c.text).toContain('[e402] +402s assistant all done');
    expect(c.text).toMatch(/\[\.\.\. \d+ events omitted: e\d+ to e\d+ \.\.\.\]/);
  });

  it('holds the 50k-token cap even when every event is an error', () => {
    const events = Array.from({ length: 800 }, (_, i) =>
      ev(i, {
        isError: true,
        summary: `bash: \`cmd ${String(i)}\``,
        output: `err ${String(i)} ${'y'.repeat(2500)}`,
      }),
    );
    expect(estimateTokens(condenseTrace(trace(events)).text)).toBeLessThanOrEqual(50_000);
  });

  it('cuts the middle, never the end, when even the protected events are over the cap', () => {
    const events = [
      ev(0, { kind: 'user', output: 'start' }),
      ...Array.from({ length: 400 }, (_, i) =>
        ev(i + 1, {
          isError: true,
          summary: `bash: \`cmd ${String(i)}\``,
          output: `err ${String(i)} ${'y'.repeat(900)}`,
        }),
      ),
      ev(401, { kind: 'assistant', output: 'FINAL ANSWER' }),
    ];
    const c = condenseTrace(trace(events), 3000);
    expect(estimateTokens(c.text)).toBeLessThanOrEqual(3000);
    expect(c.text).toContain('[e401] +401s assistant FINAL ANSWER');
    expect(c.text).toContain('[e0] +0s user start');
    expect(c.text).toContain('trace cut in the middle');
    expect(c.labels.has('e401')).toBe(true);
  });

  it('offers only labels that are in the text that is sent', () => {
    const events = [
      ev(0, { kind: 'user', output: 'start' }),
      ...Array.from({ length: 400 }, (_, i) => ev(i + 1, { output: 'x'.repeat(300) })),
      ev(401, { kind: 'assistant', output: 'done' }),
    ];
    const c = condenseTrace(trace(events), 4000);
    expect(c.omittedEvents).toBeGreaterThan(0);
    for (const label of c.labels.keys()) expect(c.text).toContain(`[${label}] +`);
    expect(c.labels.size).toBeLessThan(events.length);
  });
});
