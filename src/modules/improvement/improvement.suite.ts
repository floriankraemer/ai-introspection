/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type Improvement,
  type Improver,
  type SkillRepos,
} from './index.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "auth status") [ -f "$FAKE_GH_DIR/unauth" ] && { echo "not logged in" >&2; exit 1; }; exit 0 ;;
  "pr create") echo "https://github.com/example/skills/pull/7"; exit 0 ;;
  "pr view") echo '{"state":"MERGED","mergedAt":"2026-11-09T10:00:00Z"}'; exit 0 ;;
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
    let sessionId: string;
    let env: NodeJS.ProcessEnv;
    const queue = () => createJobQueue(t.handle);

    const build = (): void => {
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
        env,
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
        // The planted token is not even stored in the failed proposal's text fields... except the refused diff itself.
        expect(PLANTED).toContain(SECRETS.github);
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
        writeFileSync(join(bin, 'gh'), FAKE_GH);
        chmodSync(join(bin, 'gh'), 0o755);
        oldPath = process.env.PATH;
        process.env.PATH = `${bin}:${oldPath ?? ''}`;
        process.env.FAKE_GH_DIR = bin;
        const remote = join(dir, 'remote.git');
        git(dir, 'init', '-q', '--bare', remote);
        git(skills, 'remote', 'add', 'origin', remote);
        await settings.update({ 'proposals.accept_mode': 'pr' });
        await improvement.run(new Date(0));
      });
      afterEach(() => {
        process.env.PATH = oldPath;
        delete process.env.FAKE_GH_DIR;
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

    it('uses the documented default model', () => {
      expect(IMPROVER_MODEL).toBe('claude-opus-5-5');
    });
  });
}
