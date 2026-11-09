// Shared by settings (validation on save) and ingest (defence before running a pattern).

/** The pattern is unsafe for a backtracking engine, with the reason, or null when it passes the heuristic. */
export function unsafePatternReason(pattern: string): string | null {
  try {
    new RegExp(pattern);
  } catch {
    return 'Not a valid regular expression';
  }
  // Walk the pattern: a group that holds an unbounded repeat and is itself repeated without bound
  // backtracks exponentially (`(a+)+`). Escapes and character classes are skipped.
  const open: { repeats: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1;
    } else if (inClass) {
      inClass = c !== ']';
    } else if (c === '[') {
      inClass = true;
    } else if (c === '(') {
      open.push({ repeats: false });
    } else if (c === ')') {
      const group = open.pop();
      const next = pattern.slice(i + 1, i + 12);
      if (group?.repeats && /^(?:[*+]|\{\d*,\})/.test(next))
        return 'Nested repetition such as (a+)+ can run for minutes; use a fixed length';
      if (group?.repeats && open.length > 0) {
        const parent = open[open.length - 1];
        if (parent) parent.repeats = true;
      }
    } else if (c === '*' || c === '+' || (c === '{' && /^\{\d*,\d*\}/.test(pattern.slice(i)))) {
      const unbounded = c !== '{' || /^\{\d*,\}/.test(pattern.slice(i));
      const parent = open[open.length - 1];
      if (unbounded && parent) parent.repeats = true;
    }
  }
  return null;
}
