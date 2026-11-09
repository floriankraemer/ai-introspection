import { describe, expect, it } from 'vitest';
import { parseRubric, serializeRubric } from './rubric-file.js';

const file = (front: string, body = 'Body text.') => `---\n${front}\n---\n\n${body}\n`;
const ok = 'name: x\nscale: [0.0, 0.5, 1.0]\npass_threshold: 0.5\napplies_to: all';

describe('rubric file', () => {
  it('round-trips through serialize and parse, including target', () => {
    const spec = parseRubric('x', file(`${ok}\ntarget: 0.8`));
    expect(spec).toEqual({
      name: 'x',
      scale: [0, 0.5, 1],
      passThreshold: 0.5,
      appliesTo: 'all',
      target: 0.8,
      body: 'Body text.',
    });
    expect(parseRubric('x', serializeRubric(spec))).toEqual(spec);
  });

  it.each([
    ['no frontmatter', 'just text', /frontmatter/],
    ['name differs from file', file(ok.replace('name: x', 'name: y')), /must match the file name/],
    ['bad scale', file(ok.replace(/scale: .*/, 'scale: nope')), /scale/],
    ['repeated scale value', file(ok.replace(/scale: .*/, 'scale: [0, 0, 1]')), /repeat/],
    ['threshold off scale', file(ok.replace('0.5\n', '0.7\n')), /pass_threshold/],
    ['empty body', file(ok, ''), /empty/],
    ['target out of range', file(`${ok}\ntarget: 2`), /target/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseRubric('x', text)).toThrow(message);
  });
});
