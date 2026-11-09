import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../api/types.js';
import { collapseRuns, formatOffset, formatWhen } from './format.js';

const ev = (seq: number, isError: boolean, name = 'bash'): TraceEvent => ({
  id: `e${String(seq)}`,
  seq,
  offsetS: seq,
  kind: 'tool_call',
  name,
  text: '',
  isError,
  input: null,
  output: null,
  truncated: false,
  payloadPurged: false,
});

describe('collapseRuns', () => {
  it('keeps two errors and folds the rest of a same-named run', () => {
    const rows = collapseRuns([
      ev(1, false),
      ...[2, 3, 4, 5, 6].map((n) => ev(n, true)),
      ev(7, false),
    ]);
    expect(rows.map((r) => r.type)).toEqual(['event', 'event', 'event', 'collapsed', 'event']);
    const c = rows[3];
    expect(c?.type === 'collapsed' && c.events.length).toBe(3);
  });

  it('does not fold short runs or runs of different tools', () => {
    expect(
      collapseRuns([ev(1, true), ev(2, true), ev(3, true)]).every((r) => r.type === 'event'),
    ).toBe(true);
    expect(
      collapseRuns([1, 2, 3, 4].map((n) => ev(n, true, n % 2 ? 'a' : 'b'))).every(
        (r) => r.type === 'event',
      ),
    ).toBe(true);
  });
});

describe('formatting', () => {
  it('formats trace offsets and relative times', () => {
    expect(formatOffset(782)).toBe('13:02');
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(formatWhen('2026-11-09T10:00:00Z', now)).toBe('2 h ago');
    expect(formatWhen('2026-11-08T08:00:00Z', now)).toBe('Yesterday');
    expect(formatWhen('2026-11-06T08:00:00Z', now)).toBe('3 days ago');
  });
});
