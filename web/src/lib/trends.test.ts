import { describe, expect, it } from 'vitest';
import { bucketOf, isoWeek, overlapGroups, rubricLabel, yAxis } from './trends.js';

describe('trends helpers', () => {
  it('labels rubrics and numbers ISO weeks', () => {
    expect(rubricLabel('silent-workaround')).toBe('Silent workaround');
    expect(isoWeek('2026-10-19T00:00:00.000Z')).toBe(43);
    expect(isoWeek('2027-01-01T00:00:00.000Z')).toBe(53);
  });
  it('snaps a moment to the bucket that holds it', () => {
    const buckets = [
      { start: '2026-10-12', rubrics: {} },
      { start: '2026-10-19', rubrics: {} },
    ];
    expect(bucketOf(buckets, '2026-10-21T10:00:00Z')).toBe('2026-10-19');
    expect(bucketOf(buckets, '2026-10-01T00:00:00Z')).toBeNull();
  });
  it('pads the y axis by one step and stays inside 0 to 100%', () => {
    expect(yAxis([0.57, 0.86, 0.8])).toEqual({
      domain: [0.4, 1],
      ticks: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
    });
  });
  it('groups rubrics whose lines would hide each other', () => {
    const p = (passRate: number) => ({ passRate, graded: 5 });
    const buckets = [
      { start: 'a', rubrics: { x: p(0.5), y: p(0.5), z: p(0.2) } },
      { start: 'b', rubrics: { x: p(1), y: p(1), z: p(1) } },
    ] as unknown as Parameters<typeof overlapGroups>[0];
    expect(overlapGroups(buckets, ['x', 'y', 'z', 'none'])).toEqual([['x', 'y']]);
  });
});
