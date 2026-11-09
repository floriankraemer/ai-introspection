import { InvalidInputError } from '../../platform/errors.js';

/** At most this many files and changed lines per proposal (ADR-0010). */
export const MAX_FILES = 5;
export const MAX_CHANGED_LINES = 300;

/** Anything under these is never allowed: the improver must not change its own grader or git internals. */
const DENIED_FIRST_SEGMENTS = new Set(['rubrics', '.git']);

export class DiffRejectedError extends InvalidInputError {
  constructor(
    reason: string,
    /** The refused text held a secret: nothing of it may be stored. */
    readonly sensitive = false,
  ) {
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
  /** Allowed, but worth a second look: the change touches something Claude Code or a shell executes. */
  warnings: string[];
}

/** Files that a shell, git or Claude Code may execute; denied unless the repository opts in. */
const SCRIPT_EXTENSIONS = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;
/** Markdown or not, a file inside a skills/, agents/ or commands/ folder (global or under .claude/). */
export const isAgentFolderPath = (path: string): boolean =>
  path
    .split('/')
    .slice(0, -1)
    .some((s) => ['skills', 'agents', 'commands'].includes(s.toLowerCase()));

export function isExecutableSurface(path: string): boolean {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  return (
    /^settings.*\.json$/i.test(name) ||
    // Under skills/, agents/ and commands/ only markdown is an instruction; anything else may be run.
    (isAgentFolderPath(path) && !/\.md$/i.test(name)) ||
    segments.slice(0, -1).some((s) => s.toLowerCase() === 'hooks') ||
    SCRIPT_EXTENSIONS.test(name)
  );
}

export const executableWarning = (path: string): string =>
  `"${path}" changes a hook/settings file that Claude Code executes`;

/** Characters a reviewer cannot see but a model or terminal obeys: controls, zero-width, bidi and tag characters. */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/u;
/** `text` without invisible characters, for what is stored after a refusal. */
export const stripInvisible = (text: string): string =>
  text.replace(new RegExp(INVISIBLE.source, 'gu'), '');

/** The first invisible character of `text` (a trailing carriage return of CRLF files is fine), or null. */
export function invisibleProblem(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = INVISIBLE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (m) {
      const cp = (m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      return `contains an invisible or control character (U+${cp})`;
    }
  }
  return null;
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
export function pathProblem(
  path: string,
  allowList: readonly string[],
  allowExecutable = false,
): string | null {
  if (path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/'))
    return `"${path}" is not a plain relative path`;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..'))
    return `"${path}" is not a plain relative path`;
  if (DENIED_FIRST_SEGMENTS.has((segments[0] ?? '').toLowerCase().replace(/[ .]+$/, '')))
    return `"${path}" is never allowed (${segments[0] ?? ''}/ is off limits to the improver)`;
  // `.git ` and `.git.` name the git folder on Windows file systems.
  if (segments.some((s) => s.toLowerCase().replace(/[ .]+$/, '') === '.git'))
    return `"${path}" is inside a .git folder`;
  if (!allowList.some((g) => globToRegExp(g).test(path)))
    return `"${path}" is outside the allowed paths (${allowList.join(', ')})`;
  if (!allowExecutable && isExecutableSurface(path))
    return `"${path}" is a hook, settings file or script that Claude Code or a shell may execute; it is only allowed when the repository sets allowExecutable`;
  return null;
}

interface FileHeader {
  raw: string;
  minus: string | null | undefined;
  plus: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  modes: string[];
}

/**
 * Reads a `git diff --binary` and refuses what a proposal may never contain: a path outside the
 * allow-list or with `..`, a binary change, a symlink or submodule, an executable surface (unless
 * `allowExecutable`), an invisible character in an added line, or too many files or lines.
 * Hunks are counted from their headers, so a deleted line that starts with `--` is not mistaken for a file header.
 *
 * The file names come from the `---`/`+++` (or rename) lines and must agree with the `diff --git`
 * header, which must split in exactly one way: `a/x b/rubrics/y b/z` is refused, not guessed.
 * After applying, the caller re-checks git's own `--raw` output (verify.ts); that is the authority.
 */
export function inspectDiff(
  diff: string,
  allowList: readonly string[],
  allowExecutable = false,
): DiffReport {
  if (diff.trim() === '') throw new DiffRejectedError('the diff is empty');
  const files = new Set<string>();
  const warnings = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let addedText = '';
  let oldLeft = 0;
  let newLeft = 0;
  let current: FileHeader | null = null;

  const check = (p: string): void => {
    const problem = pathProblem(p, allowList, allowExecutable);
    if (problem) throw new DiffRejectedError(problem);
    files.add(p);
  };
  const finish = (): void => {
    const h = current;
    current = null;
    if (!h) return;
    let from: string;
    let to: string;
    if (h.renameFrom !== undefined || h.renameTo !== undefined) {
      if (h.renameFrom === undefined || h.renameTo === undefined)
        throw new DiffRejectedError('unreadable rename header');
      from = h.renameFrom;
      to = h.renameTo;
      if (h.raw !== `a/${from} b/${to}`) throw new DiffRejectedError('ambiguous file header');
    } else {
      const len = (h.raw.length - 5) / 2;
      if (!Number.isInteger(len) || len < 1) throw new DiffRejectedError('ambiguous file header');
      const p = h.raw.slice(2, 2 + len);
      if (h.raw !== `a/${p} b/${p}`) throw new DiffRejectedError('ambiguous file header');
      from = p;
      to = p;
    }
    if (h.minus !== undefined && h.minus !== null && h.minus !== `a/${from}`)
      throw new DiffRejectedError('the file names of the diff header disagree');
    if (h.plus !== undefined && h.plus !== null && h.plus !== `b/${to}`)
      throw new DiffRejectedError('the file names of the diff header disagree');
    check(from);
    check(to);
    for (const mode of h.modes) {
      if (mode === '120000' || mode === '160000')
        throw new DiffRejectedError('symlinks and submodules are not allowed');
    }
    const exec = h.modes.includes('100755');
    if (exec && !allowExecutable)
      throw new DiffRejectedError(`"${to}" is executable; allowExecutable is off`);
    if (exec || isExecutableSurface(from) || isExecutableSurface(to))
      for (const p of new Set([from, to]))
        if (exec || isExecutableSurface(p)) warnings.add(executableWarning(p));
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
      finish();
      if (line.includes('"')) throw new DiffRejectedError('quoted paths are not supported');
      current = {
        raw: line.slice('diff --git '.length),
        minus: undefined,
        plus: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        modes: [],
      };
      continue;
    }
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files '))
      throw new DiffRejectedError('binary changes are not allowed');
    if (!current) continue;
    const named = /^(---|\+\+\+) (.*)$/.exec(line);
    if (named) {
      const key = named[1] === '---' ? 'minus' : 'plus';
      if (current[key] !== undefined) throw new DiffRejectedError('a file header appears twice');
      current[key] = named[2] === '/dev/null' ? null : (named[2] ?? '');
      continue;
    }
    const renamed = /^(?:rename|copy) (from|to) (.*)$/.exec(line);
    if (renamed) {
      if (renamed[1] === 'from') current.renameFrom = renamed[2] ?? '';
      else current.renameTo = renamed[2] ?? '';
      continue;
    }
    const mode =
      /^(?:(?:new|old|deleted) )?(?:file )?mode (\d{6})$/.exec(line) ??
      /^index \S+\.\.\S+ (\d{6})$/.exec(line);
    if (mode?.[1]) current.modes.push(mode[1]);
  }
  finish();
  if (files.size === 0) throw new DiffRejectedError('no file header found');
  if (files.size > MAX_FILES)
    throw new DiffRejectedError(
      `${String(files.size)} files changed, at most ${String(MAX_FILES)} allowed`,
    );
  if (additions + deletions > MAX_CHANGED_LINES)
    throw new DiffRejectedError(
      `${String(additions + deletions)} lines changed, at most ${String(MAX_CHANGED_LINES)} allowed`,
    );
  const invisible = invisibleProblem(addedText);
  if (invisible) throw new DiffRejectedError(`an added line ${invisible}`);
  return {
    files: [...files].sort(),
    additions,
    deletions,
    addedText,
    warnings: [...warnings].sort(),
  };
}

/** Frontmatter keys that only describe a skill, agent or command. Everything else can grant tools or run code. */
const SAFE_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'argument-hint',
  'license',
  'version',
  'metadata',
  'compatibility',
]);

/** Top-level YAML keys of a markdown file's frontmatter, or null without frontmatter. Unreadable lines become `?`. */
function frontmatterKeys(content: string): Map<string, string> | null {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const keys = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.trim() === '---' || line.trim() === '...') return keys;
    if (line.trim() === '' || /^\s/.test(line) || line.startsWith('#')) {
      // Continuation of the previous key's value: part of that value.
      const last = [...keys.keys()].at(-1);
      if (last !== undefined) keys.set(last, `${keys.get(last) ?? ''}\n${line}`);
      continue;
    }
    const m = /^([A-Za-z][\w-]*)[ \t]*:(?:[ \t]|$)(.*)$/.exec(line);
    keys.set(m?.[1] ?? `?${line.slice(0, 20)}`, m?.[2] ?? '');
  }
  keys.set('?unterminated', '');
  return keys;
}

/**
 * Why the frontmatter of a skill, agent or command file can run code or widen permissions, or null.
 * Anything not on the safe list counts (hooks, tools, mcpServers, permissionMode, model, ...), and so does
 * dropping a `disallowedTools` restriction that `before` had.
 */
export function frontmatterProblem(after: string, before?: string): string | null {
  const keys = frontmatterKeys(after);
  const unsafe = [...(keys?.keys() ?? [])].filter((k) => !SAFE_FRONTMATTER_KEYS.has(k));
  if (unsafe.length > 0)
    return `its frontmatter sets ${unsafe.map((k) => k.replace(/^\?.*/, 'an unreadable key')).join(', ')}, which can grant tools or run code`;
  const was = before === undefined ? undefined : frontmatterKeys(before)?.get('disallowedTools');
  if (was !== undefined && keys?.get('disallowedTools') !== was)
    return 'its frontmatter drops or changes a disallowedTools restriction';
  return null;
}
