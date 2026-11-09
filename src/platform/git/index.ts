import { execFile } from 'node:child_process';
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

/** Stages exactly `paths` and commits them. Uses a fallback identity only when the user has none configured. */
export async function commitPaths(
  repo: string,
  paths: readonly string[],
  message: string,
): Promise<void> {
  await git(repo, ['add', '--', ...paths]);
  const hasIdentity = await git(repo, ['config', 'user.email']).then(
    (v) => v !== '',
    () => false,
  );
  await git(repo, [
    ...(hasIdentity ? [] : FALLBACK_IDENTITY),
    'commit',
    '-m',
    message,
    '--',
    ...paths,
  ]);
}
