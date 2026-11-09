import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { newId } from '../../platform/db/ids.js';
import { fromJson, toJson } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { ConflictError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import {
  addWorktree,
  applyDiff,
  changedFiles,
  commitAll,
  currentBranch,
  deleteBranch,
  git,
  isClean,
  mergeInProgress,
  mergeNoFf,
  minimalEnv,
  moveBranch,
  NothingToCommitError,
  removeWorktree,
  revParse,
} from '../../platform/git/index.js';
import type { KeyedMutex } from '../../platform/keyed-mutex.js';
import type { GhRunner, ImprovementDeps } from './context.js';
import { DiffRejectedError, executableWarning, inspectDiff, isExecutableSurface } from './diff.js';
import { policyOf } from './policy.js';
import type { SkillRepoRow } from './skill-repos.js';
import { verifyChange } from './verify.js';

const run = promisify(execFile);
const GH_TIMEOUT_MS = 60_000;

export type ProposalStatus =
  'open' | 'accepted' | 'rejected' | 'conflict' | 'superseded' | 'failed';

export interface ClusterSummary {
  id: string;
  rubrics: string[];
  summary: string;
  terms: string[];
  sessionCount: number;
  /** The judge's reasons of the failing sessions (newest first, a few). */
  reasons: string[];
}

export interface ProposalDto {
  id: string;
  runId: string | null;
  title: string;
  status: ProposalStatus;
  targetRepo: { id: string; kind: 'global' | 'project'; path: string } | null;
  /** The main file the change touches. */
  targetPath: string;
  files: string[];
  additions: number;
  deletions: number;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  diff: string;
  rationale: string;
  evidenceSessionIds: string[];
  rubricNames: string[];
  cluster: ClusterSummary | null;
  /** Same as `files`. */
  targetPaths: string[];
  /** The first rubric of the cluster. */
  rubric: string;
  clusterSize: number;
  /** How accepting works for this repository right now. */
  acceptMode: 'merge' | 'pr';
  /** `problems` is why a failed proposal was refused; `warnings` flag a change to something Claude Code executes (only possible when the repository sets allowExecutable). */
  validation: { ok: boolean; problems: string[]; warnings: string[] };
  mergeCommit: string | null;
  rejectReason: string | null;
  prUrl: string | null;
  /** Rejection reason, or why validation failed. */
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface ProposalList {
  items: ProposalDto[];
  /** Number of proposals with the requested status (all when none is given): the nav badge for `open`. */
  total: number;
  counts: Record<ProposalStatus, number>;
}

const STATUSES: readonly ProposalStatus[] = [
  'open',
  'accepted',
  'rejected',
  'conflict',
  'superseded',
  'failed',
];

/** Display counts of a diff; tolerant, because a failed proposal's diff may be exactly what validation refused. */
export function diffStats(diff: string): {
  files: string[];
  additions: number;
  deletions: number;
  warnings: string[];
} {
  const files: string[] = [];
  const warnings = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (m?.[1]) {
      current = m[1];
      files.push(current);
      if (isExecutableSurface(current)) warnings.add(executableWarning(current));
    } else if (
      current &&
      /^(?:(?:new|old) )?(?:file )?mode 100755$|^index \S+\.\.\S+ 100755$/.test(line)
    )
      warnings.add(executableWarning(current));
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { files, additions, deletions, warnings: [...warnings].sort() };
}

const ghRunner: GhRunner = async (args, { cwd }) =>
  (await run('gh', args, { cwd, timeout: GH_TIMEOUT_MS, env: minimalEnv(true) })).stdout.trim();

export function createProposals(deps: ImprovementDeps, locks: KeyedMutex) {
  const { db, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const gh = deps.gh ?? ghRunner;

  const select = (q: Db = db) =>
    q
      .selectFrom('proposal')
      .leftJoin('skill_repo', 'skill_repo.id', 'proposal.target_repo_id')
      .selectAll('proposal')
      .select(['skill_repo.kind as repo_kind', 'skill_repo.path as repo_path'])
      .where('proposal.workspace_id', '=', workspaceId);
  type Row = Awaited<ReturnType<ReturnType<typeof select>['execute']>>[number];

  const arr = (v: string | null): string[] => (v === null ? [] : (fromJson(v) as string[]));

  /** Accept mode per repository (override or the setting), read once per request. */
  async function modes(): Promise<{
    byRepo: Map<string, 'merge' | 'pr'>;
    fallback: 'merge' | 'pr';
  }> {
    const fallback = (await deps.settings.get())['proposals.accept_mode'];
    const byRepo = new Map<string, 'merge' | 'pr'>();
    for (const r of await deps.skillRepos.rows()) if (r.acceptMode) byRepo.set(r.id, r.acceptMode);
    return { byRepo, fallback };
  }

  function toDto(r: Row, m: Awaited<ReturnType<typeof modes>>): ProposalDto {
    const stats = diffStats(r.diff);
    const cluster =
      r.cluster_summary === null ? null : (fromJson(r.cluster_summary) as ClusterSummary);
    const rubricNames = arr(r.rubric_names);
    return {
      id: r.id,
      runId: r.run_id,
      title: r.title,
      status: r.status,
      targetRepo:
        r.target_repo_id && r.repo_kind && r.repo_path
          ? { id: r.target_repo_id, kind: r.repo_kind, path: r.repo_path }
          : null,
      targetPath: r.target_path,
      files: stats.files,
      additions: stats.additions,
      deletions: stats.deletions,
      branch: r.branch,
      baseSha: r.base_sha,
      headSha: r.head_sha,
      diff: r.diff,
      rationale: r.rationale,
      evidenceSessionIds: arr(r.evidence_session_ids),
      rubricNames,
      cluster,
      targetPaths: stats.files,
      rubric: rubricNames[0] ?? '',
      clusterSize: cluster?.sessionCount ?? arr(r.evidence_session_ids).length,
      acceptMode: m.byRepo.get(r.target_repo_id ?? '') ?? m.fallback,
      validation:
        r.status === 'failed'
          ? { ok: false, problems: [r.decision_note ?? 'Validation failed'], warnings: [] }
          : { ok: true, problems: [], warnings: stats.warnings },
      mergeCommit: r.merge_commit,
      rejectReason: r.status === 'rejected' ? r.decision_note : null,
      prUrl: r.pr_url,
      decisionNote: r.decision_note,
      decidedAt: r.decided_at,
      createdAt: r.created_at,
    };
  }

  async function get(id: string): Promise<ProposalDto | null> {
    const row = await select().where('proposal.id', '=', id).executeTakeFirst();
    return row ? toDto(row, await modes()) : null;
  }

  async function mustGet(id: string): Promise<ProposalDto> {
    const p = await get(id);
    if (!p) throw new NotFoundError('No such proposal');
    return p;
  }

  async function repoOf(p: ProposalDto): Promise<SkillRepoRow> {
    const repo = p.targetRepo ? await deps.skillRepos.row(p.targetRepo.id) : null;
    if (!repo?.enabled)
      throw new ConflictError('The target repository is not registered or is disabled in Settings');
    return repo;
  }

  function mustBeOpen(p: ProposalDto): void {
    if (p.status !== 'open' && p.status !== 'conflict')
      throw new ConflictError(`The proposal is ${p.status}, not open`);
  }

  async function branchIntact(p: ProposalDto, repo: SkillRepoRow): Promise<string> {
    if (!p.branch || !p.headSha) throw new ConflictError('The proposal has no branch');
    const head = await revParse(repo.path, p.branch).catch(() => null);
    if (head === null)
      throw new ConflictError(`The branch ${p.branch} no longer exists in ${repo.path}`);
    if (head !== p.headSha)
      throw new ConflictError(
        `The branch ${p.branch} was changed outside Introspect; reject this proposal and run the improver again`,
      );
    return head;
  }

  async function mergeMode(repo: SkillRepoRow): Promise<'merge' | 'pr'> {
    return repo.acceptMode ?? (await deps.settings.get())['proposals.accept_mode'];
  }

  /** Records the accepted proposal and its change event in one transaction (Phase 4 trends read the event). */
  async function markAccepted(
    p: ProposalDto,
    repo: SkillRepoRow,
    files: string[],
    at: Date,
    mergeCommit: string | null,
  ): Promise<void> {
    await db.transaction().execute(async (tx) => {
      const changed = await tx
        .updateTable('proposal')
        .set({
          status: 'accepted',
          decided_by: deps.userId,
          decided_at: at.toISOString(),
          merge_commit: mergeCommit,
        })
        .where('id', '=', p.id)
        .where('status', 'in', ['open', 'conflict'])
        .executeTakeFirst();
      if (Number(changed.numUpdatedRows) === 0) return;
      await tx
        .insertInto('change_event')
        .values({
          id: newId(),
          workspace_id: workspaceId,
          at: at.toISOString(),
          kind: 'proposal_merged',
          proposal_id: p.id,
          repo_id: repo.id,
          description: p.title,
          files: toJson(files),
          rubric_names: toJson(p.rubricNames),
        })
        .execute();
    });
  }

  async function ghReady(): Promise<void> {
    const fix =
      'Set GH_TOKEN in .env (a token with repo scope) and run `make up`, or mount ~/.config/gh and run `gh auth login` on the host. `introspect doctor` checks this.';
    if (env.GH_TOKEN || env.GITHUB_TOKEN) return;
    try {
      await gh(['auth', 'status'], { cwd: deps.dataDir });
    } catch (e) {
      throw new ConflictError(
        (e as { code?: unknown }).code === 'ENOENT'
          ? 'The GitHub CLI (gh) is not installed'
          : 'The GitHub CLI is not signed in',
        fix,
      );
    }
  }

  async function acceptByMerge(p: ProposalDto, repo: SkillRepoRow, branch: string): Promise<void> {
    const def = await deps.skillRepos.refreshDefaultBranch(repo);
    const hint =
      'Or set this repository to PR mode in Settings (Accept mode), which never touches the working tree.';
    const cur = await currentBranch(repo.path);
    if (cur !== def)
      throw new ConflictError(
        `${repo.path} has "${cur}" checked out, not "${def}"`,
        `Check out "${def}" in that repository, then accept again. ${hint}`,
      );
    if (!(await isClean(repo.path)))
      throw new ConflictError(
        `${repo.path} has uncommitted changes`,
        `Commit or stash them, then accept again. ${hint}`,
      );
    // Someone else's merge: never touch it, and never start ours on top of it.
    if (await mergeInProgress(repo.path))
      throw new ConflictError(
        `${repo.path} has a merge in progress`,
        `Finish it or run "git merge --abort" there, then accept again. ${hint}`,
      );
    const before = await revParse(repo.path, 'HEAD');
    const message = `Merge proposal: ${p.title}\n\n${p.rationale}`;
    const outcome = await mergeNoFf(repo.path, branch, message).catch((e: unknown) => {
      throw new ConflictError(
        `The merge failed: ${e instanceof Error ? e.message : String(e)}`,
        `Nothing was changed and the proposal is still open. Fix the problem named above, then accept again. ${hint}`,
      );
    });
    if (outcome === 'conflict') {
      await db
        .updateTable('proposal')
        .set({ status: 'conflict' })
        .where('id', '=', p.id)
        .where('status', 'in', ['open', 'conflict'])
        .execute();
      throw new ConflictError(
        `The branch ${branch} conflicts with ${def}; nothing was changed`,
        `Reject this proposal and run the improver again, or merge the branch by hand. ${hint}`,
      );
    }
    const files = await changedFiles(repo.path, before, 'HEAD');
    await markAccepted(p, repo, files, now(), await revParse(repo.path, 'HEAD'));
    await deleteBranch(repo.path, branch);
  }

  async function acceptByPr(p: ProposalDto, repo: SkillRepoRow, branch: string): Promise<void> {
    if (p.prUrl) throw new ConflictError(`A pull request is already open: ${p.prUrl}`);
    await ghReady();
    const remotes = await git(repo.path, ['remote']);
    if (!remotes.split('\n').includes('origin'))
      throw new ConflictError(
        `${repo.path} has no remote called "origin" to push to`,
        'Add a remote, or use merge mode for this repository.',
      );
    const def = await deps.skillRepos.refreshDefaultBranch(repo);
    await git(
      repo.path,
      [
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        'push',
        '--no-verify',
        '-u',
        'origin',
        branch,
      ],
      { network: true },
    ).catch((e: unknown) => {
      throw new ConflictError(
        `Pushing ${branch} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    const url = await gh(
      ['pr', 'create', '--head', branch, '--base', def, '--title', p.title, '--body', p.rationale],
      { cwd: repo.path },
    ).catch((e: unknown) => {
      throw new ConflictError(`gh pr create failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    await db
      .updateTable('proposal')
      .set({ pr_url: url.split('\n').at(-1) ?? url })
      .where('id', '=', p.id)
      .execute();
  }

  /** Closes the pull request of a proposal that is being rejected; the user is told how to do it by hand when that fails. */
  async function closePullRequest(p: ProposalDto, repo: SkillRepoRow): Promise<void> {
    const url = p.prUrl;
    if (!url) return;
    await ghReady();
    await gh(['pr', 'close', url, '--delete-branch'], { cwd: repo.path }).catch((e: unknown) => {
      throw new ConflictError(
        `Closing the pull request failed: ${e instanceof Error ? e.message : String(e)}`,
        `Close ${url} on GitHub (or run "gh pr close ${url} --delete-branch"), then reject again. A pull request closed there is marked rejected within ten minutes anyway.`,
      );
    });
  }

  /** Runs `fn` while holding the lock of the proposal's repository: every mutating git operation on it is serial. */
  const exclusively = <T>(p: ProposalDto, fn: () => Promise<T>): Promise<T> =>
    locks.run(p.targetRepo?.id ?? p.id, fn);

  return {
    get,

    async list(q: { status?: ProposalStatus | undefined; limit: number }): Promise<ProposalList> {
      let qb = select();
      if (q.status) qb = qb.where('proposal.status', '=', q.status);
      const m = await modes();
      const rows = await qb
        .orderBy('proposal.created_at', 'desc')
        .orderBy('proposal.id', 'desc')
        .limit(q.limit)
        .execute();
      const grouped = await db
        .selectFrom('proposal')
        .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
        .where('workspace_id', '=', workspaceId)
        .groupBy('status')
        .execute();
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
        ProposalStatus,
        number
      >;
      for (const g of grouped) counts[g.status] = g.n;
      return {
        items: rows.map((r) => toDto(r, m)),
        total: q.status ? counts[q.status] : Object.values(counts).reduce((a, b) => a + b, 0),
        counts,
      };
    },

    /** Accept: merge into the default branch, or push the branch and open a PR (ADR-0010). */
    async accept(id: string): Promise<ProposalDto> {
      return exclusively(await mustGet(id), async () => {
        // Read again under the lock: another accept or a reject may have won while this one waited.
        const p = await mustGet(id);
        mustBeOpen(p);
        const repo = await repoOf(p);
        await branchIntact(p, repo);
        const branch = p.branch ?? '';
        if ((await mergeMode(repo)) === 'merge') await acceptByMerge(p, repo, branch);
        else await acceptByPr(p, repo, branch);
        return mustGet(id);
      });
    },

    async reject(id: string, reason: string): Promise<ProposalDto> {
      return exclusively(await mustGet(id), async () => {
        const p = await mustGet(id);
        mustBeOpen(p);
        const repo = p.targetRepo ? await deps.skillRepos.row(p.targetRepo.id) : null;
        if (repo) await closePullRequest(p, repo);
        const changed = await db
          .updateTable('proposal')
          .set({
            status: 'rejected',
            decided_by: deps.userId,
            decided_at: now().toISOString(),
            decision_note: reason,
          })
          .where('id', '=', id)
          .where('status', 'in', ['open', 'conflict'])
          .executeTakeFirst();
        if (Number(changed.numUpdatedRows) === 0)
          throw new ConflictError('The proposal was decided in the meantime');
        if (repo && p.branch) await deleteBranch(repo.path, p.branch);
        return mustGet(id);
      });
    },

    /**
     * "Edit first": the human's diff replaces the branch content. It is applied on a temporary
     * branch from the base commit, validated against what git reports changed, and committed there;
     * only then does the proposal branch move (compare-and-swap). Any failure leaves the original
     * branch and head SHA as they were.
     */
    async edit(id: string, rawDiff: string): Promise<ProposalDto> {
      const first = await mustGet(id);
      mustBeOpen(first);
      const diff = rawDiff.endsWith('\n') ? rawDiff : `${rawDiff}\n`;
      const policy = policyOf(await repoOf(first));
      // First filter on the text; verifyChange below checks what git really changes.
      const text = inspectDiff(diff, policy.allowList, policy.allowExecutable);
      if (await deps.hasSecret(text.addedText))
        throw new DiffRejectedError('an added line holds something that looks like a secret', true);
      return exclusively(first, async () => {
        const p = await mustGet(id);
        mustBeOpen(p);
        if (p.prUrl)
          throw new ConflictError('A pull request is already open for this branch; edit it there');
        const repo = await repoOf(p);
        const head = await branchIntact(p, repo);
        if (!p.baseSha || !p.branch) throw new ConflictError('The proposal has no branch');
        const branch = p.branch;
        const temp = `introspect-tmp/edit-${p.id.slice(-8)}-${String(now().getTime())}`;
        const dir = join(deps.dataDir, 'worktrees', `edit-${p.id}-${String(now().getTime())}`);
        await mkdir(join(deps.dataDir, 'worktrees'), { recursive: true });
        try {
          await addWorktree(repo.path, dir, temp, p.baseSha);
          try {
            await applyDiff(dir, diff);
          } catch (e) {
            throw new InvalidInputError(
              `The diff does not apply to ${p.baseSha.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          const newHead = await commitAll(
            dir,
            `introspect: ${p.title} (edited)\n\n${p.rationale}`,
          ).catch((e: unknown) => {
            throw e instanceof NothingToCommitError
              ? new DiffRejectedError('diff changes nothing')
              : e;
          });
          const change = await verifyChange(dir, p.baseSha, newHead, policy);
          if (await deps.hasSecret(change.addedText))
            throw new DiffRejectedError(
              'an added line holds something that looks like a secret',
              true,
            );
          await moveBranch(repo.path, branch, newHead, head);
          try {
            await db
              .updateTable('proposal')
              .set({
                diff: change.diff,
                head_sha: newHead,
                target_path: change.files[0] ?? p.targetPath,
              })
              .where('id', '=', id)
              .execute();
          } catch (e) {
            await moveBranch(repo.path, branch, head, newHead).catch(() => undefined);
            throw e;
          }
        } finally {
          await removeWorktree(repo.path, dir);
          await rm(dir, { recursive: true, force: true });
          await deleteBranch(repo.path, temp);
        }
        return mustGet(id);
      });
    },

    /** Polls open PRs: a merged PR becomes `accepted` with its change event, a closed one `rejected`. */
    async syncPullRequests(): Promise<number> {
      const open = await select()
        .where('proposal.status', '=', 'open')
        .where('proposal.pr_url', 'is not', null)
        .execute();
      let changed = 0;
      const m = await modes();
      for (const row of open) {
        const p = toDto(row, m);
        const repo = await repoOf(p).catch(() => null);
        if (!repo || !p.prUrl) continue;
        const state = await gh(['pr', 'view', p.prUrl, '--json', 'state,mergedAt'], {
          cwd: repo.path,
        })
          .then((out) => JSON.parse(out) as { state: string; mergedAt: string | null })
          .catch(() => null);
        if (!state) continue;
        if (state.state === 'MERGED') {
          await markAccepted(
            p,
            repo,
            p.files,
            state.mergedAt ? new Date(state.mergedAt) : now(),
            null,
          );
          changed += 1;
        } else if (state.state === 'CLOSED') {
          await db
            .updateTable('proposal')
            .set({
              status: 'rejected',
              decided_at: now().toISOString(),
              decision_note: 'The pull request was closed without merging',
            })
            .where('id', '=', p.id)
            .where('status', '=', 'open')
            .execute();
          changed += 1;
        }
      }
      return changed;
    },
  };
}

export type Proposals = ReturnType<typeof createProposals>;
