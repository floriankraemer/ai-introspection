import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';

const GIT_TIMEOUT_MS = 30_000;
const FALLBACK_IDENTITY = ['-c', 'user.name=Introspect', '-c', 'user.email=introspect@localhost'];

/**
 * Every automated git call ignores the repository's hooks, signing and fsmonitor: they are
 * commands the repository's author chose, and the container has neither their tools nor their keys.
 */
const SAFE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.fsmonitor=false',
];

const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'XDG_CONFIG_HOME'];
const NETWORK_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'SSH_AUTH_SOCK'];
const GIT_ENV = /^GIT_(AUTHOR|COMMITTER)_|^GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM)$/;

/** The environment of a child that is git or gh: no other secret of the server's reaches it. `network` adds the forge credentials. */
export function minimalEnv(
  network = false,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  const keys = network ? [...BASE_ENV_KEYS, ...NETWORK_ENV_KEYS] : BASE_ENV_KEYS;
  for (const [k, v] of Object.entries(source))
    if (v !== undefined && (keys.includes(k) || GIT_ENV.test(k))) env[k] = v;
  return env;
}

/** A git call that exited non-zero (or was killed); `exitCode` tells a merge conflict (1) from a crash. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  /** Passes GH_TOKEN and friends: only for push and `gh`. */
  network?: boolean;
}

/**
 * Runs git with optional stdin and returns stdout untouched (a diff's trailing newline matters).
 * Rejects with a GitError holding git's stderr.
 */
export function gitRaw(
  cwd: string,
  args: readonly string[],
  input?: string,
  opts: GitOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_CONFIG, ...args], {
      cwd,
      env: minimalEnv(opts.network === true),
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
      else {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(
          new GitError(
            `git ${args.join(' ')} failed: ${stderr || `exit ${String(code)}`}`,
            code,
            stderr,
          ),
        );
      }
    });
    child.stdin.end(input ?? '');
  });
}

/** Runs git without a shell; arguments are never interpreted. Rejects with git's stderr. */
export async function git(
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<string> {
  return (await gitRaw(cwd, args, undefined, opts)).trim();
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

/** Removes a worktree and forgets stale ones; never throws, so cleanup cannot hide the real error. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path]).catch(() => undefined);
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch]).catch(() => undefined);
}

/** The worktree holds no change (the edits equal the content already there). */
export class NothingToCommitError extends Error {
  constructor() {
    super('nothing to commit');
    this.name = 'NothingToCommitError';
  }
}

/** Stages everything in `worktree` and commits it on the checked-out branch; returns the new HEAD. */
export async function commitAll(worktree: string, message: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  if ((await git(worktree, ['status', '--porcelain'])) === '') throw new NothingToCommitError();
  await git(worktree, [...(await identityArgs(worktree)), 'commit', '-q', '-m', message]);
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

/** True while a merge is in progress in `repo` (MERGE_HEAD exists). */
export const mergeInProgress = (repo: string): Promise<boolean> =>
  git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
    () => true,
    () => false,
  );

/**
 * `git merge --no-ff`. A real conflict (exit 1 with MERGE_HEAD left behind) is aborted and returns
 * `conflict`. Any other failure throws, and a merge this call left half done is aborted too; the
 * caller must have checked that no merge was running before (and hold the repository's lock).
 */
export async function mergeNoFf(
  repo: string,
  branch: string,
  message: string,
): Promise<'merged' | 'conflict'> {
  try {
    await git(repo, [
      ...(await identityArgs(repo)),
      'merge',
      '--no-ff',
      '--no-verify',
      '-m',
      message,
      branch,
    ]);
    return 'merged';
  } catch (e) {
    const halfDone = await mergeInProgress(repo);
    if (halfDone) await git(repo, ['merge', '--abort']).catch(() => undefined);
    if (halfDone && e instanceof GitError && e.exitCode === 1) return 'conflict';
    throw e;
  }
}

/** Moves `refs/heads/<branch>` to `to` only while it still points at `from`. */
export async function moveBranch(
  repo: string,
  branch: string,
  to: string,
  from: string,
): Promise<void> {
  await git(repo, ['update-ref', `refs/heads/${branch}`, to, from]);
}

/** Local branch names below `prefix` (for example `introspect/`). */
export async function listBranches(repo: string, prefix: string): Promise<string[]> {
  const out = await git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/${prefix}`,
  ]);
  return out.split('\n').filter((b) => b !== '');
}

/** Files changed between two commits. */
export async function changedFiles(repo: string, from: string, to: string): Promise<string[]> {
  const out = await git(repo, ['diff', '--name-only', '-z', from, to]);
  return out.split('\0').filter((f) => f !== '');
}
