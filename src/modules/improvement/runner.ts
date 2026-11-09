import { createHash } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../../platform/db/ids.js';
import { fromJson, toJson } from '../../platform/db/json.js';
import {
  addWorktree,
  commitAll,
  deleteBranch,
  diffSince,
  git,
  NothingToCommitError,
  removeWorktree,
  revParse,
} from '../../platform/git/index.js';
import type { KeyedMutex } from '../../platform/keyed-mutex.js';
import { costOf } from '../grading/index.js';
import { redactionRefusal } from '../ingest/index.js';
import { clusterFailures, type Cluster, type TargetedFailure } from './clustering.js';
import type { ImprovementDeps } from './context.js';
import { DiffRejectedError, invisibleProblem, stripInvisible } from './diff.js';
import { estimateChars } from './improver-prompt.js';
import { policyOf } from './policy.js';
import type { ClusterSummary } from './proposals.js';
import type { SkillRepoRow } from './skill-repos.js';
import { resolveTarget } from './target.js';
import {
  ImproverCallError,
  type ClusterFailure,
  type ImproveRequest,
  type ImproveResult,
} from './types.js';
import { verifyChange } from './verify.js';
import { applyEdits, collectFiles } from './worktree.js';

/** Clusters turned into proposals per run (ADR-0010 diagram: the top 3 by session count). */
export const MAX_PROPOSALS_PER_RUN = 3;
/** Clusters listed in the run summary. */
const MAX_CLUSTERS_REPORTED = 5;
const MAX_FAILURES_PER_REQUEST = 6;
const EVIDENCE_EVENTS_PER_FAILURE = 6;
const EVIDENCE_LINE_CHARS = 300;
/** The API adapter answers in one response of at most this many tokens; the reservation assumes all of it. */
const ESTIMATED_OUTPUT_TOKENS = 16_000;
/** Whole-file reads in the tool loop re-send the context each turn; 3 characters per token errs high. */
const CHARS_PER_TOKEN = 3;
/** A typical loop is list, read, submit (3 sends of the context); the adapter stops at the reserved total instead of paying for more. */
const LOOP_INPUT_FACTOR = 4;
const STORED_DIFF_CHARS = 100_000;
const MAX_TITLE_CHARS = 120;
const MAX_RATIONALE_CHARS = 4000;
/** A declined or failed cluster is not billed again for this long unless it gained sessions. */
export const DEFAULT_DEDUPE_DAYS = 7;
const DAY_MS = 86_400_000;

export type ClusterOutcomeKind = 'proposed' | 'declined' | 'failed' | 'skipped' | 'deferred';

export interface ClusterReport {
  id: string;
  rubric: string;
  summary: string;
  sessionIds: string[];
  target: { id: string; kind: 'global' | 'project'; path: string };
  outcome: ClusterOutcomeKind;
  detail: string;
  proposalId: string | null;
}

export interface RunSummary {
  since: string;
  failedGrades: number;
  /** Failing grades of rubrics that have not passed the calibration gate: left out. */
  untrustedExcluded: { rubric: string; failures: number }[];
  skippedSessions: { sessionId: string; reason: string }[];
  clusters: ClusterReport[];
}

export interface RunResult {
  runId: string;
  status: 'succeeded' | 'partial' | 'failed';
  summary: RunSummary;
  proposalsCreated: number;
  /** Set when the budget stopped the run; the caller defers the job to this time. */
  deferUntil: Date | null;
  deferReason: string | null;
}

const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'change';

export function createRunner(deps: ImprovementDeps, locks: KeyedMutex) {
  const { db, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());
  const dedupeMs = (deps.dedupeDays ?? DEFAULT_DEDUPE_DAYS) * DAY_MS;

  async function evidenceOf(f: {
    sessionId: string;
    evidenceEventIds: string[];
  }): Promise<string[]> {
    if (f.evidenceEventIds.length === 0) return [];
    const page = await deps.ingest.sessions.events(f.sessionId, {
      filter: 'evidence',
      evidenceIds: f.evidenceEventIds,
      limit: EVIDENCE_EVENTS_PER_FAILURE,
    });
    return (page?.items ?? []).map(
      (e) =>
        `[e${String(e.seq)}] ${e.kind}${e.name ? ` ${e.name}` : ''}${e.isError ? ' ✕' : ''}: ${e.text.slice(0, EVIDENCE_LINE_CHARS)}`,
    );
  }

  async function requestFor(
    cluster: Cluster,
    repo: SkillRepoRow,
    files: Record<string, string>,
  ): Promise<ImproveRequest> {
    const newest = [...cluster.failures]
      .sort((a, b) => b.gradedAt.localeCompare(a.gradedAt))
      .slice(0, MAX_FAILURES_PER_REQUEST);
    const failures: ClusterFailure[] = [];
    for (const f of newest)
      failures.push({
        sessionId: f.sessionId,
        title: f.sessionTitle,
        rubric: f.rubric,
        reason: f.reason,
        evidence: await evidenceOf(f),
      });
    return {
      cluster: { id: cluster.id, rubrics: [cluster.rubric], summary: cluster.summary, failures },
      target: { kind: repo.kind, allowList: policyOf(repo).allowList },
      files,
    };
  }

  /** The improver call, inside a budget reservation; the call is on the ledger whatever it returns. */
  async function callImprover(
    runId: string,
    req: ImproveRequest,
  ): Promise<ImproveResult | { deferUntil: Date; reason: string }> {
    const improver = await deps.improvers.current();
    const inputTokens = Math.ceil((estimateChars(req) * LOOP_INPUT_FACTOR) / CHARS_PER_TOKEN);
    const usd = costOf(improver.model, {
      input: inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      output: ESTIMATED_OUTPUT_TOKENS,
    });
    const reservation = await deps.grading.budget.reserve(
      {
        purpose: 'improve',
        model: improver.model,
        transport: improver.transport,
        refId: runId,
        userId: deps.userId,
      },
      { inputTokens, usd, outputTokens: ESTIMATED_OUTPUT_TOKENS },
      now(),
    );
    if (reservation.kind === 'deferred')
      return { deferUntil: reservation.deferral.runAfter, reason: reservation.deferral.reason };
    if (reservation.kind === 'too_large') throw new Error(`Not improved: ${reservation.reason}`);
    try {
      const answer = await improver.propose({
        ...req,
        tokenCap: inputTokens + ESTIMATED_OUTPUT_TOKENS,
      });
      await deps.grading.budget.settle(reservation.id, {
        model: answer.model,
        usage: answer.usage,
        status: 'ok',
      });
      return answer;
    } catch (e) {
      // A response that was paid for but gave nothing usable still costs; no response costs nothing.
      if (e instanceof ImproverCallError)
        await deps.grading.budget.settle(reservation.id, {
          model: e.model,
          usage: e.usage,
          status: 'error',
        });
      else await deps.grading.budget.release(reservation.id);
      throw e;
    }
  }

  async function storeFailed(
    runId: string,
    repo: SkillRepoRow,
    cluster: Cluster,
    summary: ClusterSummary,
    title: string,
    rationale: string,
    diff: string,
    reason: string,
  ): Promise<string> {
    const id = newId();
    await db
      .insertInto('proposal')
      .values({
        id,
        workspace_id: workspaceId,
        run_id: runId,
        title: stripInvisible(title).slice(0, MAX_TITLE_CHARS) || 'Refused proposal',
        target_repo_id: repo.id,
        target_path: '',
        diff: stripInvisible(diff).slice(0, STORED_DIFF_CHARS),
        rationale: stripInvisible(rationale).slice(0, MAX_RATIONALE_CHARS),
        evidence_session_ids: toJson(cluster.sessionIds),
        rubric_names: toJson([cluster.rubric]),
        status: 'failed',
        decision_note: reason,
        cluster_summary: toJson(summary),
        created_at: now().toISOString(),
      })
      .execute();
    return id;
  }

  /** Title and rationale are bounded, free of invisible characters, and scanned for secrets like the diff. */
  async function checkText(title: string, rationale: string): Promise<void> {
    if (title.length > MAX_TITLE_CHARS)
      throw new DiffRejectedError(`the title is longer than ${String(MAX_TITLE_CHARS)} characters`);
    if (rationale.length > MAX_RATIONALE_CHARS)
      throw new DiffRejectedError(
        `the rationale is longer than ${String(MAX_RATIONALE_CHARS)} characters`,
      );
    const invisible = invisibleProblem(`${title}\n${rationale}`);
    if (invisible) throw new DiffRejectedError(`the title or rationale ${invisible}`);
    if (await deps.hasSecret(`${title}\n${rationale}`))
      throw new DiffRejectedError(
        'the title or rationale holds something that looks like a secret',
        true,
      );
  }

  const fingerprintOf = (cluster: Cluster): string =>
    createHash('sha256')
      .update(`${cluster.targetRepoId}\n${[...cluster.sessionIds].sort().join('\n')}`)
      .digest('hex');

  /** Remembers a declined or failed cluster: only the reason, never the diff. */
  async function recordOutcome(
    cluster: Cluster,
    outcome: 'declined' | 'failed',
    detail: string,
  ): Promise<void> {
    await db
      .insertInto('cluster_outcome')
      .values({
        id: newId(),
        workspace_id: workspaceId,
        target_repo_id: cluster.targetRepoId,
        fingerprint: fingerprintOf(cluster),
        outcome,
        detail: stripInvisible(detail).slice(0, 500),
        at: now().toISOString(),
      })
      .execute();
  }

  async function recentOutcome(
    cluster: Cluster,
  ): Promise<{ outcome: string; at: string } | undefined> {
    return db
      .selectFrom('cluster_outcome')
      .select(['outcome', 'at'])
      .where('workspace_id', '=', workspaceId)
      .where('target_repo_id', '=', cluster.targetRepoId)
      .where('fingerprint', '=', fingerprintOf(cluster))
      .where('at', '>=', new Date(now().getTime() - dedupeMs).toISOString())
      .orderBy('at', 'desc')
      .executeTakeFirst();
  }

  /** One cluster: worktree, improver, validated diff, commit on its branch, proposal row. */
  async function proposeCluster(
    runId: string,
    cluster: Cluster,
    repo: SkillRepoRow,
  ): Promise<
    Pick<ClusterReport, 'outcome' | 'detail' | 'proposalId'> | { defer: Date; reason: string }
  > {
    const summary: ClusterSummary = {
      id: cluster.id,
      rubrics: [cluster.rubric],
      summary: cluster.summary,
      terms: cluster.terms,
      sessionCount: cluster.sessionIds.length,
      reasons: [...cluster.failures]
        .sort((a, b) => b.gradedAt.localeCompare(a.gradedAt))
        .slice(0, MAX_FAILURES_PER_REQUEST)
        .map((f) => f.reason),
    };
    const base = await deps.skillRepos.refreshDefaultBranch(repo);
    const baseSha = await revParse(repo.path, base);
    const proposalId = newId();
    const provisional = `introspect/${slugOf(cluster.summary)}-${proposalId.slice(-8)}`;
    const dir = join(
      deps.dataDir,
      'worktrees',
      runId,
      `${slugOf(cluster.summary)}-${proposalId.slice(-8)}`,
    );
    await mkdir(join(deps.dataDir, 'worktrees', runId), { recursive: true });
    await locks.run(repo.id, () => addWorktree(repo.path, dir, provisional, baseSha));
    let keepBranch = false;
    let branchName = provisional;
    try {
      const policy = policyOf(repo);
      const req = await requestFor(cluster, repo, await collectFiles(dir, policy, deps.redact));
      const answer = await callImprover(runId, req);
      if ('deferUntil' in answer) return { defer: answer.deferUntil, reason: answer.reason };
      if (answer.kind === 'none') {
        await recordOutcome(cluster, 'declined', answer.reason);
        return { outcome: 'declined', detail: answer.reason, proposalId: null };
      }

      const slug = `introspect/${slugOf(answer.title)}-${proposalId.slice(-8)}`;
      try {
        await checkText(answer.title, answer.rationale);
        await applyEdits(dir, answer.edits, policy);
        const head = await commitAll(
          dir,
          `introspect: ${answer.title}\n\n${answer.rationale}`,
        ).catch((e: unknown) => {
          throw e instanceof NothingToCommitError
            ? new DiffRejectedError('diff changes nothing')
            : e;
        });
        // git's own account of what changed is the authority, not the text we wrote or were given.
        const change = await verifyChange(dir, baseSha, head, policy);
        if (await deps.hasSecret(change.addedText))
          throw new DiffRejectedError(
            'an added line holds something that looks like a secret',
            true,
          );
        await locks.run(repo.id, async () => {
          await git(dir, ['branch', '-m', slug]);
          branchName = slug;
        });
        await db
          .insertInto('proposal')
          .values({
            id: proposalId,
            workspace_id: workspaceId,
            run_id: runId,
            title: answer.title,
            target_repo_id: repo.id,
            target_path: change.files[0] ?? '',
            branch: slug,
            base_sha: baseSha,
            head_sha: head,
            diff: change.diff,
            rationale: answer.rationale,
            evidence_session_ids: toJson(cluster.sessionIds),
            rubric_names: toJson([cluster.rubric]),
            cluster_summary: toJson(summary),
            created_at: now().toISOString(),
          })
          .execute();
        // Only now does the branch belong to a proposal; any failure above leaves nothing behind.
        keepBranch = true;
        return { outcome: 'proposed', detail: answer.title, proposalId };
      } catch (e) {
        if (!(e instanceof DiffRejectedError)) throw e;
        const hidden = e.sensitive;
        const diff = hidden ? '' : await diffSince(dir, baseSha).catch(() => '');
        const id = await storeFailed(
          runId,
          repo,
          cluster,
          summary,
          hidden ? 'Refused proposal' : answer.title,
          hidden ? '' : answer.rationale,
          diff,
          e.message,
        );
        await recordOutcome(cluster, 'failed', e.message);
        return { outcome: 'failed', detail: e.message, proposalId: id };
      }
    } finally {
      await locks.run(repo.id, async () => {
        await removeWorktree(repo.path, dir);
        if (!keepBranch) await deleteBranch(repo.path, branchName);
      });
    }
  }

  async function alreadyProposed(cluster: Cluster): Promise<boolean> {
    const rows = await db
      .selectFrom('proposal')
      .select('evidence_session_ids')
      .where('workspace_id', '=', workspaceId)
      .where('target_repo_id', '=', cluster.targetRepoId)
      .where('status', 'in', ['open', 'conflict', 'accepted', 'rejected'])
      .execute();
    const covered = new Set(
      rows.flatMap((r) =>
        r.evidence_session_ids === null ? [] : (fromJson(r.evidence_session_ids) as string[]),
      ),
    );
    return cluster.sessionIds.every((s) => covered.has(s));
  }

  async function execute(runId: string, since: Date): Promise<RunResult> {
    const { failures, untrusted } = await deps.grading.failedGradesSince(since);
    const summary: RunSummary = {
      since: since.toISOString(),
      failedGrades: failures.length,
      untrustedExcluded: untrusted,
      skippedSessions: [],
      clusters: [],
    };
    // The redaction guard of grading applies here too: nothing from a session stored unredacted
    // or with old rules reaches the improver.
    const candidates = await deps.ingest.sessions.gradeCandidates({
      ids: [...new Set(failures.map((f) => f.sessionId))],
    });
    const refusal = new Map(candidates.map((c) => [c.id, redactionRefusal(c.redactionVersion)]));
    const repos = await deps.skillRepos.rows();
    const targeted: TargetedFailure[] = [];
    const skipped = new Set<string>();
    for (const f of failures) {
      const why = refusal.has(f.sessionId) ? (refusal.get(f.sessionId) ?? null) : 'no such session';
      if (why !== null) {
        if (!skipped.has(f.sessionId))
          summary.skippedSessions.push({ sessionId: f.sessionId, reason: why });
        skipped.add(f.sessionId);
        continue;
      }
      const target = await resolveTarget(f, repos);
      if ('skip' in target) {
        if (!skipped.has(f.sessionId))
          summary.skippedSessions.push({ sessionId: f.sessionId, reason: target.skip });
        skipped.add(f.sessionId);
        continue;
      }
      targeted.push({ ...f, targetRepoId: target.repo.id });
    }
    const clusters = clusterFailures(targeted);
    let proposals = 0;
    let deferUntil: Date | null = null;
    let deferReason: string | null = null;
    let failed = 0;
    for (const [i, cluster] of clusters.slice(0, MAX_CLUSTERS_REPORTED).entries()) {
      const repo = repos.find((r) => r.id === cluster.targetRepoId);
      if (!repo) continue;
      const report: ClusterReport = {
        id: cluster.id,
        rubric: cluster.rubric,
        summary: cluster.summary,
        sessionIds: cluster.sessionIds,
        target: { id: repo.id, kind: repo.kind, path: repo.path },
        outcome: 'skipped',
        detail: '',
        proposalId: null,
      };
      summary.clusters.push(report);
      if (i >= MAX_PROPOSALS_PER_RUN) {
        report.detail = `only the top ${String(MAX_PROPOSALS_PER_RUN)} clusters get a proposal per run`;
        continue;
      }
      if (deferUntil) {
        report.outcome = 'deferred';
        report.detail = deferReason ?? 'budget';
        continue;
      }
      if (await alreadyProposed(cluster)) {
        report.detail = 'a proposal already covers these sessions';
        continue;
      }
      const earlier = await recentOutcome(cluster);
      if (earlier) {
        report.detail = `${earlier.outcome} on ${earlier.at.slice(0, 10)} for these same sessions; it is tried again after new failures join the cluster or ${String(dedupeMs / DAY_MS)} days pass`;
        continue;
      }
      try {
        const out = await proposeCluster(runId, cluster, repo);
        if ('defer' in out) {
          deferUntil = out.defer;
          deferReason = out.reason;
          report.outcome = 'deferred';
          report.detail = out.reason;
        } else {
          Object.assign(report, out);
          if (out.outcome === 'proposed') proposals += 1;
          if (out.outcome === 'failed') failed += 1;
        }
      } catch (e) {
        report.outcome = 'failed';
        report.detail = e instanceof Error ? e.message : String(e);
        failed += 1;
        // A response that was paid for and gave nothing usable is not paid for again tomorrow.
        if (e instanceof ImproverCallError) await recordOutcome(cluster, 'failed', report.detail);
      }
    }
    return {
      runId,
      status: deferUntil ? 'partial' : failed > 0 && proposals === 0 ? 'failed' : 'succeeded',
      summary,
      proposalsCreated: proposals,
      deferUntil,
      deferReason,
    };
  }

  return {
    /** One improver run over the failing grades since `since`. A budget stop returns `deferUntil`. */
    async run(since: Date): Promise<RunResult> {
      const runId = newId();
      await db
        .insertInto('improver_run')
        .values({
          id: runId,
          workspace_id: workspaceId,
          started_at: now().toISOString(),
          status: 'running',
        })
        .execute();
      try {
        const result = await execute(runId, since);
        // Every worktree is gone by now; drop the run's empty folder too.
        await rmdir(join(deps.dataDir, 'worktrees', runId)).catch(() => undefined);
        await db
          .updateTable('improver_run')
          .set({
            finished_at: now().toISOString(),
            status: result.status,
            clusters: result.summary.clusters.length,
            proposals_created: result.proposalsCreated,
            summary: toJson(result.summary),
          })
          .where('id', '=', runId)
          .execute();
        return result;
      } catch (e) {
        await db
          .updateTable('improver_run')
          .set({
            finished_at: now().toISOString(),
            status: 'failed',
            error: e instanceof Error ? e.message : String(e),
          })
          .where('id', '=', runId)
          .execute();
        throw e;
      }
    },
  };
}
