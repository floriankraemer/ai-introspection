import { InvalidInputError } from '../../platform/errors.js';

export interface RubricSpec {
  name: string;
  /** Allowed scores, ascending. */
  scale: number[];
  passThreshold: number;
  /** Free text from the frontmatter; `all` or a description such as "sessions with failed tool calls". */
  appliesTo: string;
  /** Pass-rate goal for the trend charts; null means the default. */
  target: number | null;
  body: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses and validates one rubric file. `stem` is the file name without `.md`; it must equal `name`. */
export function parseRubric(stem: string, text: string): RubricSpec {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new InvalidInputError('Missing frontmatter (--- block) at the top of the file');
  const fields = new Map<string, string>();
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const name = fields.get('name') ?? '';
  if (!NAME.test(name))
    throw new InvalidInputError('name must be lowercase letters, digits and dashes');
  if (name !== stem)
    throw new InvalidInputError(`name "${name}" must match the file name "${stem}.md"`);

  let scale: unknown;
  try {
    scale = JSON.parse(fields.get('scale') ?? '');
  } catch {
    scale = undefined;
  }
  if (!Array.isArray(scale) || scale.length < 2 || !scale.every((v) => typeof v === 'number'))
    throw new InvalidInputError('scale must be a list of at least two numbers, e.g. [0.0, 1.0]');
  const sorted = [...scale].sort((a, b) => a - b);
  if (new Set(sorted).size !== sorted.length)
    throw new InvalidInputError('scale must not repeat a value');

  const passThreshold = Number(fields.get('pass_threshold'));
  if (!sorted.includes(passThreshold))
    throw new InvalidInputError('pass_threshold must be one of the scale values');

  const rawTarget = fields.get('target');
  const target = rawTarget === undefined ? null : Number(rawTarget);
  if (target !== null && !(target >= 0 && target <= 1))
    throw new InvalidInputError('target must be a pass rate between 0 and 1');

  const appliesTo = fields.get('applies_to');
  const body = (m[2] ?? '').trim();
  if (body === '') throw new InvalidInputError('The rubric body is empty');
  return {
    name,
    scale: sorted,
    passThreshold,
    appliesTo: appliesTo === undefined || appliesTo === '' ? 'all' : appliesTo,
    target,
    body,
  };
}

/** The canonical file text; `parseRubric(name, serializeRubric(spec))` returns `spec`. */
export function serializeRubric(spec: RubricSpec): string {
  const head = [
    `name: ${spec.name}`,
    `scale: [${spec.scale.map((n) => (Number.isInteger(n) ? n.toFixed(1) : String(n))).join(', ')}]`,
    `pass_threshold: ${String(spec.passThreshold)}`,
    `applies_to: ${spec.appliesTo}`,
    ...(spec.target === null ? [] : [`target: ${String(spec.target)}`]),
  ];
  return `---\n${head.join('\n')}\n---\n\n${spec.body.trim()}\n`;
}
