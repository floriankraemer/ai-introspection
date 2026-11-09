import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../api/types.js';
import {
  collapseRuns,
  plural,
  formatOffset,
  formatTokens,
  formatWhen,
  humanizeSources,
  titleText,
} from './format.js';

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

describe('formatTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect([950, 62_000, 4_180_000, 1_000_000].map(formatTokens)).toEqual([
      '950',
      '62k',
      '4.2M',
      '1M',
    ]);
  });
});

describe('titleText', () => {
  it('marks a server-cut title once', () => {
    expect(titleText('a'.repeat(80))).toBe(`${'a'.repeat(80)}…`);
    expect(titleText(`${'a'.repeat(79)}…`)).toBe(`${'a'.repeat(79)}…`);
    expect(titleText('short')).toBe('short');
  });
});

describe('humanizeSources', () => {
  it('renames agents but leaves paths alone', () => {
    expect(humanizeSources('Source claude_code: /sources/codex')).toBe(
      'Source Claude Code: /sources/codex',
    );
    expect(humanizeSources('Source codex: ~/.codex/sessions')).toBe(
      'Source Codex: ~/.codex/sessions',
    );
  });
});

describe('plural', () => {
  it('keeps the singular for exactly one', () => {
    expect(plural(1, 'version')).toBe('1 version');
    expect(plural(0, 'version')).toBe('0 versions');
    expect(plural(2, 'version')).toBe('2 versions');
  });
});
