import { describe, expect, it } from 'vitest';
import { NEW_RUBRIC_BODY, readThreshold, writeThreshold } from './rubric.js';

describe('rubric frontmatter threshold', () => {
  it('reads and rewrites pass_threshold in the frontmatter only', () => {
    const body = NEW_RUBRIC_BODY('x');
    expect(readThreshold(body)).toBe(0.6);
    const next = writeThreshold(body, 0.8);
    expect(readThreshold(next)).toBe(0.8);
    expect(next).toContain('applies_to: all');
  });

  it('ignores a pass_threshold line outside the frontmatter and leaves bodies without one alone', () => {
    const body = '---\nname: x\n---\npass_threshold: 0.9\n';
    expect(readThreshold(body)).toBeNull();
    expect(writeThreshold(body, 0.5)).toBe(body);
    expect(readThreshold('no frontmatter')).toBeNull();
  });
});
