import { describe, expect, it } from 'vitest';
import { composeRubricFile, NEW_RUBRIC_BODY, readThreshold, writeThreshold } from './rubric.js';

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

describe('composeRubricFile', () => {
  const detail = {
    name: 'efficiency',
    scale: [0, 0.2, 0.4, 0.6, 0.8, 1],
    passThreshold: 0.6,
    appliesTo: 'all',
    target: 0.8,
    body: 'Did the agent waste effort?\n',
  };

  it('rebuilds the frontmatter the API strips, so the threshold can be synced', () => {
    const file = composeRubricFile(detail);
    expect(file).toBe(
      '---\nname: efficiency\nscale: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]\npass_threshold: 0.6\napplies_to: all\ntarget: 0.8\n---\n\nDid the agent waste effort?\n',
    );
    expect(readThreshold(file)).toBe(0.6);
    expect(readThreshold(writeThreshold(file, 0.8))).toBe(0.8);
  });

  it('leaves a body that already has frontmatter alone', () => {
    const whole = NEW_RUBRIC_BODY('x');
    expect(composeRubricFile({ ...detail, body: whole })).toBe(whole);
  });
});
