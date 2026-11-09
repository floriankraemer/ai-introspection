import { describe, expect, it } from 'vitest';
import { gateStats } from './calibration.js';

describe('calibration gate', () => {
  it('trusts 8 of 10 and not 7 of 10', () => {
    expect(gateStats(10, 10, 8)).toMatchObject({ trusted: true, agreement: 0.8 });
    expect(gateStats(10, 10, 7).trusted).toBe(false);
  });
  it('needs at least 10 compared labels, even when all agree', () => {
    expect(gateStats(9, 9, 9).trusted).toBe(false);
    expect(gateStats(12, 9, 9).trusted).toBe(false);
    expect(gateStats(10, 10, 10).trusted).toBe(true);
  });
  it('scales the ratio: 16 of 20 passes, 15 of 20 does not', () => {
    expect(gateStats(20, 20, 16).trusted).toBe(true);
    expect(gateStats(20, 20, 15).trusted).toBe(false);
  });
  it('reports no agreement before anything is compared', () => {
    expect(gateStats(3, 0, 0)).toMatchObject({ agreement: null, trusted: false });
  });
});
