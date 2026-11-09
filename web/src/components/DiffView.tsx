import { parseDiff, type DiffKind } from '../lib/diff.js';

// Full class strings, never built dynamically. Each line is a block; long lines wrap, so nothing hides behind a horizontal scroll.
const LINE: Record<DiffKind, string> = {
  file: 'bg-sunken font-semibold text-ink',
  hunk: 'text-accent',
  add: 'bg-pass-bg text-pass',
  del: 'bg-fail-bg text-fail',
  ctx: 'text-muted',
};

/** Unified diff, coloured per line. `+`/`-` stay in the text, so colour is not the only cue. */
export function DiffView({ diff }: { diff: string }) {
  return (
    <pre
      role="region"
      aria-label="Diff"
      tabIndex={0}
      className="m-0 max-h-[32rem] overflow-y-auto rounded-lg border border-line-soft bg-surface-alt p-3 font-mono text-[13px] leading-relaxed"
    >
      {parseDiff(diff).map((l, i) => (
        <code key={i} className={`block px-1 break-words whitespace-pre-wrap ${LINE[l.kind]}`}>
          {l.text || ' '}
        </code>
      ))}
    </pre>
  );
}
