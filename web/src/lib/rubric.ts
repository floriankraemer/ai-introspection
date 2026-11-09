/**
 * The rubric file keeps `pass_threshold` in its YAML frontmatter, while the editor has a separate
 * number input. These two helpers keep the two in step (input -> file, file -> input).
 */
const LINE = /^(pass_threshold:\s*)(\S+)\s*$/m;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

export function readThreshold(body: string): number | null {
  const fm = FRONTMATTER.exec(body)?.[1];
  const n = Number(fm ? LINE.exec(fm)?.[2] : undefined);
  return Number.isFinite(n) && fm && LINE.test(fm) ? n : null;
}

export function writeThreshold(body: string, value: number): string {
  const m = FRONTMATTER.exec(body);
  if (!m?.[1] || !LINE.test(m[1])) return body;
  const fm = m[1].replace(LINE, `$1${String(value)}`);
  return body.replace(m[1], fm);
}

export const NEW_RUBRIC_BODY = (name: string) => `---
name: ${name}
scale: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
pass_threshold: 0.6
applies_to: all
---
Describe what a good session looks like for this rubric.

- 1.0  Best case
- 0.6  Acceptable
- 0.2  Clearly wrong

Return: score, one-paragraph reason, ids of the events that justify it.
`;
