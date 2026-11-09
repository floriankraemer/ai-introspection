import { ApiError } from './client.js';
import type {
  Api,
  DetectedSource,
  DoctorCheck,
  Job,
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
 * `empty` (configured, no sessions), `fresh` (nothing configured: shows the setup wizard).
 */
export type MockScenario = 'graded' | 'ungraded' | 'empty' | 'fresh';

const RUBRICS = [
  { name: 'Efficiency', target: 0.7 },
  { name: 'Redundant tests', target: 0.7 },
  { name: 'Verbosity', target: 0.7 },
  { name: 'Silent workaround', target: 0.8 },
];

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
    ago: (80 + i * 7) * H,
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
        },
      ];
  const jobs = new Map<string, Job>();
  const graded = scenario === 'graded';
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
            grades,
            notGradedReason: grades.length ? null : 'not flagged, outside 20% sample',
          };
        });
  const trace = buildTrace();

  const find = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) throw new ApiError(404, 'Not found', `No session ${id}`);
    return s;
  };

  return {
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
      };
      repos = [repo, ...repos.filter((r) => r.kind === 'project')];
      return repo;
    },
    async detectSkillRepos() {
      await wait();
      return [];
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
      await wait();
      const rates = [0.58, 0.71, 0.84, 0.66];
      return {
        days,
        sessionsCollected: sessions.length,
        sessionsGraded: graded ? 5 : 0,
        rubrics: graded
          ? RUBRICS.map((r, i) => ({ ...r, passRate: rates[i] ?? null, gradedCount: 31 }))
          : [],
      };
    },
    async listSessions({ q, agent, result, cursor, limit = 50 }) {
      await wait();
      const needle = q?.toLowerCase();
      const all = sessions.filter(
        (s) =>
          (!needle || `${s.title} ${s.repo ?? ''}`.toLowerCase().includes(needle)) &&
          (!agent || s.agent === agent) &&
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
        tokensIn: 250_000,
        tokensOut: 62_000,
        model: 'claude-sonnet-5-5',
        outcome: { kind: 'pr_merged', ref: '128', url: null },
        eventCount: trace.length,
        errorCount: trace.filter((e) => e.isError).length,
      };
      return detail;
    },
    async listEvents(id, { filter, cursor, limit = 200 }) {
      await wait();
      find(id);
      const all =
        filter === 'errors' ? trace.filter((e) => e.isError) : filter === 'evidence' ? [] : trace;
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
    async getDoctor() {
      await wait();
      return { checks: doctor };
    },
  };
}
