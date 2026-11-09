import { describe, expect, it, vi } from 'vitest';
import { createClock } from './clock.js';

describe('createClock', () => {
  it('is the real time without a fixed start', () => {
    const before = Date.now();
    const t = createClock()().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it('starts at the fixed instant and advances with real elapsed time', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00Z') });
    try {
      const now = createClock('2026-11-09T08:00:00Z');
      expect(now().toISOString()).toBe('2026-11-09T08:00:00.000Z');
      vi.advanceTimersByTime(90_000);
      expect(now().toISOString()).toBe('2026-11-09T08:01:30.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects text that is not an ISO timestamp', () => {
    expect(() => createClock('tomorrow')).toThrow(/INTROSPECT_NOW/);
  });
});
