const MAX = 200;
const DETAIL_KEYS = [
  'command',
  'cmd',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
];

const oneLine = (s: string): string => {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > MAX ? `${line.slice(0, MAX)}…` : line;
};

function detail(input: string | null): string | undefined {
  if (!input) return undefined;
  try {
    const v = JSON.parse(input) as Record<string, unknown>;
    for (const k of DETAIL_KEYS) {
      const val = v[k];
      if (typeof val === 'string' && val) return oneLine(val);
      if (Array.isArray(val) && val.length > 0) return oneLine(val.join(' '));
    }
  } catch {
    // truncated or purged input
  }
  return undefined;
}

/** The one-line summary the timeline shows; code is wrapped in backticks. Derived at read time from stored (redacted) fields. */
export function summarize(e: {
  kind: string;
  name: string | null;
  input: string | null;
  output: string | null;
}): string {
  switch (e.kind) {
    case 'user':
    case 'assistant':
    case 'system':
      return e.output ? oneLine(e.output) : `(${e.kind} message, content not stored)`;
    case 'skill':
      return `Loaded ${e.name ?? 'skill'}`;
    case 'unknown':
      return `Unrecognised record: ${e.name ?? 'unknown'}`;
    default: {
      const d = detail(e.input);
      return d ? `${e.name ?? e.kind}: \`${d}\`` : (e.name ?? e.kind);
    }
  }
}
