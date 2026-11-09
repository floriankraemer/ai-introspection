import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { isGitRepoRoot } from '../git/index.js';

export interface DoctorCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix: string | null;
}
export interface DoctorReport {
  checks: DoctorCheck[];
}

/** Everything the checks look at, gathered by the caller so each check stays a small pure-ish function. */
export interface DoctorInput {
  dataDir: string;
  watchPoll: boolean;
  /** `error` is set when the database cannot be read or is not migrated. */
  db: { error?: string };
  sources: { agent: string; path: string; enabled: boolean }[];
  /** Registered skills repositories (global and project). */
  repos: { kind: 'global' | 'project'; path: string; hasRubrics: boolean }[];
  judge: { transport: 'api' | 'cli'; keySet: boolean };
  env: NodeJS.ProcessEnv;
  uid: number | undefined;
  /** Runs a program and returns stdout; rejects when it is missing or exits non-zero. */
  run: (cmd: string, args: string[]) => Promise<string>;
}

const execFileAsync = promisify(execFile);
export const runProgram: DoctorInput['run'] = async (cmd, args) =>
  (await execFileAsync(cmd, args, { timeout: 10_000 })).stdout.trim();

const ok = (id: string, label: string, detail: string): DoctorCheck => ({
  id,
  label,
  status: 'ok',
  detail,
  fix: null,
});
const problem = (
  status: 'warn' | 'fail',
  id: string,
  label: string,
  detail: string,
  fix: string,
): DoctorCheck => ({ id, label, status, detail, fix });

const can = (path: string, mode: number): boolean => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

/** Fixed container mount points from compose.yaml, with the volume line that creates each. */
const MOUNT_HINTS: Record<string, string> = {
  '/sources/claude/projects':
    'add `- ${HOME}/.claude/projects:/sources/claude/projects:ro` to the volumes in compose.yaml and run `make up`',
  '/sources/codex/sessions':
    'add `- ${HOME}/.codex/sessions:/sources/codex/sessions:ro` to the volumes in compose.yaml and run `make up`',
  '/repos/skills': 'set INTROSPECT_SKILLS_REPO in .env to your skills repository and run `make up`',
  '/repos/projects':
    'set INTROSPECT_PROJECTS_DIR in .env to the folder that holds your project repositories and run `make up`',
};
const mountFix = (path: string): string =>
  MOUNT_HINTS[path] ??
  'mount the folder into the container (volumes in compose.yaml) or correct the path in Settings';

export function checkData({ dataDir, db }: DoctorInput): DoctorCheck {
  const label = 'Data folder and database';
  if (!can(dataDir, constants.W_OK)) {
    return problem(
      'fail',
      'data',
      label,
      `${dataDir} is not writable`,
      'Run the container as your user: set UID and GID in .env (`id -u`, `id -g`) and run `make up`.',
    );
  }
  if (db.error !== undefined) {
    return problem(
      'fail',
      'data',
      label,
      `Database unusable: ${db.error}`,
      'Start the server once (`make up`) so it migrates the database; if it keeps failing, check DATABASE_URL.',
    );
  }
  return ok('data', label, `${dataDir} is writable and the database is migrated`);
}

export function checkSources({ sources }: DoctorInput): DoctorCheck[] {
  const enabled = sources.filter((s) => s.enabled);
  if (enabled.length === 0) {
    return [
      problem(
        'warn',
        'sources',
        'Agent log sources',
        'No source is registered',
        'Finish step 1 of the setup wizard, or run `introspect import`.',
      ),
    ];
  }
  return enabled.map((s, i) => {
    const id = `source-${String(i + 1)}`;
    const label = `Source ${s.agent}: ${s.path}`;
    if (!can(s.path, constants.R_OK | constants.X_OK)) {
      return problem('fail', id, label, 'Folder is missing or not readable', mountFix(s.path));
    }
    return ok(id, label, 'Readable');
  });
}

export function checkWatcher({ watchPoll }: DoctorInput): DoctorCheck {
  return ok(
    'watcher',
    'File watcher',
    watchPoll
      ? 'Polling (inotify is unreliable on bind mounts)'
      : 'Native file events, with the 60 s reconcile scan as a safety net',
  );
}

export async function checkSkillsRepo({ repos }: DoctorInput): Promise<DoctorCheck> {
  const label = 'Global skills repository';
  const repo = repos.find((r) => r.kind === 'global');
  if (!repo) {
    return problem(
      'warn',
      'skills-repo',
      label,
      'Not set',
      'Finish step 3 of the setup wizard, or set INTROSPECT_SKILLS_REPO in .env (mounted at /repos/skills).',
    );
  }
  if (!can(repo.path, constants.R_OK)) {
    return problem(
      'fail',
      'skills-repo',
      label,
      `${repo.path} does not exist`,
      mountFix(repo.path),
    );
  }
  if (!(await isGitRepoRoot(repo.path))) {
    return problem(
      'fail',
      'skills-repo',
      label,
      `${repo.path} is not the root of a git work tree`,
      `Run \`git init\` in the folder on the host, or fix the owner so git trusts it (see the ownership check).`,
    );
  }
  if (!can(repo.path, constants.W_OK)) {
    return problem(
      'fail',
      'skills-repo',
      label,
      `${repo.path} is read-only`,
      'Mount it read-write (no `:ro`) and make sure UID and GID in .env match the folder owner.',
    );
  }
  if (!repo.hasRubrics) {
    return problem(
      'warn',
      'skills-repo',
      label,
      `${repo.path} has no rubrics/ folder`,
      'Use "Add starter rubrics" in the setup wizard (step 3) to copy the starter set.',
    );
  }
  return ok('skills-repo', label, `${repo.path} is a writable git work tree with rubrics/`);
}

export async function checkGitIdentity({ env, run }: DoctorInput): Promise<DoctorCheck> {
  const label = 'Git identity';
  const configured = async (envName: string, key: string): Promise<string> => {
    const fromEnv = env[envName]?.trim() ?? '';
    return fromEnv !== '' ? fromEnv : await run('git', ['config', '--get', key]).catch(() => '');
  };
  const name = await configured('GIT_AUTHOR_NAME', 'user.name');
  const email = await configured('GIT_AUTHOR_EMAIL', 'user.email');
  if (name && email) return ok('git-identity', label, `${name} <${email}>`);
  return problem(
    'warn',
    'git-identity',
    label,
    'No git author is configured; commits fall back to "Introspect"',
    'Set GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL in .env and run `make up`.',
  );
}

export async function checkGh({ env, run }: DoctorInput): Promise<DoctorCheck> {
  const label = 'GitHub CLI (PR mode)';
  const fix =
    'Only needed for PR mode: set GH_TOKEN in .env, or mount ~/.config/gh read-only and run `gh auth login` on the host.';
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return ok('gh', label, 'A GitHub token is set');
  const status = await run('gh', ['auth', 'status']).then(
    () => 'ok' as const,
    (e: unknown) => ((e as { code?: unknown }).code === 'ENOENT' ? 'missing' : 'unauth'),
  );
  if (status === 'ok') return ok('gh', label, 'gh is installed and authenticated');
  return problem(
    'warn',
    'gh',
    label,
    status === 'missing' ? 'gh is not installed' : 'gh is not authenticated',
    fix,
  );
}

export async function checkJudge({ judge, env, run }: DoctorInput): Promise<DoctorCheck> {
  const label = `Judge credential (${judge.transport})`;
  if (judge.transport === 'api') {
    return judge.keySet || env.ANTHROPIC_API_KEY
      ? ok('judge', label, 'An API key is stored')
      : problem(
          'warn',
          'judge',
          label,
          'No API key',
          'Enter the key in Settings (or setup wizard step 2), or switch the judge to the CLI transport.',
        );
  }
  const found = await run('claude', ['--version']).then(
    () => true,
    () => false,
  );
  return found
    ? ok('judge', label, 'The claude CLI is available')
    : problem(
        'warn',
        'judge',
        label,
        'The claude CLI is not installed',
        'Install it and mount your login, or switch the judge to the API transport in Settings.',
      );
}

export function checkOwnership({ repos, uid }: DoctorInput): DoctorCheck {
  const label = 'File ownership';
  if (uid === undefined) return ok('ownership', label, 'Not applicable on this platform');
  const wrong = repos
    .map((r) => r.path)
    .filter((p) => {
      try {
        return statSync(p).uid !== uid;
      } catch {
        return false; // a missing folder is reported by its own check
      }
    });
  if (wrong.length === 0)
    return ok('ownership', label, `Repository folders belong to uid ${String(uid)}`);
  return problem(
    'warn',
    'ownership',
    label,
    `Not owned by uid ${String(uid)}: ${wrong.join(', ')}`,
    'Set UID and GID in .env to the owner of these folders (`id -u`, `id -g`), or run `chown -R $(id -u):$(id -g) <folder>`, then `make up`.',
  );
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks = [
    checkData(input),
    ...checkSources(input),
    checkWatcher(input),
    await checkSkillsRepo(input),
    await checkGitIdentity(input),
    await checkGh(input),
    await checkJudge(input),
    checkOwnership(input),
  ];
  return { checks };
}

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;

/** One line per check, plus an indented fix line when there is one. */
export function formatReport({ checks }: DoctorReport): string {
  return checks
    .flatMap((c) => [
      `${MARK[c.status]}  ${c.label}: ${c.detail}`,
      ...(c.fix ? [`      fix: ${c.fix}`] : []),
    ])
    .join('\n');
}

export const hasFailure = ({ checks }: DoctorReport): boolean =>
  checks.some((c) => c.status === 'fail');
