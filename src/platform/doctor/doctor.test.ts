/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkData,
  checkGh,
  checkGitIdentity,
  checkJudge,
  checkOwnership,
  checkRedaction,
  checkSkillsRepo,
  checkSources,
  checkWatcher,
  formatReport,
  hasFailure,
  runDoctor,
  type DoctorInput,
} from './index.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'introspect-doctor-'));
const missingProgram = () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }));

const judge = (over: Partial<DoctorInput['judge']> = {}): DoctorInput['judge'] => ({
  transport: 'api',
  keySet: true,
  fake: false,
  cli: {
    home: '/data/claude-home',
    loginPresent: true,
    isolationProblem: null,
  },
  ...over,
});

function input(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    dataDir: tmp(),
    watchPoll: true,
    redactionEnabled: true,
    db: {},
    sources: [],
    repos: [],
    rubricProblems: [],
    judge: judge(),
    env: {},
    uid: process.getuid?.(),
    run: missingProgram,
    ...over,
  };
}

function gitRepo(withRubrics = false): string {
  const dir = tmp();
  execFileSync('git', ['init', '-q', dir]);
  return withRubrics ? (mkdirSync(join(dir, 'rubrics')), dir) : dir;
}

describe('data check', () => {
  it('passes for a writable folder and a usable database', () => {
    expect(checkData(input()).status).toBe('ok');
  });
  it('fails when the database is unusable, with a fix', () => {
    const c = checkData(input({ db: { error: 'no such table: setting' } }));
    expect(c).toMatchObject({ status: 'fail' });
    expect(c.fix).toContain('make up');
  });
  it('fails for a missing data folder and names UID/GID', () => {
    const c = checkData(input({ dataDir: join(tmp(), 'absent') }));
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('UID');
  });
});

describe('sources check', () => {
  it('warns when nothing is registered', () => {
    expect(checkSources(input())[0]?.status).toBe('warn');
  });
  it('is ok for a readable folder and fails for a missing mount, naming the volume line', () => {
    const checks = checkSources(
      input({
        sources: [
          { agent: 'claude_code', path: tmp(), enabled: true },
          { agent: 'claude_code', path: '/sources/claude/projects', enabled: true },
          { agent: 'codex', path: '/sources/codex/sessions', enabled: false },
        ],
      }),
    );
    expect(checks.map((c) => c.status)).toEqual(['ok', 'fail']);
    expect(checks[1]?.fix).toContain('/sources/claude/projects:ro');
  });
});

describe('watcher check', () => {
  it('reports the mode', () => {
    expect(checkWatcher(input({ watchPoll: true })).detail).toMatch(/Polling/);
    expect(checkWatcher(input({ watchPoll: false })).detail).toMatch(/Native/);
  });
});

describe('skills repo check', () => {
  const global = (path: string, hasRubrics: boolean) => [
    { kind: 'global' as const, path, hasRubrics },
  ];
  it('warns when unset', async () => {
    expect((await checkSkillsRepo(input())).status).toBe('warn');
  });
  it('fails for a missing path, naming the env var', async () => {
    const c = await checkSkillsRepo(input({ repos: global('/repos/skills', false) }));
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('INTROSPECT_SKILLS_REPO');
  });
  it('fails when the folder is not a git work tree', async () => {
    expect((await checkSkillsRepo(input({ repos: global(tmp(), false) }))).status).toBe('fail');
  });
  it('warns without rubrics and passes with them', async () => {
    const repo = gitRepo(true);
    expect((await checkSkillsRepo(input({ repos: global(repo, false) }))).status).toBe('warn');
    expect((await checkSkillsRepo(input({ repos: global(repo, true) }))).status).toBe('ok');
  });
  it.skipIf(process.getuid?.() === 0)('fails when read-only', async () => {
    const repo = gitRepo();
    chmodSync(repo, 0o555);
    expect((await checkSkillsRepo(input({ repos: global(repo, true) }))).detail).toMatch(
      /read-only/,
    );
    chmodSync(repo, 0o755);
  });
});

describe('git identity check', () => {
  it('accepts env vars', async () => {
    const env = { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com' };
    expect((await checkGitIdentity(input({ env }))).detail).toBe('Ada <ada@example.com>');
  });
  it('accepts git config', async () => {
    const run = (_: string, args: string[]) =>
      Promise.resolve(args.includes('user.name') ? 'Ada' : 'ada@example.com');
    expect((await checkGitIdentity(input({ run }))).status).toBe('ok');
  });
  it('warns and names the env vars when missing or empty', async () => {
    const c = await checkGitIdentity(input({ env: { GIT_AUTHOR_NAME: ' ' } }));
    expect(c.status).toBe('warn');
    expect(c.fix).toContain('GIT_AUTHOR_NAME');
  });
});

describe('gh check', () => {
  it('is ok with a token, or when gh is authenticated', async () => {
    expect((await checkGh(input({ env: { GH_TOKEN: 'x' } }))).status).toBe('ok');
    expect((await checkGh(input({ run: () => Promise.resolve('') }))).status).toBe('ok');
  });
  it('only ever warns', async () => {
    expect(await checkGh(input())).toMatchObject({ status: 'warn', detail: 'gh is not installed' });
    const unauth = () => Promise.reject(new Error('not logged in'));
    expect((await checkGh(input({ run: unauth }))).detail).toBe('gh is not authenticated');
  });
});

describe('judge check', () => {
  it('needs a key for the api transport', async () => {
    expect((await checkJudge(input())).status).toBe('ok');
    expect((await checkJudge(input({ judge: judge({ keySet: false }) }))).status).toBe('warn');
  });
  it('needs the claude binary, a login and an isolated home for the cli transport', async () => {
    const cli = judge({ transport: 'cli', keySet: false });
    const found = () => Promise.resolve('2.1.0');
    expect((await checkJudge(input({ judge: cli }))).status).toBe('warn');
    expect((await checkJudge(input({ judge: cli, run: found }))).status).toBe('ok');
    const noLogin = judge({
      transport: 'cli',
      cli: { home: '/x', loginPresent: false, isolationProblem: null },
    });
    const missing = await checkJudge(input({ judge: noLogin, run: found }));
    expect(missing).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('never uses your host login'),
      fix: expect.stringContaining('make claude-login'),
    });
    const overlapping = judge({
      transport: 'cli',
      cli: { home: '/x', loginPresent: true, isolationProblem: '/a overlaps /b' },
    });
    expect((await checkJudge(input({ judge: overlapping, run: found }))).status).toBe('fail');
  });
  it('warns when the fake judge is active', async () => {
    expect((await checkJudge(input({ judge: judge({ fake: true }) }))).status).toBe('warn');
  });
});

describe('redaction check', () => {
  it('warns when redaction is off and says what that means for grading', () => {
    expect(checkRedaction(input()).status).toBe('ok');
    expect(checkRedaction(input({ redactionEnabled: false }))).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('never sent to a judge'),
    });
  });
});

describe('ownership check', () => {
  it('passes for folders owned by the running uid', () => {
    expect(
      checkOwnership(input({ repos: [{ kind: 'global', path: tmp(), hasRubrics: false }] })).status,
    ).toBe('ok');
  });
  it('warns about folders owned by another uid', () => {
    const c = checkOwnership(
      input({
        uid: (process.getuid?.() ?? 0) + 1,
        repos: [{ kind: 'global', path: tmp(), hasRubrics: false }],
      }),
    );
    expect(c.status).toBe('warn');
    expect(c.fix).toContain('UID');
  });
});

describe('report', () => {
  it('exits non-zero only on a failure and prints status, label, detail and fix', async () => {
    const good = await runDoctor(input());
    expect(hasFailure(good)).toBe(false);
    const bad = await runDoctor(input({ db: { error: 'boom' } }));
    expect(hasFailure(bad)).toBe(true);
    expect(formatReport(bad)).toMatch(
      /^FAIL {2}Data folder and database: Database unusable: boom\n {6}fix: /m,
    );
  });
});
