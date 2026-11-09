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

/**
 * `GET /v1/rubrics/{name}` returns the text below the frontmatter plus the parsed fields. The editor
 * shows the whole file, so this puts the frontmatter back (same layout as the server's serializer).
 */
export function composeRubricFile(d: {
  name: string;
  scale: number[];
  passThreshold: number;
  appliesTo: string;
  target: number | null;
  body: string;
}): string {
  if (d.body.trimStart().startsWith('---')) return d.body;
  const scale = d.scale.map((n) => (Number.isInteger(n) ? n.toFixed(1) : String(n))).join(', ');
  const head = [
    `name: ${d.name}`,
    `scale: [${scale}]`,
    `pass_threshold: ${String(d.passThreshold)}`,
    `applies_to: ${d.appliesTo}`,
    ...(d.target === null ? [] : [`target: ${String(d.target)}`]),
  ];
  return `---\n${head.join('\n')}\n---\n\n${d.body.trim()}\n`;
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
