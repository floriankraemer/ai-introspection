import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { isGitRepoRoot } from '../git/index.js';
import { isLoopbackHost } from '../transport.js';

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
  /** `INTROSPECT_NOW`: the app clock is fixed to start there (tests only). */
  fixedNow?: string | undefined;
  /** The `redaction.enabled` setting; sessions stored while it is off never reach a judge. */
  redactionEnabled: boolean;
  /** `error` is set when the database cannot be read or is not migrated. */
  db: { error?: string };
  sources: {
    agent: string;
    path: string;
    enabled: boolean;
    kind?: string;
    remote?: { bucket: string; prefix: string } | null;
  }[];
  /** Resolves AWS credentials and lists the bucket; absent when the caller has no S3 support. */
  diagnoseS3?: (remote: {
    bucket: string;
    prefix: string;
  }) => Promise<{ credentialsError: string | null; bucketError: string | null }>;
  /** Registered skills repositories (global and project). */
  repos: { kind: 'global' | 'project'; path: string; hasRubrics: boolean }[];
  /** Problems the trends change scan had with a repository (rewritten history, unreadable commits). */
  scanWarnings: { path: string; warning: string }[];
  /** Parse errors of rubric files in the global skills repository. */
  rubricProblems: string[];
  judge: {
    transport: 'api' | 'cli';
    keySet: boolean;
    /** `INTROSPECT_JUDGE=fake`: the test-only judge replaces both transports. */
    fake: boolean;
    cli: {
      /** The judge's private HOME, where its own login lives. */
      home: string;
      /** The judge's own login exists in `home`. */
      loginPresent: boolean;
      /** Why the CLI's private home could be ingested as agent logs, or null. */
      isolationProblem: string | null;
    };
  };
  /** The intake listener (undefined when off) and how many intake tokens are usable now. */
  intake?: { port: number; host: string; activeTokens: number } | undefined;
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

export function checkClock({ fixedNow }: Pick<DoctorInput, 'fixedNow'>): DoctorCheck | null {
  if (fixedNow === undefined) return null;
  return problem(
    'warn',
    'clock',
    'Clock',
    `INTROSPECT_NOW=${fixedNow} is set: every time in the app starts from that instant`,
    'Unset INTROSPECT_NOW and run `make up` to use the real time.',
  );
}

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
  // Pushed and S3 sources live in our data folder (checkData); S3 and intake have their own checks.
  return enabled
    .filter((s) => (s.kind ?? 'folder') === 'folder')
    .map((s, i) => {
      const id = `source-${String(i + 1)}`;
      const label = `Source ${s.agent}: ${s.path}`;
      if (!can(s.path, constants.R_OK | constants.X_OK)) {
        return problem('fail', id, label, 'Folder is missing or not readable', mountFix(s.path));
      }
      return ok(id, label, 'Readable');
    });
}

export async function checkS3Sources({
  sources,
  diagnoseS3,
}: Pick<DoctorInput, 'sources' | 'diagnoseS3'>): Promise<DoctorCheck[]> {
  const s3 = sources.filter((s) => s.enabled && s.kind === 's3' && s.remote);
  if (!diagnoseS3) return [];
  return Promise.all(
    s3.map(async (s, i) => {
      const id = `s3-${String(i + 1)}`;
      const remote = s.remote as { bucket: string; prefix: string };
      const label = `S3 source s3://${remote.bucket}/${remote.prefix}`;
      const d = await diagnoseS3(remote);
      if (d.credentialsError !== null)
        return problem(
          'fail',
          id,
          label,
          `No AWS credentials: ${d.credentialsError}`,
          'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or AWS_PROFILE, with ~/.aws mounted) in .env and run `make up`.',
        );
      if (d.bucketError !== null)
        return problem(
          'fail',
          id,
          label,
          `Bucket is not reachable: ${d.bucketError}`,
          'Check the bucket name, region and endpoint in Settings, and that the credentials may list and read the bucket (s3:ListBucket, s3:GetObject).',
        );
      return ok(id, label, 'Credentials found and the bucket is reachable');
    }),
  );
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
      'Mounting a folder does not choose it. Finish step 3 of the setup wizard: it uses the folder at /repos/skills (set by INTROSPECT_SKILLS_REPO in .env), or creates a repository there when the folder is empty.',
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
  const label = `Judge (${judge.fake ? 'fake' : judge.transport})`;
  if (judge.fake)
    return problem(
      'warn',
      'judge',
      label,
      'INTROSPECT_JUDGE=fake is set: grades come from the test-only fake judge',
      'Unset INTROSPECT_JUDGE and run `make up` to grade with a real model.',
    );
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
  if (!found)
    return problem(
      'warn',
      'judge',
      label,
      'The claude CLI is not installed',
      'Use the Docker image (it ships the CLI), or install `claude` and run `introspect judge-login`; or switch the judge to the API transport in Settings.',
    );
  if (!judge.cli.loginPresent)
    return problem(
      'warn',
      'judge',
      label,
      `The judge has no Claude login of its own in ${judge.cli.home}. It never uses your host login: a second client of the same login can rotate its refresh token and sign you out.`,
      "Run `make claude-login` (Docker) or `introspect judge-login` (native) and sign in once; the login stays in the judge's private home.",
    );
  if (judge.cli.isolationProblem)
    return problem(
      'fail',
      'judge',
      label,
      judge.cli.isolationProblem,
      'Set INTROSPECT_CLAUDE_HOME to a folder outside every agent-log source.',
    );
  return ok(
    'judge',
    label,
    "The claude CLI and the judge's own login are present; judge runs use a private home that no source reads",
  );
}

export function checkRedaction({ redactionEnabled }: DoctorInput): DoctorCheck {
  const label = 'Redaction';
  if (redactionEnabled) return ok('redaction', label, 'On: secrets are masked before storage');
  return problem(
    'warn',
    'redaction',
    label,
    'Redaction is off: new sessions are stored unredacted and are never sent to a judge',
    'Turn "Redact secrets" on in Settings; sessions stored while it was off are rebuilt from their log files and then become gradable.',
  );
}

export function checkRubrics({ rubricProblems, repos }: DoctorInput): DoctorCheck[] {
  if (rubricProblems.length === 0 || !repos.some((r) => r.kind === 'global')) return [];
  return [
    problem(
      'warn',
      'rubrics',
      'Rubric files',
      rubricProblems.join('; '),
      'Fix the frontmatter (name, scale, pass_threshold) of these files in rubrics/ of the skills repository.',
    ),
  ];
}

export function checkChangeScan({ scanWarnings }: DoctorInput): DoctorCheck[] {
  if (scanWarnings.length === 0) return [];
  return [
    problem(
      'warn',
      'change-scan',
      'Change tracking',
      scanWarnings.map((w) => w.warning).join('; '),
      'Edits in the span named above do not appear in the Trends change log. The warning goes away after the next scan that finds new commits; nothing else needs fixing unless the repository is damaged (`git fsck`).',
    ),
  ];
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

/**
 * Intake on or off, where it listens, and how many tokens can push. In a container the address the
 * port is published on (`INTROSPECT_INTAKE_BIND`, passed in by compose.yaml) decides who reaches it.
 */
export function checkIntake({ intake, env }: Pick<DoctorInput, 'intake' | 'env'>): DoctorCheck {
  const label = 'Session intake';
  if (!intake) return ok('intake', label, 'Off (INTROSPECT_INTAKE_PORT is not set)');
  const exposed = env.INTROSPECT_INTAKE_BIND ?? intake.host;
  const detail = `On, port ${String(intake.port)} on ${exposed}; ${String(intake.activeTokens)} active token(s)`;
  if (isLoopbackHost(exposed)) return ok('intake', label, detail);
  return problem(
    'warn',
    'intake',
    label,
    `${detail}; reachable from other machines`,
    'Put a TLS-terminating reverse proxy in front of the intake port, so tokens and session logs never cross the network in plain text.',
  );
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks = [
    checkData(input),
    ...checkSources(input),
    ...(await checkS3Sources(input)),
    checkWatcher(input),
    await checkSkillsRepo(input),
    await checkGitIdentity(input),
    await checkGh(input),
    await checkJudge(input),
    checkRedaction(input),
    ...checkRubrics(input),
    ...checkChangeScan(input),
    checkOwnership(input),
    checkClock(input),
    checkIntake(input),
  ].filter((c): c is DoctorCheck => c !== null);
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
