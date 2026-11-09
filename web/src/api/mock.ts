import { ApiError } from './client.js';
import { createProposalsApi } from './mock-proposals.js';
import { createTrendsApi } from './mock-trends.js';
import type {
  Api,
  Budget,
  CalibrationRow,
  DetectedSource,
  DoctorCheck,
  GradeDetail,
  Job,
  RubricDetail,
  RubricSummary,
  SessionDetail,
  SessionGrade,
  SessionSummary,
  Settings,
  SkillRepo,
  Source,
  TraceEvent,
} from './types.js';

/**
 * Fixture-backed implementation of `Api` for building the UI before the backend exists.
 * Scenarios: `graded` (default, full demo), `ungraded` (phase 1: nothing graded),
 * `empty` (configured, no sessions), `fresh` (nothing configured: shows the setup wizard),
 * `overbudget` (graded, but the judge budget is used up: grade jobs are deferred),
 * `noruns` (graded, but the improver never ran: no proposals, no runs).
 */
export type MockScenario = 'graded' | 'ungraded' | 'empty' | 'fresh' | 'overbudget' | 'noruns';

const RUBRICS = [
  { name: 'efficiency', target: 0.7 },
  { name: 'redundant-tests', target: 0.7 },
  { name: 'verbosity', target: 0.7 },
  { name: 'silent-workaround', target: 0.8 },
];

/** Rubric files as the API shows them: slug names, body with frontmatter. */
const RUBRIC_FILES: {
  name: string;
  version: number;
  passThreshold: number;
  wrong: number;
  passRate: number;
  question: string;
}[] = [
  {
    name: 'efficiency',
    version: 3,
    passThreshold: 0.6,
    wrong: 3,
    passRate: 0.58,
    question:
      'Did the agent work toward the result, or waste effort on redundant steps and back-and-forth?',
  },
  {
    name: 'redundant-tests',
    version: 2,
    passThreshold: 0.6,
    wrong: 1,
    passRate: 0.71,
    question: 'Do the tests the agent wrote duplicate coverage or ignore the test-pyramid rule?',
  },
  {
    name: 'verbosity',
    version: 1,
    passThreshold: 0.6,
    wrong: 2,
    passRate: 0.84,
    question: 'Are the final summary and the code comments short and free of filler?',
  },
  {
    name: 'silent-workaround',
    version: 1,
    passThreshold: 0.8,
    wrong: 4,
    passRate: 0.66,
    question: 'Did a tool or instruction fail, and did the final report leave that out?',
  },
];

/** Like the real API: the text below the frontmatter; the fields travel separately. */
const rubricBody = (r: (typeof RUBRIC_FILES)[number]) => `${r.question}

- 1.0  Direct path; information gathering proportional to the task
- 0.6  Some detours, recovered quickly
- 0.2  Repeated failed calls or environment probing a skill should cover

Return: score, one-paragraph reason, ids of the events that justify it.
`;

/** Splits a whole rubric file the way the server does: frontmatter fields and the body below. */
function splitRubricFile(text: string): { fields: Map<string, string>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trimStart());
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return { fields, body: (m[2] ?? '').trim() + '\n' };
}

const REASONS: Record<string, string> = {
  efficiency: 'Spent ~7 min probing ports. The e2e skill gives no way to find the dev-server port.',
  'redundant-tests': '46 unit tests; guidelines prefer a few end-to-end tests for auth flows.',
  verbosity: 'The final summary is short and the code carries no filler comments.',
  'silent-workaround':
    '11 tool errors were routed around; final summary reports success without mentioning them.',
};
/** Event ids that justify each grade in the fixture trace (`e1`… in order). */
const EVIDENCE: Record<string, string[]> = {
  efficiency: ['e7', 'e8', 'e9', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15', 'e16', 'e17', 'e18'],
  'silent-workaround': ['e22', 'e25'],
};

const JOB_META = {
  attempts: 1,
  maxAttempts: 3,
  runAfter: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
};

const H = 3_600_000;
const SESSIONS: {
  title: string;
  agent: 'claude_code' | 'codex';
  repo: string;
  ago: number;
  errors: number;
  g: (boolean | null)[];
}[] = [
  {
    title: 'Add OAuth to API service',
    agent: 'claude_code',
    repo: 'api-service',
    ago: 2 * H,
    errors: 14,
    g: [false, false, true, false],
  },
  {
    title: 'Fix flaky e2e login test',
    agent: 'codex',
    repo: 'web-app',
    ago: 5 * H,
    errors: 9,
    g: [false, true, true, true],
  },
  {
    title: 'Write changelog for 0.4',
    agent: 'claude_code',
    repo: 'docs-site',
    ago: 26 * H,
    errors: 0,
    g: [true, null, false, true],
  },
  {
    title: 'Spawn triage sub-agents',
    agent: 'claude_code',
    repo: 'infra',
    ago: 50 * H,
    errors: 11,
    g: [false, null, true, false],
  },
  {
    title: 'Refactor settings panel',
    agent: 'claude_code',
    repo: 'web-app',
    ago: 52 * H,
    errors: 2,
    g: [true, true, true, true],
  },
  {
    title: 'Bump dependencies',
    agent: 'codex',
    repo: 'api-service',
    ago: 74 * H,
    errors: 0,
    g: [],
  },
  ...Array.from({ length: 12 }, (_, i) => ({
    title: `Triage issue #${String(210 + i)}`,
    agent: i % 3 === 0 ? ('codex' as const) : ('claude_code' as const),
    repo: ['web-app', 'api-service', 'infra'][i % 3] ?? 'web-app',
    ago: (80 + i * 70) * H,
    errors: i % 4,
    g: [],
  })),
];

function buildTrace(): TraceEvent[] {
  const base = {
    input: null,
    output: null,
    truncated: false,
    payloadPurged: false,
    isError: false,
  };
  const out: Omit<TraceEvent, 'id' | 'seq'>[] = [
    {
      ...base,
      offsetS: 0,
      kind: 'user',
      name: null,
      text: 'Add OAuth login to the API, follow our e2e testing skill.',
    },
    {
      ...base,
      offsetS: 3,
      kind: 'skill',
      name: 'skill',
      text: 'Loaded `e2e-testing/SKILL.md`',
      output: '# e2e testing\n\nPrefer a few end-to-end tests for auth flows.',
    },
  ];
  for (let i = 0; i < 3; i++)
    out.push({
      ...base,
      offsetS: 10 + i * 20,
      kind: 'file_op',
      name: 'read',
      text: `Read \`src/auth/provider-${String(i)}.ts\``,
      output: `// file ${String(i)}`,
    });
  out.push({
    ...base,
    offsetS: 760,
    kind: 'file_op',
    name: 'edit',
    text: '8 files changed, +412 −37',
    input: 'diff --git a/src/auth/oauth.ts b/src/auth/oauth.ts\n+export const oauth = {};',
  });
  for (let i = 0; i < 11; i++)
    out.push({
      ...base,
      offsetS: 782 + i * 18,
      kind: 'tool_call',
      name: 'bash',
      isError: true,
      text: `\`curl localhost:${String(3000 + i)}/health\` → connection refused`,
      input: `curl localhost:${String(3000 + i)}/health`,
      output: `curl: (7) Failed to connect to localhost port ${String(3000 + i)}: Connection refused`,
    });
  out.push({
    ...base,
    offsetS: 1191,
    kind: 'tool_call',
    name: 'bash',
    text: '`lsof -i -P | grep LISTEN` → found :4173',
    input: 'lsof -i -P | grep LISTEN',
    output: 'node 4821 user 23u IPv4 TCP *:4173 (LISTEN)',
  });
  for (let i = 0; i < 2; i++)
    out.push({
      ...base,
      offsetS: 1200 + i * 6,
      kind: 'tool_call',
      name: 'bash',
      text: `\`pnpm test src/auth/case-${String(i)}\` → passed`,
      output: 'ok',
    });
  out.push({
    ...base,
    offsetS: 1330,
    kind: 'tool_call',
    name: 'bash',
    text: '`npm test` → 46 new unit tests passed',
    input: 'npm test',
    output: '46 passed',
  });
  for (const [i, c] of ['git push', 'gh pr create', 'gh pr checks'].entries())
    out.push({
      ...base,
      offsetS: 1800 + i * 20,
      kind: 'tool_call',
      name: 'bash',
      isError: true,
      text: `\`${c}\` → exit 1`,
      input: c,
      output: 'exit status 1',
      truncated: i === 0,
    });
  out.push({
    ...base,
    offsetS: 2458,
    kind: 'assistant',
    name: null,
    text: '“Done. OAuth works and all tests pass.” (no mention of port issue)',
  });
  return out.map((e, i) => ({ ...e, id: `e${String(i + 1)}`, seq: i + 1 }));
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMockApi(scenario: MockScenario = 'graded', latencyMs = 150): Api {
  const wait = () => delay(latencyMs);
  const fresh = scenario === 'fresh';
  const doctor: DoctorCheck[] = [
    { id: 'database', label: 'Database', status: 'ok', detail: 'SQLite, writable.', fix: null },
    fresh
      ? {
          id: 'sources',
          label: 'Agent logs',
          status: 'fail',
          detail: 'No agent log folder is readable at /sources/claude/projects.',
          fix: 'Start with `make up`, which mounts ~/.claude/projects read-only.',
        }
      : {
          id: 'sources',
          label: 'Agent logs',
          status: 'ok',
          detail: '2 folders readable.',
          fix: null,
        },
    {
      id: 'git',
      label: 'git',
      status: fresh ? 'warn' : 'ok',
      detail: fresh ? 'git is installed but no user.name is set.' : 'git 2.43 found.',
      fix: fresh ? 'Run `git config --global user.name "Your Name"`.' : null,
    },
  ];
  let settings: Settings = {
    'setup.completed': !fresh,
    'redaction.enabled': true,
    'redaction.custom_patterns': [],
    'retention.days': 90,
    'judge.transport': 'api',
    'judge.api_key_set': !fresh,
    'judge.sampling': 'flagged_sample',
    'budget.mode': 'tokens_day',
    'budget.tokens_per_day': 1_000_000,
    'budget.usd_per_month': null,
    'schedule.grade': 'session_end',
    'schedule.improver': 'daily',
    'proposals.accept_mode': 'merge',
    'trends.window_days': 7,
    'trends.min_graded': 10,
  };
  let sources: Source[] = fresh
    ? []
    : [
        {
          id: 's1',
          agent: 'claude_code',
          path: '~/.claude/projects',
          enabled: true,
          status: 'watching',
        },
        { id: 's2', agent: 'codex', path: '~/.codex/sessions', enabled: true, status: 'watching' },
      ];
  const detected: DetectedSource[] = [
    { agent: 'claude_code', path: '~/.claude/projects', sessionCount: 212 },
    { agent: 'codex', path: '~/.codex/sessions', sessionCount: 31 },
  ];
  let repos: SkillRepo[] = fresh
    ? []
    : [
        {
          id: 'r1',
          kind: 'global',
          path: '~/dev/agent-skills',
          hasRubrics: true,
          enabled: true,
          acceptMode: null,
          allowExecutable: false,
        },
        {
          id: 'repo-web',
          kind: 'project',
          path: '~/projects/web-app',
          hasRubrics: false,
          enabled: true,
          acceptMode: null,
          allowExecutable: true,
        },
      ];
  const jobs = new Map<string, Job>();
  const graded = scenario === 'graded' || scenario === 'noruns';
  const sessions: SessionSummary[] =
    scenario === 'empty' || fresh
      ? []
      : SESSIONS.map((s, i) => {
          const grades: SessionGrade[] = graded
            ? s.g.map((passed, r) => ({
                rubric: RUBRICS[r]?.name ?? '',
                passed,
                score: passed === null ? null : passed ? 0.8 : 0.2,
              }))
            : [];
          return {
            id: `sess-${String(i + 1)}`,
            title: s.title,
            agent: s.agent,
            repo: s.repo,
            startedAt: new Date(Date.now() - s.ago).toISOString(),
            toolErrors: s.errors,
            tokensIn: 120_000,
            tokensOut: 45_000,
            tokensCacheRead: 17_500_000,
            tokensCacheWrite: 400_000,
            grades,
            notGradedReason: grades.length ? null : 'not flagged, outside 20% sample',
          };
        });
  const trace = buildTrace();

  const gradesOf = (s: SessionSummary): GradeDetail[] =>
    s.grades.map((g) => ({
      rubric: g.rubric,
      rubricVersion: g.rubric === 'efficiency' ? 3 : 1,
      rubricSha: '9f3c2a1b7d4e',
      status: g.rubric === 'silent-workaround' ? 'stale' : 'ok',
      answeredModel: g.rubric === 'redundant-tests' ? 'claude-haiku-4-5' : 'claude-sonnet-5-5',
      score: g.score,
      passed: g.passed,
      reason:
        g.passed === null
          ? 'This rubric does not apply to this session.'
          : (REASONS[g.rubric] ?? ''),
      evidenceEventIds: g.passed === null ? [] : (EVIDENCE[g.rubric] ?? []),
      judgeModel: 'claude-sonnet-5-5',
      transport: settings['judge.transport'],
      gradedAt: s.startedAt,
      trusted: rubrics.get(g.rubric)?.trusted ?? false,
    }));

  // Rubric state is mutable so saving, labelling and re-reading behave like the real thing.
  const titles = SESSIONS.slice(0, 10).map((x, i) => ({
    id: `sess-${String(i + 1)}`,
    title: x.title,
  }));
  const rubrics = new Map<string, RubricDetail>(
    RUBRIC_FILES.map((r) => {
      const calibration: CalibrationRow[] = titles.map((t, i) => {
        const human = i % 2 === 0;
        const agrees = i >= r.wrong;
        return {
          sessionId: t.id,
          title: t.title,
          human: { passed: human, score: human ? 0.8 : 0.2, note: null },
          judge: {
            passed: agrees ? human : !human,
            score: (agrees ? human : !human) ? 0.8 : 0.2,
            reason: null,
          },
          agrees,
        };
      });
      return [
        r.name,
        {
          name: r.name,
          version: r.version,
          scale: [0, 0.2, 0.4, 0.6, 0.8, 1],
          passThreshold: r.passThreshold,
          appliesTo: 'all',
          sha: `${String(r.version)}f3c2a1b7d`,
          target: r.name === 'silent-workaround' ? 0.8 : 0.7,
          labelCount: 10,
          trusted: 10 - r.wrong >= 8,
          agreement: { agree: 10 - r.wrong, total: 10 },
          passRate: r.passRate,
          body: rubricBody(r),
          versions: Array.from({ length: r.version }, (_, v) => ({
            sha: `${String(v + 1)}f3c2a1b7d`,
            version: v + 1,
            at: new Date(Date.now() - (r.version - v) * 40 * H).toISOString(),
            message: v === 0 ? `Add ${r.name} rubric` : `Tighten ${r.name} levels`,
          })),
          calibration,
        },
      ];
    }),
  );
  const summaryOf = (r: RubricDetail): RubricSummary => ({
    name: r.name,
    version: r.version,
    scale: r.scale,
    passThreshold: r.passThreshold,
    appliesTo: r.appliesTo,
    trusted: r.trusted,
    agreement: r.agreement,
    passRate: r.passRate,
    sha: r.sha,
    target: r.target,
    labelCount: r.labelCount,
  });
  const recount = (r: RubricDetail) => {
    const rows = r.calibration.filter((c) => c.agrees !== null);
    const agree = rows.filter((c) => c.agrees).length;
    r.agreement = { agree, total: r.calibration.length };
    r.trusted = r.calibration.length >= 10 && agree / r.calibration.length >= 0.8;
  };
  const budget = (): Budget => ({
    mode: settings['budget.mode'],
    tokensToday: scenario === 'overbudget' ? (settings['budget.tokens_per_day'] ?? 0) : 120_000,
    tokensPerDay: settings['budget.tokens_per_day'],
    usdMonth: 4.2,
    usdPerMonth: settings['budget.usd_per_month'],
    deferredJobs: scenario === 'overbudget' ? 3 : 0,
    tokensResetAt: new Date(Date.now() + 8 * H).toISOString(),
    improver:
      scenario === 'graded'
        ? { tokensToday: 48_000, usdMonth: 0.9 }
        : { tokensToday: 0, usdMonth: 0 },
    usdResetAt: new Date(Date.now() + 20 * 24 * H).toISOString(),
  });
  const gradeJob = (n: number): Job => {
    const job: Job =
      scenario === 'overbudget'
        ? {
            id: `job-${String(jobs.size + 1)}`,
            kind: 'grade',
            status: 'deferred',
            progress: { done: 0, total: n },
            error:
              'Deferred: the daily token budget (1M) is used up. Grading resumes after midnight.',
            ...JOB_META,
          }
        : {
            id: `job-${String(jobs.size + 1)}`,
            kind: 'grade',
            status: 'queued',
            progress: { done: 0, total: n },
            error: null,
            ...JOB_META,
          };
    jobs.set(job.id, job);
    return job;
  };

  const find = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) throw new ApiError(404, 'Not found', `No session ${id}`);
    return s;
  };

  return {
    ...createTrendsApi(
      graded || scenario === 'overbudget',
      wait,
      () => gradeJob(40),
      (id) => {
        const s = find(id);
        return {
          id,
          title: s.title,
          startedAt: s.startedAt,
          grades: s.grades.map((g) => ({
            rubric: g.rubric,
            passed: g.passed,
            status: g.passed === null ? 'n/a' : 'graded',
          })),
        };
      },
      sessions.slice(0, 6).map((s) => s.id),
    ),
    ...createProposalsApi(
      scenario === 'graded' || scenario === 'overbudget',
      wait,
      (job) => jobs.set(job.id, job),
      JOB_META,
    ),
    async getSettings() {
      await wait();
      return { ...settings };
    },
    async patchSettings(patch) {
      await wait();
      settings = { ...settings, ...patch };
      return { ...settings };
    },
    async putJudgeKey(apiKey) {
      await wait();
      settings = { ...settings, 'judge.api_key_set': apiKey.length > 0 };
    },
    async testJudge({ transport, apiKey }) {
      await wait();
      if (transport === 'cli') return { ok: true, detail: 'claude CLI found and logged in.' };
      return apiKey?.startsWith('sk-ant-')
        ? { ok: true, detail: 'Connected. The API accepted the key.' }
        : {
            ok: false,
            detail: 'The API rejected this key (401). Check that you copied all of it.',
          };
    },
    async listSources() {
      await wait();
      return [...sources];
    },
    async detectSources() {
      await wait();
      return fresh ? detected : [];
    },
    async addSource(body) {
      await wait();
      const existing = sources.find((x) => x.path === body.path);
      if (existing) return existing;
      const s: Source = {
        id: `s${String(sources.length + 1)}`,
        ...body,
        enabled: true,
        status: 'watching',
      };
      sources = [...sources, s];
      return s;
    },
    async listSkillRepos() {
      await wait();
      return [...repos];
    },
    async putGlobalSkillRepo(path) {
      await wait();
      if (!path.startsWith('~/') && !path.startsWith('/'))
        throw new ApiError(
          422,
          'Invalid path',
          `${path} is not an absolute path or starts with ~/`,
        );
      const repo: SkillRepo = {
        id: 'r1',
        kind: 'global',
        path,
        hasRubrics: false,
        enabled: true,
        acceptMode: null,
        allowExecutable: false,
      };
      repos = [repo, ...repos.filter((r) => r.kind === 'project')];
      return repo;
    },
    async detectSkillRepos() {
      await wait();
      return fresh
        ? [{ path: '~/.claude', isGitRepo: false, hasRubrics: false, isEmpty: true }]
        : [];
    },
    async initGlobalSkillRepo(path) {
      await wait();
      const repo: SkillRepo = {
        id: 'r1',
        kind: 'global',
        path,
        hasRubrics: true,
        enabled: true,
        acceptMode: null,
        allowExecutable: false,
      };
      repos = [repo, ...repos.filter((r) => r.kind === 'project')];
      return repo;
    },
    async copyStarterRubrics() {
      await wait();
      repos = repos.map((r) => (r.kind === 'global' ? { ...r, hasRubrics: true } : r));
      return {
        copied: RUBRICS.map((r) => r.name.toLowerCase().replace(/ /g, '-')),
      };
    },
    async patchSkillRepo(id, body) {
      await wait();
      repos = repos.map((r) => (r.id === id ? { ...r, ...body } : r));
      const repo = repos.find((r) => r.id === id);
      if (!repo) throw new ApiError(404, 'Not found', `No repo ${id}`);
      return repo;
    },
    async addProjectRepo(path) {
      await wait();
      if (!path.startsWith('~/') && !path.startsWith('/'))
        throw new ApiError(
          422,
          'Invalid path',
          'Enter an absolute path such as ~/projects/web-app.',
        );
      const existing = repos.find((r) => r.path === path);
      if (existing) return existing;
      const repo: SkillRepo = {
        id: `r${String(repos.length + 1)}`,
        kind: 'project',
        path,
        hasRubrics: false,
        enabled: true,
        acceptMode: null,
        allowExecutable: false,
      };
      repos = [...repos, repo];
      return repo;
    },
    async startImport() {
      await wait();
      const job: Job = {
        id: `job-${String(jobs.size + 1)}`,
        kind: 'import',
        status: 'queued',
        progress: { done: 0, total: 243 },
        error: null,
        ...JOB_META,
      };
      jobs.set(job.id, job);
      return job;
    },
    async getJob(id) {
      await wait();
      const job = jobs.get(id);
      if (!job) throw new ApiError(404, 'Not found', `No job ${id}`);
      if (job.kind === 'grade' || job.kind === 'improve') {
        if (job.status === 'deferred') return job;
        const total = job.progress?.total ?? 1;
        const next: Job = { ...job, status: 'succeeded', progress: { done: total, total } };
        jobs.set(id, next);
        return next;
      }
      // Each poll advances the import, so tests and demos need no timers.
      const done = Math.min(job.progress?.total ?? 0, (job.progress?.done ?? 0) + 81);
      const next: Job = {
        ...job,
        status: done >= 243 ? 'succeeded' : 'running',
        progress: { done, total: 243 },
      };
      jobs.set(id, next);
      return next;
    },
    async getTrendSummary(days) {
      const inLast = (d: number) =>
        d === 0
          ? sessions
          : sessions.filter((s) => Date.parse(s.startedAt) >= Date.now() - d * 86_400_000);
      await wait();
      const rates = [0.58, 0.71, 0.84, 0.66];
      return {
        days,
        sessionsCollected: inLast(days).length,
        sessionsGraded: inLast(days).filter((s) => s.grades.length > 0).length,
        rubrics: graded
          ? RUBRICS.map((r, i) => ({ ...r, passRate: rates[i] ?? null, gradedCount: 31 }))
          : [],
      };
    },
    async listSessions({ q, agent, result, since, cursor, limit = 50 }) {
      await wait();
      const needle = q?.toLowerCase();
      const all = sessions.filter(
        (s) =>
          (!needle || `${s.title} ${s.repo ?? ''}`.toLowerCase().includes(needle)) &&
          (!agent || s.agent === agent) &&
          (!since || Date.parse(s.startedAt) >= Date.parse(since)) &&
          (result === 'failed_any'
            ? s.grades.some((g) => g.passed === false)
            : result === 'not_graded'
              ? s.grades.length === 0
              : true),
      );
      const start = Number(cursor ?? 0);
      const items = all.slice(start, start + limit);
      return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
    },
    async getSession(id) {
      await wait();
      const s = find(id);
      const detail: SessionDetail = {
        id: s.id,
        title: s.title,
        agent: s.agent,
        repo: s.repo,
        branch: 'feat/oauth',
        startedAt: s.startedAt,
        durationS: 2460,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        tokensCacheRead: s.tokensCacheRead,
        tokensCacheWrite: s.tokensCacheWrite,
        model: 'claude-sonnet-5-5',
        outcome: { kind: 'pr_merged', ref: '128', url: null },
        eventCount: trace.length,
        errorCount: trace.filter((e) => e.isError).length,
        grades: gradesOf(s),
      };
      return detail;
    },
    async listEvents(id, { filter, cursor, limit = 200 }) {
      await wait();
      find(id);
      const evidence = new Set(gradesOf(find(id)).flatMap((g) => g.evidenceEventIds));
      const all =
        filter === 'errors'
          ? trace.filter((e) => e.isError)
          : filter === 'evidence'
            ? trace.filter((e) => evidence.has(e.id))
            : trace;
      const start = Number(cursor ?? 0);
      return {
        items: all.slice(start, start + limit),
        nextCursor: start + limit < all.length ? String(start + limit) : null,
        total: all.length,
      };
    },
    async exchangeToken() {
      await wait();
    },
    async regradeSession(id) {
      await wait();
      find(id);
      return gradeJob(1);
    },
    async gradeBatch(ids) {
      await wait();
      return gradeJob(ids.length);
    },
    async listRubrics() {
      await wait();
      return fresh || scenario === 'ungraded' ? [] : [...rubrics.values()].map(summaryOf);
    },
    async getRubric(name) {
      await wait();
      const r = rubrics.get(name);
      if (!r) throw new ApiError(404, 'Not found', `No rubric ${name}`);
      return structuredClone(r);
    },
    async putRubric(name, { body, passThreshold, message }) {
      await wait();
      const old = rubrics.get(name);
      const version = (old?.version ?? 0) + 1;
      const file = splitRubricFile(body);
      const f = file?.fields;
      const next: RubricDetail = {
        name,
        scale: [0, 0.2, 0.4, 0.6, 0.8, 1],
        appliesTo: 'all',
        sha: '',
        labelCount: 0,
        trusted: false,
        agreement: { agree: 0, total: 0 },
        passRate: null,
        calibration: [],
        ...old,
        version,
        body: file?.body ?? body,
        passThreshold,
        ...(f?.has('scale') ? { scale: JSON.parse(f.get('scale') ?? '[]') as number[] } : {}),
        ...(f?.has('applies_to') ? { appliesTo: f.get('applies_to') ?? 'all' } : {}),
        target: f?.has('target') ? Number(f.get('target')) : (old?.target ?? null),
        versions: [
          ...(old?.versions ?? []),
          { sha: `${String(version)}a7e1c90d4`, version, at: new Date().toISOString(), message },
        ],
      };
      rubrics.set(name, next);
      return structuredClone(next);
    },
    async dryRunRubric(name, { sessionIds: ids }) {
      await wait();
      if (!rubrics.has(name)) throw new ApiError(404, 'Not found', `No rubric ${name}`);
      if (scenario === 'overbudget')
        throw new ApiError(
          429,
          'Budget used up',
          'The daily token budget is used up. Dry-runs resume after midnight.',
        );
      return {
        verdicts: ids.map((sid, i) => {
          const passed = i % 3 !== 0;
          const mine = rubrics.get(name)?.calibration.find((c) => c.sessionId === sid)
            ?.human.passed;
          return {
            sessionId: sid,
            rubric: name,
            status: 'ok' as const,
            judgeModel: 'claude-sonnet-5-5',
            answeredModel: 'claude-sonnet-5-5',
            transport: settings['judge.transport'],
            humanPassed: mine ?? null,
            agrees: mine === undefined ? null : mine === passed,
            score: passed ? 0.8 : 0.2,
            passed,
            reason: passed
              ? 'Direct path, a few reads before the edit.'
              : 'Repeated failed calls probing for the dev-server port.',
            evidenceEventIds: passed ? [] : ['e7', 'e8'],
          };
        }),
        skipped: [],
        usage: { tokens: 6000 * ids.length, costUsd: 0.02 * ids.length },
      };
    },
    async addLabel(name, label) {
      await wait();
      const r = rubrics.get(name.toLowerCase().replace(/ /g, '-'));
      if (!r) throw new ApiError(404, 'Not found', `No rubric ${name}`);
      const title = sessions.find((x) => x.id === label.sessionId)?.title ?? label.sessionId;
      const g = gradesOf(find(label.sessionId)).find((x) => x.rubric === r.name);
      const row: CalibrationRow = {
        sessionId: label.sessionId,
        title,
        human: { passed: label.passed, score: label.score ?? null, note: label.note || null },
        judge: g ? { passed: g.passed, score: g.score, reason: g.reason } : null,
        agrees: g && g.passed !== null ? g.passed === label.passed : null,
      };
      r.calibration = [row, ...r.calibration.filter((c) => c.sessionId !== label.sessionId)];
      recount(r);
    },
    async getBudget() {
      await wait();
      return budget();
    },
    async getDoctor() {
      await wait();
      const cli = settings['judge.transport'] === 'cli';
      const loggedIn = scenario !== 'ungraded'; // the ungraded scenario has never logged in
      const judge: DoctorCheck = cli
        ? loggedIn
          ? {
              id: 'judge',
              label: 'Judge (claude CLI)',
              status: 'ok',
              detail: 'Logged in to Claude inside the container.',
              fix: null,
            }
          : {
              id: 'judge',
              label: 'Judge (claude CLI)',
              status: 'warn',
              detail: 'Not logged in to Claude inside the container.',
              fix: 'Run `make claude-login`, then run the checks again.',
            }
        : {
            id: 'judge',
            label: 'Judge (Anthropic API)',
            status: settings['judge.api_key_set'] ? 'ok' : 'warn',
            detail: settings['judge.api_key_set'] ? 'An API key is stored.' : 'No API key.',
            fix: null,
          };
      return { checks: [...doctor, judge] };
    },
  };
}
