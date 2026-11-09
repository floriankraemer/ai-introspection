import type { Generated, Kysely } from 'kysely';

// Hand-written view of the schema created by migrations (ADR-0003, overview section 7).
// Timestamps are ISO-8601 UTC strings on both dialects (see connection.ts).
// JSON columns are written with `toJson` and read with `fromJson`; booleans are written as
// booleans on both dialects (the SQLite driver maps them to 0/1) and read with `asBool`.
type Ts = string;
type Json = string; // serialized on write, see json.ts
type Bool = Generated<boolean | number>;

export interface Schema {
  workspace: { id: string; name: string; created_at: Ts };
  app_user: {
    id: string;
    workspace_id: string;
    display_name: string;
    email: string | null;
    role: Generated<'member' | 'rubric_owner' | 'admin'>;
    share_sessions: Bool;
    created_at: Ts;
  };
  source: {
    id: string;
    workspace_id: string;
    user_id: string;
    agent: string;
    path: string;
    mode: Generated<'watch' | 'poll'>;
    enabled: Bool;
    created_at: Ts;
  };
  ingest_cursor: {
    workspace_id: string;
    source_id: string;
    file_path: string;
    file_fingerprint: string | null;
    byte_offset: Generated<number>;
    size: Generated<number>;
    mtime_ms: Generated<number>;
    session_id: string | null;
    updated_at: Ts;
  };
  session: {
    id: string;
    workspace_id: string;
    user_id: string;
    agent: string;
    native_id: string;
    title: string | null;
    repo: string | null;
    repo_root: string | null;
    branch: string | null;
    cwd: string | null;
    started_at: Ts | null;
    ended_at: Ts | null;
    duration_s: number | null;
    tokens_in: Generated<number>;
    tokens_out: Generated<number>;
    cost: number | null;
    model: string | null;
    status: Generated<string>;
    outcome_kind: Generated<'none' | 'commit' | 'pr_open' | 'pr_merged'>;
    outcome_ref: string | null;
    adapter_version: string | null;
    redaction_version: string | null;
    flagged: Bool;
    sampled: Bool;
    in_reference_set: Bool;
    pinned: Bool;
    ingest_warnings: Json | null;
    created_at: Ts;
  };
  event: {
    id: string;
    workspace_id: string;
    session_id: string;
    seq: number;
    ts: Ts | null;
    kind: string;
    name: string | null;
    input: string | null;
    output: string | null;
    is_error: Bool;
    ms: number | null;
    truncated: Bool;
    payload_purged_at: Ts | null;
    /** Tool-use id that pairs a result with its call, also across ingest chunks. */
    call_id: string | null;
  };
  signal: {
    session_id: string;
    workspace_id: string;
    failed_tool_calls: Generated<number>;
    retries: Generated<number>;
    repeated_commands: Generated<number>;
    files_touched: Generated<number>;
    tests_run: Generated<number>;
    signal_version: number;
    computed_at: Ts;
  };
  rubric: {
    id: string;
    workspace_id: string;
    name: string;
    version: string;
    ordinal: number;
    commit_sha: string | null;
    scale: string;
    pass_threshold: number;
    target_pass_rate: number | null;
    applies_to: Json | null;
    body_md: string;
    created_at: Ts;
  };
  calibration_label: {
    id: string;
    workspace_id: string;
    rubric_name: string;
    session_id: string;
    user_id: string;
    label: 'pass' | 'fail';
    note: string | null;
    created_at: Ts;
  };
  llm_call: {
    id: string;
    workspace_id: string;
    user_id: string | null;
    at: Ts;
    purpose: 'grade' | 'dry_run' | 'cluster' | 'improve';
    model: string;
    transport: string;
    tokens_in: Generated<number>;
    cache_read_tokens: Generated<number>;
    tokens_out: Generated<number>;
    cost_estimate: number | null;
    ref_id: string | null;
  };
  grade: {
    id: string;
    workspace_id: string;
    session_id: string;
    rubric_id: string;
    rubric_version: string;
    score: number | null;
    passed: Bool | null;
    reason: string | null;
    evidence_event_ids: Json | null;
    judge_model: string;
    transport: string;
    status: Generated<'ok' | 'refused' | 'invalid'>;
    llm_call_id: string | null;
    graded_at: Ts;
  };
  improver_run: {
    id: string;
    workspace_id: string;
    started_at: Ts;
    finished_at: Ts | null;
    status: string;
    clusters: Generated<number>;
    proposals_created: Generated<number>;
  };
  skill_repo: {
    id: string;
    workspace_id: string;
    kind: 'global' | 'project';
    path: string;
    remote_url: string | null;
    default_branch: string | null;
    allow_list: Json | null;
    accept_mode: string | null;
    enabled: Bool;
  };
  proposal: {
    id: string;
    workspace_id: string;
    run_id: string | null;
    title: string;
    target_repo_id: string | null;
    target_path: string;
    branch: string | null;
    base_sha: string | null;
    head_sha: string | null;
    diff: string;
    rationale: string;
    evidence_session_ids: Json | null;
    rubric_names: Json | null;
    status: Generated<'open' | 'accepted' | 'rejected' | 'conflict' | 'superseded'>;
    decided_by: string | null;
    decided_at: Ts | null;
    decision_note: string | null;
    pr_url: string | null;
    created_at: Ts;
  };
  change_event: {
    id: string;
    workspace_id: string;
    at: Ts;
    kind: 'proposal_merged' | 'manual_edit' | 'judge_changed' | 'rubric_changed';
    proposal_id: string | null;
    repo_id: string | null;
    description: string;
    files: Json | null;
    rubric_names: Json | null;
  };
  job: {
    id: string;
    workspace_id: string;
    kind: string;
    payload: Json;
    idempotency_key: string | null;
    status: Generated<JobStatus>;
    priority: Generated<number>;
    attempts: Generated<number>;
    max_attempts: Generated<number>;
    run_after: Ts;
    lease_until: Ts | null;
    locked_by: string | null;
    last_error: string | null;
    created_at: Ts;
    finished_at: Ts | null;
    progress: Json | null;
  };
  schedule_state: { workspace_id: string; name: string; last_fired_period: Ts };
  setting: { workspace_id: string; key: string; value: Json; updated_at: Ts };
  auth_session: {
    id: string;
    workspace_id: string;
    user_id: string;
    created_at: Ts;
    last_seen_at: Ts;
    expires_at: Ts;
  };
  api_token: {
    id: string;
    workspace_id: string;
    user_id: string;
    name: string;
    token_hash: string;
    created_at: Ts;
    expires_at: Ts | null;
    revoked_at: Ts | null;
  };
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'deferred';

export type Db = Kysely<Schema>;
export type Dialect = 'sqlite' | 'postgres';
