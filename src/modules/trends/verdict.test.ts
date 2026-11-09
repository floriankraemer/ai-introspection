import { describe, expect, it } from 'vitest';
import { verdictOf } from './verdict.js';

const t = (passed: number, graded: number) => ({ passed, graded });

describe('verdictOf', () => {
  it('is too early below the minimum after the change, whatever the rates', () => {
    expect(verdictOf(t(1, 20), t(9, 9), 10)).toBe('too_early');
  });

  it('is too early without a baseline', () => {
    expect(verdictOf(t(0, 0), t(10, 10), 10)).toBe('too_early');
  });

  it('calls a large, well-sampled gain improved and a large loss worse', () => {
    expect(verdictOf(t(10, 40), t(30, 40), 10)).toBe('improved');
    expect(verdictOf(t(30, 40), t(10, 40), 10)).toBe('worse');
  });

  it('calls a small gain on few sessions no change (the documented ceiling)', () => {
    // 50% to 70% on 10 sessions each is z = 0.9, below the 90% threshold.
    expect(verdictOf(t(5, 10), t(7, 10), 10)).toBe('no_change');
  });

  it('needs a gap of about 35 points at 10 versus 10 sessions', () => {
    expect(verdictOf(t(3, 10), t(7, 10), 10)).toBe('improved'); // z = 1.79
    expect(verdictOf(t(4, 10), t(7, 10), 10)).toBe('no_change'); // z = 1.34
  });

  it('has no variance when every session passed (or failed) on both sides', () => {
    expect(verdictOf(t(10, 10), t(12, 12), 10)).toBe('no_change');
    expect(verdictOf(t(0, 10), t(0, 12), 10)).toBe('no_change');
  });

  it('handles a perfect side against a mixed one', () => {
    expect(verdictOf(t(10, 20), t(20, 20), 10)).toBe('improved');
    expect(verdictOf(t(20, 20), t(10, 20), 10)).toBe('worse');
  });

  it('honours the configured minimum', () => {
    expect(verdictOf(t(1, 5), t(5, 5), 5)).toBe('improved');
    expect(verdictOf(t(1, 5), t(5, 5), 6)).toBe('too_early');
  });
});
