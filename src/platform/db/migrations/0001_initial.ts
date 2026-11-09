import { type Kysely, sql } from 'kysely';
import { columnTypes } from '../columns.js';
import type { Dialect } from '../schema.js';

/** Creates every table of overview section 7. One migration set serves both dialects (ADR-0003). */
export async function up(db: Kysely<unknown>, dialect: Dialect): Promise<void> {
  const t = columnTypes(dialect);
  const falseDefault = dialect === 'postgres' ? sql`false` : sql`0`;
  const trueDefault = dialect === 'postgres' ? sql`true` : sql`1`;

  await db.schema
    .createTable('workspace')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('app_user')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('email', 'text')
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('member'))
    .addColumn('share_sessions', t.bool, (c) => c.notNull().defaultTo(trueDefault))
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('source')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('user_id', t.id, (c) => c.notNull().references('app_user.id'))
    .addColumn('agent', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('mode', 'text', (c) => c.notNull().defaultTo('watch'))
    .addColumn('enabled', t.bool, (c) => c.notNull().defaultTo(trueDefault))
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .addUniqueConstraint('source_workspace_agent_path', ['workspace_id', 'agent', 'path'])
    .execute();

  await db.schema
    .createTable('session')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('user_id', t.id, (c) => c.notNull().references('app_user.id'))
    .addColumn('agent', 'text', (c) => c.notNull())
    .addColumn('native_id', 'text', (c) => c.notNull())
    .addColumn('title', 'text')
    .addColumn('repo', 'text')
    .addColumn('repo_root', 'text')
    .addColumn('branch', 'text')
    .addColumn('cwd', 'text')
    .addColumn('started_at', t.timestamp)
    .addColumn('ended_at', t.timestamp)
    .addColumn('duration_s', 'integer')
    .addColumn('tokens_in', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('tokens_out', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('cost', 'double precision')
    .addColumn('model', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('outcome_kind', 'text', (c) => c.notNull().defaultTo('none'))
    .addColumn('outcome_ref', 'text')
    .addColumn('adapter_version', 'text')
    .addColumn('redaction_version', 'text')
    .addColumn('flagged', t.bool, (c) => c.notNull().defaultTo(falseDefault))
    .addColumn('sampled', t.bool, (c) => c.notNull().defaultTo(falseDefault))
    .addColumn('in_reference_set', t.bool, (c) => c.notNull().defaultTo(falseDefault))
    .addColumn('pinned', t.bool, (c) => c.notNull().defaultTo(falseDefault))
    .addColumn('ingest_warnings', t.json)
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .addUniqueConstraint('session_workspace_agent_native', ['workspace_id', 'agent', 'native_id'])
    .execute();
  await db.schema
    .createIndex('session_workspace_started')
    .on('session')
    .columns(['workspace_id', 'started_at'])
    .execute();

  await db.schema
    .createTable('ingest_cursor')
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('source_id', t.id, (c) => c.notNull().references('source.id').onDelete('cascade'))
    .addColumn('file_path', 'text', (c) => c.notNull())
    .addColumn('file_fingerprint', 'text')
    .addColumn('byte_offset', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('size', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('mtime_ms', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('session_id', t.id, (c) => c.references('session.id').onDelete('set null'))
    .addColumn('updated_at', t.timestamp, (c) => c.notNull())
    .addPrimaryKeyConstraint('ingest_cursor_pk', ['source_id', 'file_path'])
    .execute();

  await db.schema
    .createTable('event')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('session_id', t.id, (c) => c.notNull().references('session.id').onDelete('cascade'))
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('ts', t.timestamp)
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('name', 'text')
    .addColumn('input', 'text')
    .addColumn('output', 'text')
    .addColumn('is_error', t.bool, (c) => c.notNull().defaultTo(falseDefault))
    .addColumn('ms', 'integer')
    .addColumn('truncated', t.bool, (c) => c.notNull().defaultTo(falseDefault))
    .addColumn('payload_purged_at', t.timestamp)
    .addUniqueConstraint('event_session_seq', ['session_id', 'seq'])
    .execute();

  await db.schema
    .createTable('signal')
    .addColumn('session_id', t.id, (c) =>
      c.primaryKey().references('session.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('failed_tool_calls', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('retries', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('repeated_commands', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('files_touched', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('tests_run', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('signal_version', 'integer', (c) => c.notNull())
    .addColumn('computed_at', t.timestamp, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('rubric')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('version', 'text', (c) => c.notNull())
    .addColumn('ordinal', 'integer', (c) => c.notNull())
    .addColumn('commit_sha', 'text')
    .addColumn('scale', 'text', (c) => c.notNull())
    .addColumn('pass_threshold', 'double precision', (c) => c.notNull())
    .addColumn('target_pass_rate', 'double precision')
    .addColumn('applies_to', t.json)
    .addColumn('body_md', 'text', (c) => c.notNull())
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .addUniqueConstraint('rubric_workspace_name_version', ['workspace_id', 'name', 'version'])
    .execute();

  await db.schema
    .createTable('calibration_label')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('rubric_name', 'text', (c) => c.notNull())
    .addColumn('session_id', t.id, (c) => c.notNull().references('session.id').onDelete('cascade'))
    .addColumn('user_id', t.id, (c) => c.notNull().references('app_user.id'))
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('note', 'text')
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .addUniqueConstraint('calibration_label_unique', [
      'workspace_id',
      'rubric_name',
      'session_id',
      'user_id',
    ])
    .execute();

  await db.schema
    .createTable('llm_call')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('user_id', t.id, (c) => c.references('app_user.id'))
    .addColumn('at', t.timestamp, (c) => c.notNull())
    .addColumn('purpose', 'text', (c) => c.notNull())
    .addColumn('model', 'text', (c) => c.notNull())
    .addColumn('transport', 'text', (c) => c.notNull())
    .addColumn('tokens_in', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('cache_read_tokens', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('tokens_out', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('cost_estimate', 'double precision')
    .addColumn('ref_id', 'text')
    .execute();
  await db.schema
    .createIndex('llm_call_workspace_at')
    .on('llm_call')
    .columns(['workspace_id', 'at'])
    .execute();

  await db.schema
    .createTable('grade')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('session_id', t.id, (c) => c.notNull().references('session.id').onDelete('cascade'))
    .addColumn('rubric_id', t.id, (c) => c.notNull().references('rubric.id'))
    .addColumn('rubric_version', 'text', (c) => c.notNull())
    .addColumn('score', 'double precision')
    .addColumn('passed', t.bool)
    .addColumn('reason', 'text')
    .addColumn('evidence_event_ids', t.json)
    .addColumn('judge_model', 'text', (c) => c.notNull())
    .addColumn('transport', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('ok'))
    .addColumn('llm_call_id', t.id, (c) => c.references('llm_call.id'))
    .addColumn('graded_at', t.timestamp, (c) => c.notNull())
    .addUniqueConstraint('grade_session_rubric_judge', [
      'session_id',
      'rubric_version',
      'judge_model',
    ])
    .execute();

  await db.schema
    .createTable('improver_run')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('started_at', t.timestamp, (c) => c.notNull())
    .addColumn('finished_at', t.timestamp)
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('clusters', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('proposals_created', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable('skill_repo')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('remote_url', 'text')
    .addColumn('default_branch', 'text')
    .addColumn('allow_list', t.json)
    .addColumn('accept_mode', 'text')
    .addColumn('enabled', t.bool, (c) => c.notNull().defaultTo(trueDefault))
    .addUniqueConstraint('skill_repo_workspace_path', ['workspace_id', 'path'])
    .execute();

  await db.schema
    .createTable('proposal')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('run_id', t.id, (c) => c.references('improver_run.id'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('target_repo_id', t.id, (c) => c.references('skill_repo.id'))
    .addColumn('target_path', 'text', (c) => c.notNull())
    .addColumn('branch', 'text')
    .addColumn('base_sha', 'text')
    .addColumn('head_sha', 'text')
    .addColumn('diff', 'text', (c) => c.notNull())
    .addColumn('rationale', 'text', (c) => c.notNull())
    .addColumn('evidence_session_ids', t.json)
    .addColumn('rubric_names', t.json)
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('open'))
    .addColumn('decided_by', t.id, (c) => c.references('app_user.id'))
    .addColumn('decided_at', t.timestamp)
    .addColumn('decision_note', 'text')
    .addColumn('pr_url', 'text')
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('change_event')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('at', t.timestamp, (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('proposal_id', t.id, (c) => c.references('proposal.id'))
    .addColumn('repo_id', t.id, (c) => c.references('skill_repo.id'))
    .addColumn('description', 'text', (c) => c.notNull())
    .addColumn('files', t.json)
    .addColumn('rubric_names', t.json)
    .execute();

  await db.schema
    .createTable('job')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('payload', t.json, (c) => c.notNull())
    .addColumn('idempotency_key', 'text', (c) => c.unique())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('queued'))
    .addColumn('priority', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (c) => c.notNull().defaultTo(5))
    .addColumn('run_after', t.timestamp, (c) => c.notNull())
    .addColumn('lease_until', t.timestamp)
    .addColumn('locked_by', 'text')
    .addColumn('last_error', 'text')
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .addColumn('finished_at', t.timestamp)
    .execute();
  await db.schema
    .createIndex('job_status_run_after')
    .on('job')
    .columns(['status', 'run_after'])
    .execute();

  await db.schema
    .createTable('schedule_state')
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('last_fired_period', t.timestamp, (c) => c.notNull())
    .addPrimaryKeyConstraint('schedule_state_pk', ['workspace_id', 'name'])
    .execute();

  await db.schema
    .createTable('setting')
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('value', t.json, (c) => c.notNull())
    .addColumn('updated_at', t.timestamp, (c) => c.notNull())
    .addPrimaryKeyConstraint('setting_pk', ['workspace_id', 'key'])
    .execute();

  // Team mode only; created by the same migrations, empty locally.
  await db.schema
    .createTable('auth_session')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('user_id', t.id, (c) => c.notNull().references('app_user.id'))
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .addColumn('last_seen_at', t.timestamp, (c) => c.notNull())
    .addColumn('expires_at', t.timestamp, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('api_token')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('user_id', t.id, (c) => c.notNull().references('app_user.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('created_at', t.timestamp, (c) => c.notNull())
    .addColumn('expires_at', t.timestamp)
    .addColumn('revoked_at', t.timestamp)
    .execute();
}
