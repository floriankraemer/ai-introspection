import { execFile, spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const FALLBACK_IDENTITY = ['-c', 'user.name=Introspect', '-c', 'user.email=introspect@localhost'];

/** Runs git without a shell; arguments are never interpreted. Rejects with git's stderr. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const stderr = err.stderr?.trim() ?? '';
    const detail = stderr === '' ? err.message : stderr;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`, { cause: e });
  }
}

/**
 * Runs git with optional stdin and returns stdout untouched (a diff's trailing newline matters).
 * Rejects with git's stderr.
 */
export function gitRaw(cwd: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else
        reject(
          new Error(
            `git ${args.join(' ')} failed: ${Buffer.concat(err).toString('utf8').trim() || `exit ${String(code)}`}`,
          ),
        );
    });
    child.stdin.end(input ?? '');
  });
}

/** Creates a repository with `main` as its first branch, whatever the user's `init.defaultBranch` says. */
export async function initRepo(path: string): Promise<void> {
  await git(path, ['init', '--initial-branch=main']);
}

/** True when `path` is the top level of a git work tree (a subfolder of a repo does not count). */
export async function isGitRepoRoot(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false;
    const top = await git(path, ['rev-parse', '--show-toplevel']);
    return (await realpath(top)) === (await realpath(path));
  } catch {
    return false;
  }
}

/** `-c` arguments that give git an author when the user has none configured (env or git config). */
async function identityArgs(repo: string): Promise<string[]> {
  const hasIdentity = await git(repo, ['config', 'user.email']).then(
    (v) => v !== '',
    () => false,
  );
  return hasIdentity || process.env.GIT_AUTHOR_EMAIL ? [] : FALLBACK_IDENTITY;
}

/** Stages exactly `paths` and commits them. Uses a fallback identity only when the user has none configured. */
export async function commitPaths(
  repo: string,
  paths: readonly string[],
  message: string,
): Promise<void> {
  await git(repo, ['add', '--', ...paths]);
  await git(repo, [...(await identityArgs(repo)), 'commit', '-m', message, '--', ...paths]);
}

/** Automated commits ignore the user's hooks and signing (the container has neither their tools nor their keys). */
const AUTOMATED = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export const revParse = (repo: string, rev: string): Promise<string> =>
  git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);

export const currentBranch = (repo: string): Promise<string> =>
  git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);

/** True when `git status` reports nothing, untracked files included. */
export async function isClean(repo: string): Promise<boolean> {
  return (await git(repo, ['status', '--porcelain'])) === '';
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

/** The branch merges go to: `origin/HEAD` when there is a remote, else `main`, `master`, else the checked-out branch. */
export async function defaultBranch(repo: string): Promise<string> {
  const remote = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(
    () => '',
  );
  if (remote.startsWith('origin/')) return remote.slice('origin/'.length);
  for (const name of ['main', 'master']) if (await branchExists(repo, name)) return name;
  return currentBranch(repo);
}

/** Adds a worktree at `path` on a new `branch` that starts at `startPoint`. */
export async function addWorktree(
  repo: string,
  path: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await git(repo, ['worktree', 'add', '-q', '-b', branch, path, startPoint]);
}

/** Adds a worktree for an existing branch. */
export async function addWorktreeForBranch(
  repo: string,
  path: string,
  branch: string,
): Promise<void> {
  await git(repo, ['worktree', 'add', '-q', path, branch]);
}

/** Removes a worktree and forgets stale ones; never throws, so cleanup cannot hide the real error. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path]).catch(() => undefined);
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch]).catch(() => undefined);
}

/** Stages everything in `worktree` and commits it on the checked-out branch; returns the new HEAD. */
export async function commitAll(worktree: string, message: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  await git(worktree, [
    ...(await identityArgs(worktree)),
    ...AUTOMATED,
    'commit',
    '-q',
    '-m',
    message,
  ]);
  return git(worktree, ['rev-parse', 'HEAD']);
}

/** The unified diff of everything staged or committed in `worktree` since `base`, binary changes included. */
export async function diffSince(worktree: string, base: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  return gitRaw(worktree, ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', base]);
}

/** Applies `diff` to the index and working tree of `repo`; `check` only tests. Rejects when it does not apply cleanly. */
export async function applyDiff(repo: string, diff: string, check = false): Promise<void> {
  await gitRaw(
    repo,
    ['apply', ...(check ? ['--check'] : ['--index']), '--whitespace=nowarn', '-'],
    diff,
  );
}

/** `git merge --no-ff`; on a conflict the merge is aborted and `false` returned. */
export async function mergeNoFf(repo: string, branch: string, message: string): Promise<boolean> {
  try {
    await git(repo, [
      ...(await identityArgs(repo)),
      ...AUTOMATED,
      'merge',
      '--no-ff',
      '--no-verify',
      '-m',
      message,
      branch,
    ]);
    return true;
  } catch {
    await git(repo, ['merge', '--abort']).catch(() => undefined);
    return false;
  }
}

/** Files changed between two commits. */
export async function changedFiles(repo: string, from: string, to: string): Promise<string[]> {
  const out = await git(repo, ['diff', '--name-only', '-z', from, to]);
  return out.split('\0').filter((f) => f !== '');
}
