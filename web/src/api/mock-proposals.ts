import { ApiError } from './client.js';
import type { Api, ImproverRun, Job, Proposal } from './types.js';

const H = 3_600_000;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `sess-${String(i + 1)}`);

const GLOBAL = { id: 'r1', kind: 'global', path: '~/.introspect/skills' } as const;
const PROJECT = { id: 'repo-web', kind: 'project', path: '~/projects/web-app' } as const;

const file = (path: string, hunk: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}`;

type Seed = Partial<Proposal> &
  Pick<
    Proposal,
    'id' | 'title' | 'targetRepo' | 'targetPath' | 'rubricNames' | 'rationale' | 'diff'
  > & {
    sessions: number;
    ago: number;
    reasons: string[];
  };

function build(x: Seed): Proposal {
  const { sessions, ago, reasons, ...rest } = x;
  const lines = x.diff.split('\n');
  return {
    runId: 'run-1',
    status: 'open',
    files: [x.targetPath],
    additions: lines.filter((l) => /^\+(?!\+\+)/.test(l)).length,
    deletions: lines.filter((l) => /^-(?!--)/.test(l)).length,
    branch: `introspect/${x.id}`,
    baseSha: 'a1b2c3d',
    headSha: 'e4f5a6b',
    evidenceSessionIds: ids(sessions),
    cluster: {
      id: `c-${x.id}`,
      rubrics: x.rubricNames,
      summary: x.title,
      terms: [],
      sessionCount: sessions,
      reasons,
    },
    targetPaths: [x.targetPath],
    rubric: x.rubricNames[0] ?? '',
    clusterSize: sessions,
    acceptMode: 'merge',
    validation: { ok: true, problems: [], warnings: [] },
    mergeCommit: null,
    rejectReason: null,
    prUrl: null,
    decisionNote: null,
    decidedAt: null,
    createdAt: new Date(Date.now() - ago * H).toISOString(),
    ...rest,
  };
}

function seed(): Proposal[] {
  return [
    build({
      id: 'p1',
      title: 'e2e-testing skill: find the dev-server port first',
      targetRepo: GLOBAL,
      targetPath: 'skills/e2e-testing/SKILL.md',
      rubricNames: ['silent-workaround', 'efficiency'],
      rationale:
        'In 12 failing sessions the agent probed ports 3000–3010 before finding the server. The skill never says how the port is chosen. Reports did not mention it.',
      sessions: 12,
      ago: 3,
      reasons: [
        'Same rubric (silent-workaround) failed in all 12 sessions.',
        'Every session ran the e2e-testing skill.',
      ],
      diff: file(
        'skills/e2e-testing/SKILL.md',
        [
          '@@ -14,3 +14,6 @@',
          '   ## Running e2e tests',
          '-Start the dev server and run the suite.',
          '+1. Start the dev server with `npm run dev -- --port 0`.',
          '+2. Read the chosen port from `.dev-port` (written on start).',
          '+3. Run `PORT=$(cat .dev-port) npm run e2e`.',
          '+If the server fails to start, stop and report it. Do not probe ports.',
          '',
        ].join('\n'),
      ),
    }),
    build({
      id: 'p2',
      title: 'changelog skill: prescribe wording and sections',
      targetRepo: PROJECT,
      targetPath: '.claude/skills/changelog/SKILL.md',
      rubricNames: ['verbosity'],
      rationale:
        'Five changelog drafts rambled: the skill gives no section list and no length limit.',
      sessions: 5,
      ago: 3,
      acceptMode: 'pr',
      reasons: ['Same rubric (verbosity) failed in all 5 sessions.'],
      diff: file(
        '.claude/skills/changelog/SKILL.md',
        [
          '@@ -3,2 +3,5 @@',
          ' Write the changelog for the release.',
          '+Use the sections Added, Changed, Fixed. One line per entry, 80 characters at most.',
          '+Skip sections without entries.',
          '',
        ].join('\n'),
      ),
    }),
    build({
      id: 'p3',
      title: 'settings.json: allow triage skill to spawn sub-agents',
      targetRepo: PROJECT,
      targetPath: '.claude/settings.json',
      rubricNames: ['redundant-tests'],
      rationale: 'The triage skill spawned sub-agents that the permissions denied, then retried.',
      validation: {
        ok: true,
        problems: [],
        warnings: [
          '".claude/settings.json" changes a hook/settings file that Claude Code executes',
        ],
      },
      sessions: 4,
      ago: 4,
      reasons: ['Same denied tool call (Task) in all 4 sessions.'],
      diff: file(
        '.claude/settings.json',
        ['@@ -2,3 +2,4 @@', '   "permissions": {', '     "allow": [', '+      "Task",', ''].join(
          '\n',
        ),
      ),
    }),
    build({
      id: 'p6',
      title: 'deploy skill: pin the base image',
      status: 'conflict',
      targetRepo: GLOBAL,
      targetPath: 'skills/deploy/SKILL.md',
      rubricNames: ['efficiency'],
      rationale: 'Deploys retried the build three times because the base image moved.',
      sessions: 3,
      ago: 9,
      decisionNote: 'Merge conflict in skills/deploy/SKILL.md: the file changed since the draft.',
      reasons: ['Same rubric failed in all 3 sessions.'],
      diff: file(
        'skills/deploy/SKILL.md',
        '@@ -1,1 +1,2 @@\n Deploy the app.\n+Pin the base image tag.\n',
      ),
    }),
    build({
      id: 'p4',
      title: 'review skill: name the files it must read',
      status: 'accepted',
      targetRepo: GLOBAL,
      targetPath: 'skills/review/SKILL.md',
      rubricNames: ['efficiency'],
      rationale: 'Reviews re-read the same files three times.',
      sessions: 3,
      ago: 30,
      mergeCommit: '9f3c2ab',
      decidedAt: new Date(Date.now() - 29 * H).toISOString(),
      reasons: ['Same rubric failed in all 3 sessions.'],
      diff: file(
        'skills/review/SKILL.md',
        '@@ -1,1 +1,2 @@\n Review the diff.\n+Read each changed file once.\n',
      ),
    }),
    build({
      id: 'p5',
      title: 'CLAUDE.md: forbid emojis',
      status: 'rejected',
      targetRepo: PROJECT,
      targetPath: 'CLAUDE.md',
      rubricNames: ['verbosity'],
      rationale: 'Two sessions used emojis in commit messages.',
      sessions: 2,
      ago: 52,
      rejectReason: 'Too small a cluster to act on.',
      decisionNote: 'Too small a cluster to act on.',
      decidedAt: new Date(Date.now() - 50 * H).toISOString(),
      reasons: ['Same rubric failed in both sessions.'],
      diff: file('CLAUDE.md', '@@ -1,1 +1,2 @@\n # Project\n+Do not use emojis.\n'),
    }),
  ];
}

/** Mirrors the server's validation: a unified diff that stays inside the allowed paths. */
function validate(diff: string, p: Proposal): string[] {
  const problems: string[] = [];
  const touched = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] ?? '');
  if (touched.length === 0) problems.push('The diff has no "+++ b/<path>" file header.');
  for (const t of touched)
    if (p.targetRepo?.kind === 'project' && !/^(\.claude\/|CLAUDE\.md$|AGENTS\.md$)/.test(t))
      problems.push(`${t} is outside .claude/**, CLAUDE.md and AGENTS.md.`);
  if (!/^@@ /m.test(diff)) problems.push('The diff has no "@@" hunk header.');
  return problems;
}

/** Proposals and improver runs. `withData: false` is a repo the improver never ran on. */
export function createProposalsApi(
  withData: boolean,
  wait: () => Promise<void>,
  addJob: (job: Job) => void,
  jobMeta: Pick<Job, 'attempts' | 'maxAttempts' | 'runAfter' | 'createdAt' | 'finishedAt'>,
): Pick<
  Api,
  | 'listProposals'
  | 'getProposal'
  | 'patchProposal'
  | 'acceptProposal'
  | 'rejectProposal'
  | 'startImprover'
  | 'listImproverRuns'
  | 'getImproverSchedule'
> {
  const proposals = withData ? seed() : [];
  const runs: ImproverRun[] = withData
    ? [
        {
          id: 'run-1',
          startedAt: new Date(Date.now() - 3 * H).toISOString(),
          finishedAt: new Date(Date.now() - 3 * H + 240_000).toISOString(),
          status: 'succeeded',
          clusters: 4,
          proposalsCreated: 3,
          proposals: 3,
          clustersSkipped: 1,
          untrustedRubrics: ['efficiency'],
          error: null,
          summary: {
            since: new Date(Date.now() - 27 * H).toISOString(),
            failedGrades: 21,
            untrustedExcluded: [{ rubric: 'efficiency', failures: 6 }],
            skippedSessions: [],
            clusters: [
              {
                id: 'c-p1',
                rubric: 'silent-workaround',
                summary: 'e2e-testing skill: find the dev-server port first',
                sessionIds: ids(12),
                target: { ...GLOBAL },
                outcome: 'proposed',
                detail: 'Proposed a change to skills/e2e-testing/SKILL.md.',
                proposalId: 'p1',
              },
              {
                id: 'c-old',
                rubric: 'verbosity',
                summary: 'release notes ramble',
                sessionIds: ids(3),
                target: { ...PROJECT },
                outcome: 'declined',
                detail:
                  'declined on 2026-11-02 for these same sessions; the proposal was rejected as too narrow.',
                proposalId: null,
              },
              {
                id: 'c-big',
                rubric: 'efficiency',
                summary: 'long refactor sessions',
                sessionIds: ids(4),
                target: { ...GLOBAL },
                outcome: 'failed',
                detail: 'budget: stopped after 12 turns without a diff.',
                proposalId: null,
              },
            ],
          },
        },
      ]
    : [];
  let dirtyOnce = true;
  let closeFailsOnce = true;
  const find = (id: string) => {
    const p = proposals.find((x) => x.id === id);
    if (!p) throw new ApiError(404, 'Not found', `No proposal ${id}`);
    return p;
  };
  const update = (id: string, patch: Partial<Proposal>) => {
    const next = { ...find(id), ...patch };
    proposals[proposals.findIndex((x) => x.id === id)] = next;
    return next;
  };
  return {
    async listProposals(status) {
      await wait();
      const items = proposals.filter((p) => !status || p.status === status);
      const counts: Record<string, number> = {};
      for (const p of proposals) counts[p.status] = (counts[p.status] ?? 0) + 1;
      return { items, total: items.length, counts };
    },
    async getProposal(id) {
      await wait();
      return find(id);
    },
    async patchProposal(id, diff) {
      await wait();
      const problems = validate(diff, find(id));
      if (problems.length)
        throw new ApiError(422, 'Invalid diff', 'The edited diff does not validate.', problems);
      return update(id, {
        diff,
        status: 'open',
        decisionNote: null,
        validation: { ok: true, problems: [], warnings: find(id).validation.warnings },
      });
    },
    async acceptProposal(id) {
      await wait();
      const p = find(id);
      if (p.id === 'p3' && dirtyOnce) {
        dirtyOnce = false;
        throw new ApiError(
          409,
          'Working tree is dirty',
          'The target repo has uncommitted changes, so the merge was not started.',
          [],
          'Commit or stash the changes in ~/projects/web-app, then accept again.',
        );
      }
      // PR mode stays open until the pull request merges.
      if (p.acceptMode === 'pr')
        return update(id, { prUrl: 'https://github.com/acme/web-app/pull/42' });
      return update(id, {
        status: 'accepted',
        mergeCommit: '4be71d0',
        decidedAt: new Date().toISOString(),
      });
    },
    async rejectProposal(id, reason) {
      await wait();
      if (id === 'p2' && closeFailsOnce) {
        closeFailsOnce = false;
        throw new ApiError(
          409,
          'Closing the pull request failed',
          'Closing the pull request failed: gh exited with 1 (HTTP 401).',
          [],
          'Run `gh auth login` on the host, then reject again.',
        );
      }
      return update(id, {
        status: 'rejected',
        rejectReason: reason,
        decisionNote: reason,
        decidedAt: new Date().toISOString(),
      });
    },
    async startImprover() {
      await wait();
      const job: Job = {
        id: `job-improve-${String(runs.length + 1)}`,
        kind: 'improve',
        status: 'queued',
        progress: { done: 0, total: 1 },
        error: null,
        ...jobMeta,
      };
      addJob(job);
      runs.unshift({
        id: `run-${String(runs.length + 1)}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'succeeded',
        clusters: 0,
        proposalsCreated: 0,
        proposals: 0,
        clustersSkipped: 0,
        untrustedRubrics: withData ? ['efficiency'] : [],
        error: null,
        summary: null,
      });
      return job;
    },
    async getImproverSchedule() {
      await wait();
      return { mode: 'daily' as const, nextRunAt: new Date(Date.now() + 15 * H).toISOString() };
    },
    async listImproverRuns() {
      await wait();
      return [...runs];
    },
  };
}
