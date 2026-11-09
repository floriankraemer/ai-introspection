import { describe, expect, it } from 'vitest';
import { isFlagged, isSampled, SignalAccumulator, type SignalEvent } from './signals.js';

const bash = (command: string, isError = false): SignalEvent => ({
  kind: 'tool_call',
  name: 'bash',
  input: JSON.stringify({ command }),
  isError,
});
const run = (events: SignalEvent[]) => {
  const acc = new SignalAccumulator();
  events.forEach((e) => {
    acc.add(e);
  });
  return acc.result();
};

describe('signals', () => {
  it('counts a retry when the same call follows an error within five events', () => {
    const filler: SignalEvent = { kind: 'assistant', name: null, input: null, isError: false };
    expect(run([bash('make', true), filler, bash('make')]).retries).toBe(1);
    expect(
      run([bash('make', true), ...Array<SignalEvent>(6).fill(filler), bash('make')]).retries,
    ).toBe(0);
  });

  it('counts commands run three or more times, and test runs', () => {
    const s = run([
      bash('pnpm test'),
      bash('pnpm test'),
      bash('pnpm test'),
      bash('ls'),
      bash('ls'),
    ]);
    expect(s).toMatchObject({ repeatedCommands: 1, testsRun: 3 });
  });

  it('counts distinct files from file operations', () => {
    const op = (p: string): SignalEvent => ({
      kind: 'file_op',
      name: 'edit',
      input: JSON.stringify({ file_path: p }),
      isError: false,
    });
    expect(run([op('/a'), op('/a'), op('/b')]).filesTouched).toBe(2);
  });

  it('survives truncated or purged inputs', () => {
    expect(() =>
      run([
        { kind: 'tool_call', name: 'bash', input: '{"command":"x', isError: true },
        { kind: 'file_op', name: 'edit', input: null, isError: false },
      ]),
    ).not.toThrow();
  });

  it('flags at the ADR thresholds', () => {
    const zero = {
      failedToolCalls: 0,
      retries: 0,
      repeatedCommands: 0,
      filesTouched: 0,
      testsRun: 0,
    };
    expect(isFlagged(zero)).toBe(false);
    expect(isFlagged({ ...zero, failedToolCalls: 3 })).toBe(true);
    expect(isFlagged({ ...zero, repeatedCommands: 1 })).toBe(true);
    expect(isFlagged({ ...zero, retries: 2 })).toBe(true);
  });

  it('samples about a fifth of sessions, stably', () => {
    const ids = Array.from(
      { length: 2000 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const sampled = ids.filter(isSampled).length;
    expect(sampled).toBeGreaterThan(300);
    expect(sampled).toBeLessThan(500);
    expect(ids.filter(isSampled)).toEqual(ids.filter(isSampled));
  });
});
