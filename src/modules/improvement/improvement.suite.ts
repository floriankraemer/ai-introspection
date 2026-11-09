/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InsertQueryNode, type KyselyPlugin } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../platform/db/ids.js';
import { fromJson } from '../../platform/db/json.js';
import { ConflictError, InvalidInputError } from '../../platform/errors.js';
import { initRepo } from '../../platform/git/index.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import { createScheduler } from '../../platform/jobs/scheduler.js';
import { PLANTED, SECRETS, writeFixtureSources } from '../../platform/testkit/agent-fixtures.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import { createFakeJudge, createGrading, type Grading } from '../grading/index.js';
import { createIngest, createRedactor, type IngestService } from '../ingest/index.js';
import { copyStarterRubrics, createRubrics } from '../rubrics/index.js';
import { createSecretStore, createSettings, type SettingsService } from '../settings/index.js';
import {
  createFakeImprover,
  createImprovement,
  createSkillRepos,
  IMPROVER_MODEL,
  ImproverCallError,
  type Improvement,
  type ImprovementDeps,
  type Improver,
  type SkillRepos,
} from './index.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A fake `gh`; `dir` holds its switches (`unauth`, `failclose`) and its call log (`calls`). The server gives gh a minimal environment, so nothing is passed by variable. */
const fakeGh = (dir: string): string => `#!/bin/sh
echo "$@" >> "${dir}/calls"
case "$1 $2" in
  "auth status") [ -f "${dir}/unauth" ] && { echo "not logged in" >&2; exit 1; }; exit 0 ;;
  "pr create") echo "https://github.com/example/skills/pull/7"; exit 0 ;;
  "pr view") echo '{"state":"MERGED","mergedAt":"2026-11-09T10:00:00Z"}'; exit 0 ;;
  "pr close") [ -f "${dir}/failclose" ] && { echo "GraphQL: could not close" >&2; exit 1; }; exit 0 ;;
esac
exit 2
`;

export function improvementSuite(name: string, make: TestDbFactory): void {
  describe(`improvement (${name})`, () => {
    let t: TestDb;
    let dir: string;
    let dataDir: string;
    let skills: string;
    let projects: string;
    let ingest: IngestService;
    let settings: SettingsService;
    let grading: Grading;
    let skillRepos: SkillRepos;
    let improvement: Improvement;
    let improver: Improver & { calls?: unknown[] };
    let hasSecret: (text: string) => Promise<boolean>;
    let redactText: NonNullable<ImprovementDeps['redact']>;
    let clock: () => Date;
    let sessionId: string;
    let env: NodeJS.ProcessEnv;
    const queue = () => createJobQueue(t.handle);

    const build = (extra: Partial<ImprovementDeps> = {}): void => {
      improvement = createImprovement({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        dataDir,
        settings,
        queue: queue(),
        skillRepos,
        ingest,
        grading,
        improvers: { current: () => Promise.resolve(improver) },
        hasSecret: (text) => hasSecret(text),
        redact: (text) => redactText(text),
        now: () => clock(),
        env,
        ...extra,
      });
    };

    /** Ten labelled sessions, eight agreeing: the rubric passes the calibration gate. */
    async function trust(rubricName: string): Promise<void> {
      const rubric = await createRubrics({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        repoPath: () => Promise.resolve(skills),
        cacheMs: 0,
      }).get(rubricName);
      if (!rubric) throw new Error('missing rubric');
      for (let i = 0; i < 10; i += 1) {
        const id = newId();
        await t.handle.db
          .insertInto('session')
          .values({
            id,
            workspace_id: LOCAL_WORKSPACE_ID,
            user_id: LOCAL_USER_ID,
            agent: 'claude_code',
            native_id: `n-${rubricName}-${String(i)}`,
            status: 'ended',
            created_at: new Date().toISOString(),
          })
          .execute();
        await t.handle.db
          .insertInto('grade')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            session_id: id,
            rubric_id: rubric.id,
            rubric_version: rubric.version,
            score: 1,
            passed: true,
            reason: 'ok',
            evidence_event_ids: '[]',
            judge_model: 'fake-judge',
            transport: 'fake',
            graded_at: new Date().toISOString(),
          })
          .execute();
        await grading.calibration.setLabel(rubricName, { sessionId: id, passed: i < 8 });
      }
    }

    const open = async () =>
      (await improvement.proposals.list({ status: 'open', limit: 50 })).items;

    beforeEach(async () => {
      t = await make();
      dir = mkdtempSync(join(tmpdir(), 'introspect-improve-'));
      dataDir = join(dir, 'data');
      const sources = writeFixtureSources(dir);
      const settingsSvc = createSettings(
        t.handle.db,
        LOCAL_WORKSPACE_ID,
        createSecretStore(dataDir),
      );
      settings = settingsSvc;
      ingest = createIngest({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        dataDir,
        settings,
        queue: queue(),
        pollMode: false,
      });
      await ingest.sources.add('claude_code', sources.claude);
      await ingest.importAll();
      sessionId = (
        await t.handle.db
          .selectFrom('session')
          .select('id')
          .where('agent', '=', 'claude_code')
          .executeTakeFirstOrThrow()
      ).id;

      skills = join(dir, 'skills');
      projects = join(dir, 'projects');
      mkdirSync(skills, { recursive: true });
      mkdirSync(projects, { recursive: true });
      await initRepo(skills);
      writeFileSync(join(skills, 'CLAUDE.md'), '# Global instructions\n');
      git(skills, 'add', '-A');
      await copyStarterRubrics(skills);
      git(
        skills,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-qm',
        'init',
        '--allow-empty',
      );
      skillRepos = createSkillRepos(t.handle.db, LOCAL_WORKSPACE_ID, {
        projectRoots: [projects],
      });
      await skillRepos.putGlobal(skills);

      const rubrics = createRubrics({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        repoPath: () => Promise.resolve(skills),
        cacheMs: 0,
      });
      const judge = createFakeJudge();
      grading = createGrading({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        settings,
        queue: queue(),
        ingest,
        rubrics,
        judges: { current: () => Promise.resolve(judge) },
        timeZone: 'UTC',
      });
      await grading.gradeNow({ sessionIds: [sessionId], policy: false });
      await trust('efficiency');

      improver = createFakeImprover();
      const redactor = createRedactor({ key: Buffer.alloc(32, 7) });
      hasSecret = (text) => {
        const r = redactor.redact(text);
        return Promise.resolve(r.failed || r.count > 0);
      };
      redactText = (text) => Promise.resolve(redactor.redact(text));
      clock = () => new Date();
      env = { GH_TOKEN: undefined };
      build();
    });
    afterEach(async () => {
      await t.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    describe('a run', () => {
      it('proposes on a branch in a worktree, leaves the working tree and no worktree behind, and reports untrusted rubrics', async () => {
        const result = await improvement.run(new Date(0));
        expect(result.status).toBe('succeeded');
        expect(result.proposalsCreated).toBe(1);
        expect(result.summary.untrustedExcluded.map((u) => u.rubric).sort()).toEqual([
          'redundant-tests',
          'silent-workaround',
          'verbosity',
        ]);
        const [p] = await open();
        expect(p).toMatchObject({
          status: 'open',
          rubric: 'efficiency',
          targetPaths: ['CLAUDE.md'],
          targetRepo: { kind: 'global' },
          acceptMode: 'merge',
        });
        expect(p?.branch).toMatch(/^introspect\/[a-z0-9-]+-[0-9a-f]{8}$/);
        expect(p?.evidenceSessionIds).toEqual([sessionId]);
        expect(p?.diff).toContain('+- ');
        expect(p?.cluster?.reasons.length).toBeGreaterThan(0);
        // The user's tree: still on main, clean, CLAUDE.md untouched.
        expect(git(skills, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
        expect(git(skills, 'status', '--porcelain')).toBe('');
        expect(readFileSync(join(skills, 'CLAUDE.md'), 'utf8')).toBe('# Global instructions\n');
        // Worktree cleaned up, branch kept.
        expect(git(skills, 'worktree', 'list').split('\n')).toHaveLength(1);
        expect(existsSync(join(dataDir, 'worktrees', result.runId))).toBe(false);
        expect(git(skills, 'branch', '--list', p?.branch ?? '')).toContain('introspect/');
      });

      it('books the call on the shared ledger and reports it apart in the budget', async () => {
        await improvement.run(new Date(0));
        const rows = await t.handle.db
          .selectFrom('llm_call')
          .select(['purpose', 'status'])
          .where('purpose', '=', 'improve')
          .execute();
        expect(rows).toEqual([{ purpose: 'improve', status: 'ok' }]);
        const status = await grading.budget.status();
        expect(status.improver.tokensToday).toBeGreaterThan(0);
        expect(status.tokensToday).toBeGreaterThanOrEqual(status.improver.tokensToday);
      });

      it('does not propose twice for sessions an open proposal already covers', async () => {
        await improvement.run(new Date(0));
        const second = await improvement.run(new Date(0));
        expect(second.proposalsCreated).toBe(0);
        expect(second.summary.clusters[0]?.detail).toMatch(/already covers/);
        expect(await open()).toHaveLength(1);
      });

      it('does not propose again for sessions an accepted or rejected proposal covered', async () => {
        await improvement.run(new Date(0));
        const [p] = await open();
        await improvement.proposals.accept(p?.id ?? '');
        const again = await improvement.run(new Date(0));
        expect(again.proposalsCreated).toBe(0);
        expect(await open()).toHaveLength(0);
      });

      it('never sends a session that is not redacted with the current rules', async () => {
        await t.handle.db.updateTable('session').set({ redaction_version: 'off' }).execute();
        const result = await improvement.run(new Date(0));
        expect(result.proposalsCreated).toBe(0);
        expect(result.summary.skippedSessions).toEqual([{ sessionId, reason: 'redaction is off' }]);
        expect(improver.calls).toHaveLength(0);
      });

      it('stops at the budget, defers, and writes no proposal', async () => {
        await settings.update({ 'budget.tokens_per_day': 40_000 });
        // 30k tokens are already spent today; the improver's reservation (a full 16k answer) no longer fits.
        await t.handle.db
          .insertInto('llm_call')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            at: new Date().toISOString(),
            purpose: 'grade',
            model: 'm',
            transport: 'fake',
            tokens_in: 30_000,
          })
          .execute();
        const result = await improvement.run(new Date(0));
        expect(result.deferUntil).not.toBeNull();
        expect(result.status).toBe('partial');
        expect(await open()).toHaveLength(0);
        expect(improver.calls).toHaveLength(0);
      });

      it('targets a registered project repository and keeps changes inside its allow-list', async () => {
        const project = join(projects, 'webapp');
        mkdirSync(project);
        await initRepo(project);
        mkdirSync(join(project, 'src'));
        writeFileSync(join(project, 'src', 'app.ts'), 'export {};\n');
        writeFileSync(join(project, 'CLAUDE.md'), '# Project\n');
        git(project, 'add', '-A');
        git(project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
        const registered = await skillRepos.registerProject(project);
        // The session recorded a host path; only the folder name matches the mounted repository.
        await t.handle.db
          .updateTable('session')
          .set({ repo_root: '/home/dev/code/webapp' })
          .execute();
        await improvement.run(new Date(0));
        const [p] = await open();
        expect(p?.targetRepo).toMatchObject({ id: registered.id, kind: 'project' });
        expect(p?.targetPaths).toEqual(['CLAUDE.md']);
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');

        // Source code is outside the project allow-list.
        improver = createFakeImprover(() => ({
          kind: 'proposal',
          title: 'Touch source',
          rationale: 'x',
          edits: [{ path: 'src/app.ts', content: 'export const x = 1;\n' }],
          model: 'm',
          usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        }));
        build();
        await t.handle.db.deleteFrom('proposal').execute();
        await improvement.run(new Date(0));
        const failed = await improvement.proposals.list({ status: 'failed', limit: 10 });
        expect(failed.items[0]?.decisionNote).toMatch(/outside the allowed paths/);
        expect(failed.items[0]?.validation.ok).toBe(false);
        expect(
          git(project, 'branch', '--list', 'introspect/*').split('\n').length,
        ).toBeLessThanOrEqual(1);
      });
    });

    describe('diff validation of an improver result', () => {
      const edit = (path: string, content = 'x\n'): Improver =>
        createFakeImprover(() => ({
          kind: 'proposal',
          title: 'Bad change',
          rationale: 'r',
          edits: [{ path, content }],
          model: 'm',
          usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        }));

      it.each([
        ['rubrics/efficiency.md', /never allowed/],
        ['RUBRICS/new.md', /never allowed/],
        ['../outside.md', /not a plain relative path/],
        ['skills/../../x.md', /not a plain relative path/],
        ['/etc/passwd', /not a plain relative path/],
        ['.git/hooks/pre-commit', /never allowed|\.git/],
      ])('refuses %s', async (path, reason) => {
        improver = edit(path);
        build();
        const result = await improvement.run(new Date(0));
        expect(result.proposalsCreated).toBe(0);
        const failed = await improvement.proposals.list({ status: 'failed', limit: 5 });
        expect(failed.items[0]?.decisionNote).toMatch(reason);
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');
        expect(git(skills, 'status', '--porcelain')).toBe('');
      });

      it('refuses a diff that adds a secret, with the same rules as ingest', async () => {
        improver = edit('CLAUDE.md', `# x\nkey = ${SECRETS.github}\n`);
        build();
        await improvement.run(new Date(0));
        const failed = await improvement.proposals.list({ status: 'failed', limit: 5 });
        expect(failed.items[0]?.decisionNote).toMatch(/secret/);
        // The refused diff is not stored: no column of any table holds the planted token.
        const stored = JSON.stringify([
          await t.handle.db.selectFrom('proposal').selectAll().execute(),
          await t.handle.db.selectFrom('cluster_outcome').selectAll().execute(),
          await t.handle.db.selectFrom('improver_run').selectAll().execute(),
        ]);
        for (const planted of PLANTED) expect(stored).not.toContain(planted);
        expect(failed.items[0]?.diff).toBe('');
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');
      });

      it('refuses more than 5 files', async () => {
        improver = createFakeImprover(() => ({
          kind: 'proposal',
          title: 'Many',
          rationale: 'r',
          edits: Array.from({ length: 6 }, (_, i) => ({
            path: `skills/s${String(i)}.md`,
            content: 'x\n',
          })),
          model: 'm',
          usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        }));
        build();
        await improvement.run(new Date(0));
        const failed = await improvement.proposals.list({ status: 'failed', limit: 5 });
        expect(failed.items[0]?.decisionNote).toMatch(/6 files/);
      });

      it('records a decline as a skipped cluster, not a proposal', async () => {
        improver = createFakeImprover(() => ({
          kind: 'none',
          reason: 'one-off mistake',
          model: 'm',
          usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        }));
        build();
        const result = await improvement.run(new Date(0));
        expect(result.summary.clusters[0]).toMatchObject({
          outcome: 'declined',
          detail: 'one-off mistake',
        });
        expect(await open()).toHaveLength(0);
      });
    });

    describe('accept in merge mode', () => {
      beforeEach(async () => {
        await improvement.run(new Date(0));
      });

      it('merges with --no-ff, deletes the branch and writes a change event', async () => {
        const [p] = await open();
        const accepted = await improvement.proposals.accept(p?.id ?? '');
        expect(accepted.status).toBe('accepted');
        expect(accepted.mergeCommit).toBe(git(skills, 'rev-parse', 'HEAD'));
        expect(git(skills, 'log', '--merges', '--format=%s')).toContain('Merge proposal:');
        expect(readFileSync(join(skills, 'CLAUDE.md'), 'utf8')).toContain('## Avoid: efficiency');
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');
        const events = await t.handle.db.selectFrom('change_event').selectAll().execute();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          kind: 'proposal_merged',
          proposal_id: p?.id,
          description: p?.title,
        });
        expect(fromJson(events[0]?.files)).toEqual(['CLAUDE.md']);
        expect(fromJson(events[0]?.rubric_names)).toEqual(['efficiency']);
        await expect(improvement.proposals.accept(p?.id ?? '')).rejects.toBeInstanceOf(
          ConflictError,
        );
      });

      it('answers 409 with a fix when the working tree is dirty, and leaves the proposal open', async () => {
        writeFileSync(join(skills, 'CLAUDE.md'), '# edited by hand\n');
        const [p] = await open();
        const err = await improvement.proposals.accept(p?.id ?? '').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toMatch(/uncommitted changes/);
        expect((err as ConflictError).fix).toMatch(/PR mode/);
        expect((await improvement.proposals.get(p?.id ?? ''))?.status).toBe('open');
        expect(await t.handle.db.selectFrom('change_event').selectAll().execute()).toHaveLength(0);
      });

      it('answers 409 when another branch is checked out', async () => {
        git(skills, 'checkout', '-q', '-b', 'wip');
        const [p] = await open();
        await expect(improvement.proposals.accept(p?.id ?? '')).rejects.toThrow(
          /"wip" checked out/,
        );
      });

      it('marks a conflicting merge as conflict and leaves the repository clean', async () => {
        writeFileSync(
          join(skills, 'CLAUDE.md'),
          '# Global instructions\n\n## Avoid: efficiency\n\nother text\n',
        );
        git(
          skills,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '-qam',
          'conflicting edit',
        );
        const [p] = await open();
        await expect(improvement.proposals.accept(p?.id ?? '')).rejects.toThrow(/conflicts/);
        expect((await improvement.proposals.get(p?.id ?? ''))?.status).toBe('conflict');
        expect(git(skills, 'status', '--porcelain')).toBe('');
      });

      it('rejects with a reason and deletes the branch', async () => {
        const [p] = await open();
        const rejected = await improvement.proposals.reject(p?.id ?? '', 'not useful');
        expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'not useful' });
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');
        expect(await t.handle.db.selectFrom('change_event').selectAll().execute()).toHaveLength(0);
      });

      it('counts open proposals for the nav badge', async () => {
        const list = await improvement.proposals.list({ status: 'open', limit: 10 });
        expect(list.total).toBe(1);
        expect(list.counts).toMatchObject({ open: 1, accepted: 0 });
      });
    });

    describe('edit first', () => {
      beforeEach(async () => {
        await improvement.run(new Date(0));
      });
      const diffFor = (extra: string) =>
        `diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1,2 @@\n # Global instructions\n+${extra}\n`;

      it('amends the branch with a validated human diff', async () => {
        const [p] = await open();
        const edited = await improvement.proposals.edit(p?.id ?? '', diffFor('Run tests once.'));
        expect(edited.headSha).not.toBe(p?.headSha);
        expect(edited.diff).toContain('+Run tests once.');
        expect(git(skills, 'show', `${edited.branch ?? ''}:CLAUDE.md`)).toContain(
          'Run tests once.',
        );
        expect(git(skills, 'worktree', 'list').split('\n')).toHaveLength(1);
        const accepted = await improvement.proposals.accept(p?.id ?? '');
        expect(accepted.status).toBe('accepted');
        expect(readFileSync(join(skills, 'CLAUDE.md'), 'utf8')).toContain('Run tests once.');
      });

      it('refuses rubrics/, secrets and diffs that do not apply, and keeps the branch as it was', async () => {
        const [p] = await open();
        const rubricDiff = `diff --git a/rubrics/efficiency.md b/rubrics/efficiency.md\n--- a/rubrics/efficiency.md\n+++ b/rubrics/efficiency.md\n@@ -1 +1 @@\n-a\n+b\n`;
        await expect(improvement.proposals.edit(p?.id ?? '', rubricDiff)).rejects.toBeInstanceOf(
          InvalidInputError,
        );
        await expect(
          improvement.proposals.edit(p?.id ?? '', diffFor(`token ${SECRETS.github}`)),
        ).rejects.toThrow(/secret/);
        const stale = diffFor('x').replace('# Global instructions', '# Something else');
        await expect(improvement.proposals.edit(p?.id ?? '', stale)).rejects.toThrow(
          /does not apply/,
        );
        const after = await improvement.proposals.get(p?.id ?? '');
        expect(after?.headSha).toBe(p?.headSha);
        expect(git(skills, 'rev-parse', after?.branch ?? '')).toBe(p?.headSha);
      });
    });

    describe('accept in PR mode', () => {
      let bin: string;
      let oldPath: string | undefined;
      beforeEach(async () => {
        bin = join(dir, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'gh'), fakeGh(bin));
        chmodSync(join(bin, 'gh'), 0o755);
        oldPath = process.env.PATH;
        process.env.PATH = `${bin}:${oldPath ?? ''}`;
        const remote = join(dir, 'remote.git');
        git(dir, 'init', '-q', '--bare', remote);
        git(skills, 'remote', 'add', 'origin', remote);
        await settings.update({ 'proposals.accept_mode': 'pr' });
        await improvement.run(new Date(0));
      });
      afterEach(() => {
        process.env.PATH = oldPath;
      });

      it('pushes the branch, opens a PR, and records the change when the PR merges', async () => {
        const [p] = await open();
        expect(p?.acceptMode).toBe('pr');
        const pending = await improvement.proposals.accept(p?.id ?? '');
        expect(pending).toMatchObject({
          status: 'open',
          prUrl: 'https://github.com/example/skills/pull/7',
        });
        expect(git(join(dir, 'remote.git'), 'branch', '--list', 'introspect/*')).toContain(
          'introspect/',
        );
        expect(git(skills, 'status', '--porcelain')).toBe('');
        await expect(improvement.proposals.accept(p?.id ?? '')).rejects.toThrow(/already open/);
        expect(await t.handle.db.selectFrom('change_event').selectAll().execute()).toHaveLength(0);

        expect(await improvement.proposals.syncPullRequests()).toBe(1);
        expect((await improvement.proposals.get(p?.id ?? ''))?.status).toBe('accepted');
        const events = await t.handle.db.selectFrom('change_event').selectAll().execute();
        expect(events).toHaveLength(1);
        expect(events[0]?.at).toMatch(/^2026-11-09T10:00:00/);
      });

      it('answers 409 with a doctor-style fix when gh is not signed in', async () => {
        writeFileSync(join(bin, 'unauth'), '');
        const [p] = await open();
        const err = await improvement.proposals.accept(p?.id ?? '').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toMatch(/not signed in/);
        expect((err as ConflictError).fix).toMatch(/GH_TOKEN/);
      });

      it('pushes although the repository has a failing pre-push hook', async () => {
        const hook = join(skills, '.git', 'hooks', 'pre-push');
        writeFileSync(hook, `#!/bin/sh\ntouch "${join(dir, 'pushed-hook')}"\nexit 1\n`);
        chmodSync(hook, 0o755);
        const [p] = await open();
        expect((await improvement.proposals.accept(p?.id ?? '')).prUrl).toMatch(/pull\/7/);
        expect(existsSync(join(dir, 'pushed-hook'))).toBe(false);
      });

      it('closes the pull request with its branch when the proposal is rejected, and the poller ignores it', async () => {
        const [p] = await open();
        await improvement.proposals.accept(p?.id ?? '');
        const rejected = await improvement.proposals.reject(p?.id ?? '', 'not wanted');
        expect(rejected.status).toBe('rejected');
        expect(readFileSync(join(bin, 'calls'), 'utf8')).toContain(
          'pr close https://github.com/example/skills/pull/7 --delete-branch',
        );
        // The fake gh would answer MERGED to a view; a rejected proposal is not polled at all.
        expect(await improvement.proposals.syncPullRequests()).toBe(0);
        expect((await improvement.proposals.get(p?.id ?? ''))?.status).toBe('rejected');
        expect(await t.handle.db.selectFrom('change_event').selectAll().execute()).toHaveLength(0);
      });

      it('keeps the proposal open and says how to close the PR by hand when gh cannot', async () => {
        const [p] = await open();
        await improvement.proposals.accept(p?.id ?? '');
        writeFileSync(join(bin, 'failclose'), '');
        const err = await improvement.proposals.reject(p?.id ?? '', 'x').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toMatch(/Closing the pull request failed/);
        expect((err as ConflictError).fix).toMatch(/gh pr close .*pull\/7/);
        expect((await improvement.proposals.get(p?.id ?? ''))?.status).toBe('open');
      });

      it('lets a repository override the global accept mode', async () => {
        await skillRepos.update((await skillRepos.getGlobal())?.id ?? '', { acceptMode: 'merge' });
        const [p] = await open();
        expect(p?.acceptMode).toBe('merge');
        expect((await improvement.proposals.accept(p?.id ?? '')).status).toBe('accepted');
      });
    });

    describe('scheduling', () => {
      it('catches up a missed night once the schedule has state, and honours manual mode', async () => {
        const q = queue();
        const at = new Date('2026-11-09T07:00:00Z');
        const scheduler = createScheduler({
          handle: t.handle,
          queue: q,
          workspaceId: LOCAL_WORKSPACE_ID,
          schedules: improvement.schedules.filter((s) => s.name === 'improver'),
          now: () => at,
        });
        await t.handle.db
          .insertInto('schedule_state')
          .values({
            workspace_id: LOCAL_WORKSPACE_ID,
            name: 'improver',
            last_fired_period: '2026-11-05T06:00:00.000Z',
          })
          .execute();
        await scheduler.tick();
        await scheduler.tick();
        const jobs = await t.handle.db
          .selectFrom('job')
          .select('kind')
          .where('kind', '=', 'improve')
          .execute();
        expect(jobs).toHaveLength(1);

        await settings.update({ 'schedule.improver': 'manual' });
        const later = createScheduler({
          handle: t.handle,
          queue: q,
          workspaceId: LOCAL_WORKSPACE_ID,
          schedules: improvement.schedules.filter((s) => s.name === 'improver'),
          now: () => new Date('2026-11-12T07:00:00Z'),
        });
        await later.tick();
        expect(
          await t.handle.db.selectFrom('job').select('id').where('kind', '=', 'improve').execute(),
        ).toHaveLength(1);
      });

      it('runs a manual job through the handler and lists the run', async () => {
        const id = await improvement.enqueueRun('7d');
        const job = await queue().get(id);
        expect(job?.kind).toBe('improve');
        await improvement.handlers.improve?.run(job as never);
        const runs = await improvement.runs();
        expect(runs[0]).toMatchObject({
          status: 'succeeded',
          proposals: 1,
          untrustedRubrics: expect.any(Array),
        });
        expect(await improvement.schedule()).toMatchObject({ mode: 'daily' });
      });
    });

    /** A proposal on its own branch, as the improver would have left it, without running the improver. */
    async function seedProposal(files: Record<string, string>, title = 'Seeded'): Promise<string> {
      const id = newId();
      const branch = `introspect/seed-${id.slice(-8)}`;
      const base = git(skills, 'rev-parse', 'main');
      const wt = join(dir, `seed-${id.slice(-8)}`);
      git(skills, 'worktree', 'add', '-q', '-b', branch, wt, base);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(wt, path)), { recursive: true });
        writeFileSync(join(wt, path), content);
      }
      git(wt, 'add', '-A');
      git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', title);
      const head = git(wt, 'rev-parse', 'HEAD');
      git(skills, 'worktree', 'remove', '--force', wt);
      await t.handle.db
        .insertInto('proposal')
        .values({
          id,
          workspace_id: LOCAL_WORKSPACE_ID,
          title,
          target_repo_id: (await skillRepos.getGlobal())?.id ?? null,
          target_path: Object.keys(files)[0] ?? '',
          branch,
          base_sha: base,
          head_sha: head,
          diff: git(skills, 'diff', '--binary', base, head),
          rationale: 'seeded',
          evidence_session_ids: '[]',
          rubric_names: '["efficiency"]',
          created_at: new Date().toISOString(),
        })
        .execute();
      return id;
    }
    /** A row read from the database, ready to insert again (Postgres returns JSON columns parsed). */
    const asInsertable = <T extends object>(row: T): T =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
        ]),
      ) as T;
    const statusOf = async (id: string) => (await improvement.proposals.get(id))?.status;

    describe('edit first, hardened', () => {
      let proposalId: string;
      let headBefore: string;
      let rubricBefore: string;
      beforeEach(async () => {
        mkdirSync(join(skills, 'skills'), { recursive: true });
        writeFileSync(join(skills, 'skills', 'a.md'), '# A\n');
        symlinkSync('../rubrics', join(skills, 'skills', 'link'));
        symlinkSync('../rubrics/efficiency.md', join(skills, 'skills', 'rlink.md'));
        git(skills, 'add', '-A');
        git(skills, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'links');
        await improvement.run(new Date(0));
        const [p] = await open();
        proposalId = p?.id ?? '';
        headBefore = p?.headSha ?? '';
        rubricBefore = git(skills, 'show', 'main:rubrics/efficiency.md');
      });
      const firstLine = (): string => rubricBefore.split('\n')[0] ?? '';
      const plain = (path: string, old = '# A', add = 'pwned'): string =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n ${old}\n+${add}\n`;

      async function expectRefused(diff: string, reason: RegExp): Promise<void> {
        const err = await improvement.proposals.edit(proposalId, diff).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidInputError);
        expect((err as Error).message).toMatch(reason);
        const after = await improvement.proposals.get(proposalId);
        expect(after?.headSha).toBe(headBefore);
        expect(git(skills, 'rev-parse', after?.branch ?? '')).toBe(headBefore);
        expect(git(skills, 'show', `${after?.branch ?? ''}:rubrics/efficiency.md`)).toBe(
          rubricBefore,
        );
        expect(git(skills, 'branch', '--list', 'introspect-tmp/*')).toBe('');
        expect(git(skills, 'worktree', 'list').split('\n')).toHaveLength(1);
      }

      it('refuses a header with several " b/" that git would apply to rubrics/', async () => {
        const attack = `diff --git a/x b/rubrics/efficiency.md b/z\n--- a/rubrics/efficiency.md\n+++ b/rubrics/efficiency.md\n@@ -1 +1,2 @@\n ${firstLine()}\n+pwned\n`;
        await expectRefused(attack, /ambiguous|rubrics/);
      });

      it.each(['Rubrics/efficiency.md', 'RUBRICS/efficiency.md', '.git/config', '.GIT/config'])(
        'refuses %s',
        async (path) => {
          await expectRefused(plain(path, firstLine()), /never allowed|\.git/);
        },
      );

      it('refuses a path through an existing symlink into rubrics/', async () => {
        await expectRefused(plain('skills/link/efficiency.md', firstLine()), /.+/);
      });

      it('refuses to change a symlink itself', async () => {
        const d = `diff --git a/skills/rlink.md b/skills/rlink.md\nindex 1111111..2222222 120000\n--- a/skills/rlink.md\n+++ b/skills/rlink.md\n@@ -1 +1 @@\n-../rubrics/efficiency.md\n\\ No newline at end of file\n+../rubrics/verbosity.md\n\\ No newline at end of file\n`;
        await expectRefused(d, /symlink/);
      });

      it('refuses a directory as the target', async () => {
        const d = `diff --git a/skills b/skills\nnew file mode 100644\n--- /dev/null\n+++ b/skills\n@@ -0,0 +1 @@\n+x\n`;
        await expectRefused(d, /.+/);
      });

      it('answers 422 "diff changes nothing" when the result equals the base', async () => {
        const noop = `diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-# Global instructions\n+# Global instructions\n`;
        await expectRefused(noop, /diff changes nothing/);
      });

      it('refuses invisible characters and leaves the branch alone', async () => {
        await expectRefused(plain('CLAUDE.md', '# Global instructions', 'a‮b'), /invisible/);
      });

      it('refuses executable surfaces until the repository allows them, then warns', async () => {
        const script = `diff --git a/skills/run.sh b/skills/run.sh\nnew file mode 100644\n--- /dev/null\n+++ b/skills/run.sh\n@@ -0,0 +1 @@\n+echo hi\n`;
        await expectRefused(script, /execute/);
        const exe = `diff --git a/skills/a.md b/skills/a.md\nold mode 100644\nnew mode 100755\n`;
        await expectRefused(exe, /executable/);

        const repoId = (await skillRepos.getGlobal())?.id ?? '';
        expect(await skillRepos.update(repoId, { allowExecutable: true })).toMatchObject({
          allowExecutable: true,
        });
        const edited = await improvement.proposals.edit(proposalId, script);
        expect(edited.validation).toEqual({
          ok: true,
          problems: [],
          warnings: ['"skills/run.sh" changes a hook/settings file that Claude Code executes'],
        });
        expect((await improvement.proposals.get(proposalId))?.headSha).not.toBe(headBefore);
      });
    });

    describe('what an improver may propose', () => {
      const propose = (
        edits: { path: string; content: string }[],
        title = 'A change',
        rationale = 'r',
      ) => {
        improver = createFakeImprover(() => ({
          kind: 'proposal',
          title,
          rationale,
          edits,
          model: 'm',
          usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        }));
        build();
      };
      const lastFailure = async () =>
        (await improvement.proposals.list({ status: 'failed', limit: 5 })).items[0];

      it.each([
        ['skills/run.sh', /execute/],
        ['skills/tool.py', /execute/],
        ['hooks/pre-commit', /outside the allowed/],
        ['settings.json', /outside the allowed/],
        ['notes.md', /outside the allowed/],
      ])('refuses %s by default', async (path, reason) => {
        propose([{ path, content: 'x\n' }]);
        await improvement.run(new Date(0));
        expect((await lastFailure())?.decisionNote).toMatch(reason);
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');
      });

      it('proposes a hook only when the repository allows it, with a warning', async () => {
        const repoId = (await skillRepos.getGlobal())?.id ?? '';
        await skillRepos.update(repoId, { allowExecutable: true });
        propose([
          { path: 'hooks/pre-tool.sh', content: '#!/bin/sh\nexit 0\n' },
          { path: 'settings.json', content: '{"hooks":{}}\n' },
          { path: 'CLAUDE.md', content: '# Global instructions\n\nBe brief.\n' },
        ]);
        await improvement.run(new Date(0));
        const [p] = await open();
        expect(p?.validation.ok).toBe(true);
        expect(p?.validation.warnings).toEqual([
          '"hooks/pre-tool.sh" changes a hook/settings file that Claude Code executes',
          '"settings.json" changes a hook/settings file that Claude Code executes',
        ]);
      });

      it.each([
        ['an invisible character', 'x​y', /invisible/],
        ['a bidi override', 'x‮y', /invisible/],
        ['a tag character', 'x\u{E0041}y', /invisible/],
      ])('refuses %s in the new content', async (_n, body, reason) => {
        propose([{ path: 'CLAUDE.md', content: `# Global instructions\n${body}\n` }]);
        await improvement.run(new Date(0));
        expect((await lastFailure())?.decisionNote).toMatch(reason);
      });

      it('bounds the title and the rationale', async () => {
        propose([{ path: 'CLAUDE.md', content: 'x\n' }], 'T'.repeat(121));
        await improvement.run(new Date(0));
        expect((await lastFailure())?.decisionNote).toMatch(/title is longer than 120/);
        await t.handle.db.deleteFrom('cluster_outcome').execute();
        propose([{ path: 'CLAUDE.md', content: 'x\n' }], 'ok', 'R'.repeat(4001));
        await improvement.run(new Date(0));
        expect((await lastFailure())?.decisionNote).toMatch(/rationale is longer than 4000/);
      });

      it('scans the title and rationale for secrets and stores none of them', async () => {
        propose(
          [{ path: 'CLAUDE.md', content: '# Global instructions\n\nBe brief.\n' }],
          'Fix',
          `use ${SECRETS.github} to log in`,
        );
        await improvement.run(new Date(0));
        const failed = await lastFailure();
        expect(failed?.decisionNote).toMatch(/secret/);
        expect(failed?.title).toBe('Refused proposal');
        expect(failed?.rationale).toBe('');
        const stored = JSON.stringify([
          await t.handle.db.selectFrom('proposal').selectAll().execute(),
          await t.handle.db.selectFrom('cluster_outcome').selectAll().execute(),
        ]);
        expect(stored).not.toContain(SECRETS.github);
      });

      it('refuses edits that change nothing', async () => {
        propose([{ path: 'CLAUDE.md', content: '# Global instructions\n' }]);
        await improvement.run(new Date(0));
        expect((await lastFailure())?.decisionNote).toMatch(/diff changes nothing/);
      });

      it('deletes the branch and worktree when the proposal row cannot be written', async () => {
        const failInsert: KyselyPlugin = {
          transformQuery: ({ node }) => {
            if (InsertQueryNode.is(node) && node.into?.table.identifier.name === 'proposal')
              throw new Error('disk full');
            return node;
          },
          transformResult: (a) => Promise.resolve(a.result),
        };
        build({ db: t.handle.db.withPlugin(failInsert) });
        const result = await improvement.run(new Date(0));
        expect(result.summary.clusters[0]).toMatchObject({
          outcome: 'failed',
          detail: 'disk full',
        });
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');
        expect(git(skills, 'worktree', 'list').split('\n')).toHaveLength(1);
      });
    });

    describe('files sent to the improver', () => {
      it('are redacted, and a file that is mostly secrets is left out', async () => {
        writeFileSync(
          join(skills, 'CLAUDE.md'),
          `# Global instructions\n\nline 2\nline 3\nline 4\nkey = ${SECRETS.github}\n`,
        );
        mkdirSync(join(skills, 'skills'), { recursive: true });
        writeFileSync(
          join(skills, 'skills', 'creds.md'),
          `a = ${SECRETS.github}\nb = ${SECRETS.aws}\nc = ${SECRETS.npm}\n`,
        );
        git(skills, 'add', '-A');
        git(skills, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'secrets');
        await improvement.run(new Date(0));
        const sent = (improver.calls?.[0] as { files: Record<string, string> }).files;
        expect(Object.keys(sent)).toEqual(['CLAUDE.md']);
        expect(sent['CLAUDE.md']).toContain('[REDACTED:');
        expect(JSON.stringify(sent)).not.toContain(SECRETS.github);
      });
    });

    describe('billing and dedupe', () => {
      const usage = { input: 5_000, cacheRead: 0, cacheWrite: 0, output: 16_000 };
      const ledger = () =>
        t.handle.db
          .selectFrom('llm_call')
          .select(['status', 'tokens_in', 'tokens_out'])
          .where('purpose', '=', 'improve')
          .execute();

      it('bills a response that ran out of tokens or turns, and does not retry the cluster tomorrow', async () => {
        const failing = createFakeImprover(() => {
          throw new ImproverCallError('The improver ran out of output tokens', usage, 'm');
        });
        improver = failing;
        build();
        const first = await improvement.run(new Date(0));
        expect(first.summary.clusters[0]).toMatchObject({ outcome: 'failed' });
        expect(await ledger()).toEqual([{ status: 'error', tokens_in: 5_000, tokens_out: 16_000 }]);
        const second = await improvement.run(new Date(0));
        expect(second.summary.clusters[0]?.detail).toMatch(/failed on .* for these same sessions/);
        expect(failing.calls).toHaveLength(1);
        expect(await ledger()).toHaveLength(1);
      });

      it('records a budget stop as a decline that is billed', async () => {
        improver = createFakeImprover(() => ({
          kind: 'none',
          reason: 'budget: stopped after 3 turns',
          budget: true,
          model: 'm',
          usage,
        }));
        build();
        const result = await improvement.run(new Date(0));
        expect(result.summary.clusters[0]).toMatchObject({ outcome: 'declined' });
        expect(await ledger()).toEqual([{ status: 'ok', tokens_in: 5_000, tokens_out: 16_000 }]);
      });

      it('passes the reservation to the improver as its token cap', async () => {
        await improvement.run(new Date(0));
        const cap = (improver.calls?.[0] as { tokenCap?: number }).tokenCap ?? 0;
        expect(cap).toBeGreaterThan(16_000);
      });

      it('does not bill a declined cluster again within 7 days, but does after, and when sessions join', async () => {
        improver = createFakeImprover(() => ({
          kind: 'none',
          reason: 'one-off',
          model: 'm',
          usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        }));
        build();
        await improvement.run(new Date(0));
        const again = await improvement.run(new Date(0));
        expect(again.summary.clusters[0]).toMatchObject({ outcome: 'skipped' });
        expect(again.summary.clusters[0]?.detail).toMatch(/declined on .* same sessions/);
        expect(improver.calls).toHaveLength(1);

        // A new failing session changes the cluster: it is looked at again.
        const original = await t.handle.db
          .selectFrom('session')
          .selectAll()
          .where('id', '=', sessionId)
          .executeTakeFirstOrThrow();
        const copy = newId();
        await t.handle.db
          .insertInto('session')
          .values({ ...asInsertable(original), id: copy, native_id: 'n-copy' })
          .execute();
        const grades = await t.handle.db
          .selectFrom('grade')
          .selectAll()
          .where('session_id', '=', sessionId)
          .execute();
        for (const g of grades)
          await t.handle.db
            .insertInto('grade')
            .values({ ...asInsertable(g), id: newId(), session_id: copy })
            .execute();
        await improvement.run(new Date(0));
        expect(improver.calls).toHaveLength(2);
        await t.handle.db.deleteFrom('grade').where('session_id', '=', copy).execute();
        await t.handle.db.deleteFrom('session').where('id', '=', copy).execute();

        // After the window the original cluster is tried again.
        clock = () => new Date(Date.now() + 8 * 86_400_000);
        await improvement.run(new Date(0));
        expect(improver.calls).toHaveLength(3);
      });
    });

    describe('accept, reject and edit take turns', () => {
      it('serialises concurrent accepts of two proposals on one repository', async () => {
        const a = await seedProposal({ 'skills/a.md': '# A\n' }, 'Add A');
        const b = await seedProposal({ 'skills/b.md': '# B\n' }, 'Add B');
        const results = await Promise.allSettled([
          improvement.proposals.accept(a),
          improvement.proposals.accept(b),
        ]);
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(await statusOf(a)).toBe('accepted');
        expect(await statusOf(b)).toBe('accepted');
        expect(git(skills, 'log', '--merges', '--format=%s').split('\n')).toHaveLength(2);
        expect(readFileSync(join(skills, 'skills', 'a.md'), 'utf8')).toBe('# A\n');
        expect(readFileSync(join(skills, 'skills', 'b.md'), 'utf8')).toBe('# B\n');
        expect(git(skills, 'status', '--porcelain')).toBe('');
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');
      });

      it.each([
        ['accept first', true],
        ['reject first', false],
      ])('lets exactly one of an accept and a reject win (%s)', async (_n, acceptFirst) => {
        const a = await seedProposal({ 'skills/a.md': '# A\n' }, 'Add A');
        const calls = [
          () => improvement.proposals.accept(a),
          () => improvement.proposals.reject(a, 'no'),
        ];
        const [first, second] = acceptFirst ? calls : calls.reverse();
        const results = await Promise.allSettled([first?.(), second?.()]);
        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(loser?.reason).toBeInstanceOf(ConflictError);
        const merged = git(skills, 'log', '--merges', '--format=%s') !== '';
        expect(await statusOf(a)).toBe(acceptFirst ? 'accepted' : 'rejected');
        expect(merged).toBe(acceptFirst);
        expect(git(skills, 'branch', '--list', 'introspect/*')).toBe('');
      });

      it('answers 409 when rejecting a decided proposal and keeps its decision', async () => {
        const a = await seedProposal({ 'skills/a.md': '# A\n' });
        await improvement.proposals.accept(a);
        await expect(improvement.proposals.reject(a, 'late')).rejects.toBeInstanceOf(ConflictError);
        expect(await statusOf(a)).toBe('accepted');
      });

      it('serialises an edit with an accept of the same proposal', async () => {
        const a = await seedProposal({ 'skills/a.md': '# A\n' });
        const d = `diff --git a/skills/a.md b/skills/a.md\nnew file mode 100644\n--- /dev/null\n+++ b/skills/a.md\n@@ -0,0 +1 @@\n+# Edited\n`;
        const results = await Promise.allSettled([
          improvement.proposals.edit(a, d),
          improvement.proposals.accept(a),
        ]);
        // Whichever got the lock first: the merged content is that of the branch at that moment.
        const [edited, accepted] = results as [
          PromiseSettledResult<unknown>,
          PromiseSettledResult<unknown>,
        ];
        expect(accepted.status).toBe('fulfilled');
        const content = readFileSync(join(skills, 'skills', 'a.md'), 'utf8');
        if (edited.status === 'fulfilled') expect(content).toBe('# Edited\n');
        else {
          expect(edited.reason).toBeInstanceOf(ConflictError);
          expect(content).toBe('# A\n');
        }
      });

      it('does not abort a merge somebody else started', async () => {
        const a = await seedProposal({ 'skills/a.md': '# A\n' });
        git(skills, 'checkout', '-q', '-b', 'other');
        writeFileSync(join(skills, 'other.md'), 'x\n');
        git(skills, 'add', '-A');
        git(skills, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'other');
        git(skills, 'checkout', '-q', 'main');
        git(
          skills,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'merge',
          '-q',
          '--no-commit',
          '--no-ff',
          '-s',
          'ours',
          'other',
        );
        const err = await improvement.proposals.accept(a).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toMatch(/merge in progress/);
        expect(existsSync(join(skills, '.git', 'MERGE_HEAD'))).toBe(true);
        expect(await statusOf(a)).toBe('open');
      });

      it('reports a failure that is not a conflict as an error and keeps the proposal open', async () => {
        const a = await seedProposal({ 'skills/a.md': '# A\n' });
        // git refuses the merge before it starts (exit 128, no MERGE_HEAD): not a conflict.
        git(skills, 'config', 'merge.verifySignatures', 'true');
        const err = await improvement.proposals.accept(a).catch((e: unknown) => e);
        git(skills, 'config', '--unset', 'merge.verifySignatures');
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toMatch(/merge failed/);
        expect(await statusOf(a)).toBe('open');
        expect((await improvement.proposals.accept(a)).status).toBe('accepted');
      });

      it('refreshes a stale cached default branch when accepting', async () => {
        const a = await seedProposal({ 'skills/a.md': '# A\n' });
        const repo = await skillRepos.getGlobal();
        await skillRepos.rememberDefaultBranch(repo?.id ?? '', 'master');
        expect((await improvement.proposals.accept(a)).status).toBe('accepted');
        expect((await skillRepos.row(repo?.id ?? ''))?.defaultBranch).toBe('main');
      });
    });

    describe('automated git ignores repository hooks and signing', () => {
      const marker = (): string => join(dir, 'hook-ran');
      const installHooks = (): void => {
        for (const hook of [
          'post-checkout',
          'pre-commit',
          'commit-msg',
          'prepare-commit-msg',
          'pre-merge-commit',
          'post-merge',
          'pre-push',
        ]) {
          const file = join(skills, '.git', 'hooks', hook);
          writeFileSync(file, `#!/bin/sh\ntouch "${marker()}"\nexit 1\n`);
          chmodSync(file, 0o755);
        }
        git(skills, 'config', 'commit.gpgsign', 'true');
        git(skills, 'config', 'gpg.program', '/nonexistent/gpg');
      };

      it('runs, edits and merges although every hook and the signing program fail', async () => {
        installHooks();
        // Control: git called by hand does run the hook, so the test can fail.
        expect(() =>
          execFileSync(
            'git',
            ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'x'],
            { cwd: skills, stdio: 'pipe' },
          ),
        ).toThrow();
        expect(existsSync(marker())).toBe(true);
        rmSync(marker());

        await improvement.run(new Date(0));
        const [p] = await open();
        expect(p).toBeDefined();
        const diff = `diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1,2 @@\n # Global instructions\n+Run tests once.\n`;
        await improvement.proposals.edit(p?.id ?? '', diff);
        expect((await improvement.proposals.accept(p?.id ?? '')).status).toBe('accepted');
        expect(existsSync(marker())).toBe(false);
      });
    });

    describe('housekeeping', () => {
      it('sweeps orphaned worktrees and branches at startup, and keeps open proposals', async () => {
        await improvement.run(new Date(0));
        const [kept] = await open();
        git(skills, 'branch', 'introspect/orphan-12345678');
        git(skills, 'branch', 'introspect-tmp/edit-12345678-1');
        git(skills, 'branch', 'feature/mine');
        const stale = join(dataDir, 'worktrees', 'run-x', 'wt');
        mkdirSync(dirname(stale), { recursive: true });
        git(skills, 'worktree', 'add', '-q', '-b', 'introspect/stale-wt-1', stale, 'main');
        rmSync(stale, { recursive: true });
        mkdirSync(join(dataDir, 'worktrees', 'leftover'), { recursive: true });

        const swept = await improvement.sweep();
        expect(swept.branches).toBe(3);
        expect(git(skills, 'branch', '--list', 'introspect/*', 'introspect-tmp/*')).toContain(
          kept?.branch ?? '',
        );
        expect(git(skills, 'branch', '--list', 'introspect/orphan-12345678')).toBe('');
        expect(git(skills, 'branch', '--list', 'introspect/stale-wt-1')).toBe('');
        expect(git(skills, 'branch', '--list', 'introspect-tmp/*')).toBe('');
        expect(git(skills, 'branch', '--list', 'feature/mine')).toContain('feature/mine');
        expect(existsSync(join(dataDir, 'worktrees', 'leftover'))).toBe(false);
        expect(git(skills, 'worktree', 'list').split('\n')).toHaveLength(1);
      });

      it('widens the scheduled window to the last successful run, at most 14 days', async () => {
        const at = new Date('2026-11-09T07:00:00Z');
        clock = () => at;
        const run = (daysAgo: number, status: string) =>
          t.handle.db
            .insertInto('improver_run')
            .values({
              id: newId(),
              workspace_id: LOCAL_WORKSPACE_ID,
              started_at: new Date(at.getTime() - daysAgo * 86_400_000).toISOString(),
              status,
            })
            .execute();
        const sinceOf = async (): Promise<number> => {
          const job = await queue().get(await improvement.enqueueRun());
          return (
            (at.getTime() - new Date((job?.payload as { since: string }).since).getTime()) /
            86_400_000
          );
        };
        expect(await sinceOf()).toBeCloseTo(1, 1);
        await run(3, 'succeeded');
        await run(1.5, 'failed');
        expect(await sinceOf()).toBeCloseTo(3, 1);
        await run(30, 'succeeded');
        await t.handle.db
          .deleteFrom('improver_run')
          .where('status', '=', 'succeeded')
          .where('started_at', '>', new Date(at.getTime() - 20 * 86_400_000).toISOString())
          .execute();
        expect(await sinceOf()).toBeCloseTo(14, 1);
      });
    });

    it('uses the documented default model', () => {
      expect(IMPROVER_MODEL).toBe('claude-opus-5-5');
    });
  });
}
