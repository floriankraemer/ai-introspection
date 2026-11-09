import { InvalidInputError } from '../../platform/errors.js';

/** At most this many files and changed lines per proposal (ADR-0010). */
export const MAX_FILES = 5;
export const MAX_CHANGED_LINES = 300;

/** Anything under these is never allowed: the improver must not change its own grader or git internals. */
const DENIED_FIRST_SEGMENTS = new Set(['rubrics', '.git']);

export class DiffRejectedError extends InvalidInputError {
  constructor(reason: string) {
    super(`Diff refused: ${reason}`);
    this.name = 'DiffRejectedError';
  }
}

export interface DiffReport {
  files: string[];
  additions: number;
  deletions: number;
  /** The text of every added line, for the secret scan. */
  addedText: string;
}

/** `*` stays inside a folder, `**` crosses folders. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i);
    if (ch === '*' && glob.charAt(i + 1) === '*') {
      i += 1;
      if (glob.charAt(i + 1) === '/') {
        i += 1;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Why `path` may not be changed, or null. Checks traversal first, then the deny list, then the allow-list. */
export function pathProblem(path: string, allowList: readonly string[]): string | null {
  if (path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/'))
    return `"${path}" is not a plain relative path`;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..'))
    return `"${path}" is not a plain relative path`;
  if (DENIED_FIRST_SEGMENTS.has((segments[0] ?? '').toLowerCase()))
    return `"${path}" is never allowed (${segments[0] ?? ''}/ is off limits to the improver)`;
  if (segments.some((s) => s.toLowerCase() === '.git')) return `"${path}" is inside a .git folder`;
  if (!allowList.some((g) => globToRegExp(g).test(path)))
    return `"${path}" is outside the allowed paths (${allowList.join(', ')})`;
  return null;
}

/**
 * Reads a `git diff --binary` and refuses what a proposal may never contain: a path outside the
 * allow-list or with `..`, a binary change, a symlink or submodule, or too many files or lines.
 * Hunks are counted from their headers, so a deleted line that starts with `--` is not mistaken for a file header.
 */
export function inspectDiff(diff: string, allowList: readonly string[]): DiffReport {
  if (diff.trim() === '') throw new DiffRejectedError('the diff is empty');
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let addedText = '';
  let oldLeft = 0;
  let newLeft = 0;
  const check = (p: string): void => {
    const problem = pathProblem(p, allowList);
    if (problem) throw new DiffRejectedError(problem);
    files.add(p);
  };
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line.charAt(0);
      if (c === '+') {
        newLeft -= 1;
        additions += 1;
        addedText += `${line.slice(1)}\n`;
      } else if (c === '-') {
        oldLeft -= 1;
        deletions += 1;
      } else if (c === ' ' || line === '') {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      if (line.includes('"')) throw new DiffRejectedError('quoted paths are not supported');
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m?.[1] || !m[2]) throw new DiffRejectedError('unreadable file header');
      check(m[1]);
      check(m[2]);
    } else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files '))
      throw new DiffRejectedError('binary changes are not allowed');
    else if (/^(new|old|deleted)? ?(file )?mode (120000|160000)/.test(line))
      throw new DiffRejectedError('symlinks and submodules are not allowed');
    else if (/^(rename|copy) (from|to) /.test(line)) check(line.replace(/^\S+ \S+ /, ''));
  }
  if (files.size === 0) throw new DiffRejectedError('no file header found');
  if (files.size > MAX_FILES)
    throw new DiffRejectedError(
      `${String(files.size)} files changed, at most ${String(MAX_FILES)} allowed`,
    );
  if (additions + deletions > MAX_CHANGED_LINES)
    throw new DiffRejectedError(
      `${String(additions + deletions)} lines changed, at most ${String(MAX_CHANGED_LINES)} allowed`,
    );
  return { files: [...files].sort(), additions, deletions, addedText };
}
