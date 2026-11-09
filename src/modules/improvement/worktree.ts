import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, removeWorktree } from '../../platform/git/index.js';
import { DiffRejectedError, pathProblem } from './diff.js';
import type { FileEdit } from './types.js';

/** What the improver may read: small text files only, a bounded amount of them. */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES_READ = 60;
const MAX_TOTAL_BYTES = 200 * 1024;
/** One written file may not exceed this (a whole-file edit of a large file is not a small change). */
const MAX_EDIT_BYTES = 200 * 1024;
const FIRST = ['CLAUDE.md', 'AGENTS.md'];

/** Read-only snapshot of the allowed, tracked, plain-text files of a worktree. */
export async function collectFiles(
  worktree: string,
  allowList: readonly string[],
): Promise<Record<string, string>> {
  const listed = (await git(worktree, ['ls-files', '-z'])).split('\0').filter((f) => f !== '');
  const wanted = listed
    .filter((f) => pathProblem(f, allowList) === null)
    .sort((a, b) => {
      const rank = (f: string): number =>
        FIRST.includes(f) ? 0 : f.startsWith('.claude/') ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  const out: Record<string, string> = {};
  let total = 0;
  for (const f of wanted) {
    if (Object.keys(out).length >= MAX_FILES_READ) break;
    const st = await lstat(join(worktree, f)).catch(() => null);
    if (!st?.isFile() || st.size > MAX_FILE_BYTES || total + st.size > MAX_TOTAL_BYTES) continue;
    const text = await readFile(join(worktree, f), 'utf8');
    if (text.includes('\0')) continue;
    out[f] = text;
    total += st.size;
  }
  return out;
}

/** True when `path` or any folder above it inside `root` is a symlink (writing through it could leave the worktree). */
async function throughSymlink(root: string, path: string): Promise<boolean> {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const st = await lstat(current).catch(() => null);
    if (st?.isSymbolicLink()) return true;
  }
  return false;
}

/** Writes whole-file edits into the worktree. Every path is checked before anything is written. */
export async function applyEdits(
  worktree: string,
  edits: readonly FileEdit[],
  allowList: readonly string[],
): Promise<void> {
  for (const e of edits) {
    const problem = pathProblem(e.path, allowList);
    if (problem) throw new DiffRejectedError(problem);
    if (e.content !== null && Buffer.byteLength(e.content) > MAX_EDIT_BYTES)
      throw new DiffRejectedError(
        `"${e.path}" is larger than ${String(MAX_EDIT_BYTES / 1024)} KiB`,
      );
    if (e.content?.includes('\0')) throw new DiffRejectedError(`"${e.path}" is not plain text`);
    if (await throughSymlink(worktree, e.path))
      throw new DiffRejectedError(`"${e.path}" goes through a symbolic link`);
  }
  for (const e of edits) {
    const target = join(worktree, e.path);
    if (e.content === null) await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, e.content);
    }
  }
}

/** Runs `fn` in an existing worktree directory and always removes it afterwards. */
export async function withCleanup<T>(
  repoPath: string,
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } finally {
    await removeWorktree(repoPath, dir);
    await rm(dir, { recursive: true, force: true });
  }
}
