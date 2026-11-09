/**
 * Wire types of the `/v1` API as the SPA expects them (JSON, camelCase, ISO-8601 timestamps).
 * Settings use flat dotted keys, matching the `setting` key/value table (overview section 7).
 */

export type Agent = 'claude_code' | 'codex';

export type JudgeTransport = 'api' | 'cli';
export type BudgetMode = 'tokens_day' | 'tokens_day_and_usd_month' | 'usd_month';

export interface Settings {
  /** False until the setup wizard is completed or dismissed; drives the first-run redirect. */
  'setup.completed': boolean;
  'redaction.enabled': boolean;
  'retention.days': number;
  'judge.transport': JudgeTransport;
  /** Read-only. The key itself is write-only via `PUT /v1/settings/judge-key`. */
  'judge.api_key_set': boolean;
  'judge.sampling': 'flagged_sample' | 'every';
  'budget.mode': BudgetMode;
  'budget.tokens_per_day': number | null;
  'budget.usd_per_month': number | null;
  'schedule.grade': 'session_end' | 'pr_merge';
  'schedule.improver': 'daily' | 'weekly' | 'manual';
  'proposals.accept_mode': 'merge' | 'pr';
}

export type SourceStatus = 'watching' | 'polling' | 'disabled' | 'missing';

export interface Source {
  id: string;
  agent: Agent;
  path: string;
  enabled: boolean;
  status: SourceStatus;
}

export interface DetectedSource {
  agent: Agent;
  path: string;
  sessionCount: number;
}

export interface SkillRepo {
  id: string;
  kind: 'global' | 'project';
  path: string;
  /** True when `<path>/rubrics/` exists and holds at least one rubric file. */
  hasRubrics: boolean;
  enabled: boolean;
  acceptMode: 'merge' | 'pr' | null;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'deferred';

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  progress: { done: number; total: number } | null;
  error: string | null;
}

export interface JudgeTestResult {
  ok: boolean;
  detail: string;
}

export interface RubricRate {
  name: string;
  /** 0..1, or null when no session is graded for this rubric yet. */
  passRate: number | null;
  /** 0..1 */
  target: number;
  gradedCount: number;
}

export interface TrendSummary {
  days: number;
  sessionsCollected: number;
  sessionsGraded: number;
  rubrics: RubricRate[];
}

export interface SessionGrade {
  rubric: string;
  passed: boolean | null;
  score: number | null;
}

export type SessionResultFilter = 'failed_any' | 'all' | 'not_graded';

export interface SessionQuery {
  q?: string | undefined;
  agent?: Agent | undefined;
  result?: SessionResultFilter | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface SessionSummary {
  id: string;
  title: string;
  agent: Agent;
  repo: string | null;
  startedAt: string;
  toolErrors: number;
  /** Current grade per rubric; empty while the session is not graded. */
  grades: SessionGrade[];
  /** Why there is no grade, shown in the table (for example "not flagged, outside 20% sample"). */
  notGradedReason: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SessionDetail {
  id: string;
  title: string;
  agent: Agent;
  repo: string | null;
  branch: string | null;
  startedAt: string;
  durationS: number;
  tokensIn: number;
  tokensOut: number;
  model: string | null;
  outcome: {
    kind: 'none' | 'commit' | 'pr_open' | 'pr_merged';
    ref: string | null;
    url: string | null;
  };
  eventCount: number;
  errorCount: number;
}

export type EventKind =
  'user' | 'assistant' | 'tool_call' | 'file_op' | 'mcp' | 'skill' | 'system' | 'unknown';

export interface TraceEvent {
  id: string;
  seq: number;
  /** Seconds since the session start. */
  offsetS: number;
  kind: EventKind;
  /** Tool or skill name (`bash`, `edit`, ...), if any. */
  name: string | null;
  /** One-line, already redacted summary. Wrap code in backticks to render it monospaced. */
  text: string;
  isError: boolean;
  input: string | null;
  output: string | null;
  /** The field was cut at the 64 KiB cap at ingest. */
  truncated: boolean;
  /** Payload removed by the retention purge. */
  payloadPurged: boolean;
}

export type EventFilter = 'all' | 'errors' | 'evidence';

export interface EventQuery {
  filter: EventFilter;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** The API surface the SPA uses. `client.ts` implements it over HTTP, `mock.ts` over fixtures. */
export interface Api {
  getSettings(): Promise<Settings>;
  patchSettings(patch: Partial<Omit<Settings, 'judge.api_key_set'>>): Promise<Settings>;
  putJudgeKey(apiKey: string): Promise<void>;
  testJudge(body: { transport: JudgeTransport; apiKey?: string }): Promise<JudgeTestResult>;
  listSources(): Promise<Source[]>;
  detectSources(): Promise<DetectedSource[]>;
  addSource(body: { agent: Agent; path: string }): Promise<Source>;
  listSkillRepos(): Promise<SkillRepo[]>;
  putGlobalSkillRepo(path: string): Promise<SkillRepo>;
  copyStarterRubrics(): Promise<{ copied: string[] }>;
  patchSkillRepo(id: string, body: { enabled: boolean }): Promise<SkillRepo>;
  startImport(): Promise<Job>;
  getJob(id: string): Promise<Job>;
  getTrendSummary(days: number): Promise<TrendSummary>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getSession(id: string): Promise<SessionDetail>;
  listEvents(id: string, query: EventQuery): Promise<Page<TraceEvent> & { total: number }>;
  exchangeToken(token: string): Promise<void>;
}
