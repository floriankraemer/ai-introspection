import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, statfs, utimes } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { Writable, type Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Insertable } from 'kysely';
import { newId, sessionId as deriveSessionId } from '../../platform/db/ids.js';
import { byteCap } from '../../platform/byte-cap.js';
import { toJson } from '../../platform/db/json.js';
import type { Db, Schema } from '../../platform/db/schema.js';
import {
  ConflictError,
  InsufficientStorageError,
  InvalidInputError,
} from '../../platform/errors.js';
import { adapterFor } from './adapters/index.js';
import { finalizeSession } from './finalize.js';
import {
  FIELD_CAP_CHARS,
  INSERT_CHUNK,
  markStaleGrades,
  redactWrite,
  resultIsSensitive,
  reuseIds,
  titleOf,
  withLock,
  type PipelineDeps,
} from './pipeline.js';
import { createRedactor, REDACTION_VERSION } from './redaction.js';
import { AGENTS, type Agent, type EventKind } from './types.js';

/** One folder or file name of an uploaded log path: no `.`/`..`, no hidden names, no separators or control characters. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;
const MAX_PATH_CHARS = 1024;
export const INTAKE_DIR = 'intake';
/** Uploads are written here first, outside every source folder, so the watcher never sees a partial file. */
export const TEMP_DIR = '.tmp';
/** Free space an upload must leave on the data disk, on top of its own size. */
const DISK_RESERVE_BYTES = 1024 ** 3;

export const OUTCOME_KINDS = ['none', 'commit', 'pr_open', 'pr_merged'] as const;
export const EVENT_KINDS = [
  'user',
  'assistant',
  'tool_call',
  'file_op',
  'mcp',
  'skill',
  'system',
  'unknown',
] as const satisfies readonly EventKind[];

export interface PushedEvent {
  seq: number;
  ts: string | null;
  kind: EventKind;
  name: string | null;
  input: string | null;
  output: string | null;
  isError: boolean;
  ms: number | null;
  truncated: boolean;
  callId: string | null;
  sourceKey: string | null;
}

interface Warnings {
  unknown: number;
  malformed: number;
  oversized: number;
  redaction_failed: number;
}

/** A session the pusher's own Introspect has parsed and redacted (`introspect push --redact`). */
export interface PushedTrace {
  agent: Agent;
  nativeId: string;
  adapterVersion: string;
  redactionVersion: string;
  ended: boolean;
  session: {
    title: string | null;
    cwd: string | null;
    repo: string | null;
    branch: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    tokensIn: number;
    tokensOut: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    outcomeKind: (typeof OUTCOME_KINDS)[number];
    outcomeRef: string | null;
    warnings: { [K in keyof Warnings]?: number | undefined } | null;
  };
  events: PushedEvent[];
}

export interface RawLogUpload {
  userId: string;
  agent: string;
  /** Path below the agent's log root, e.g. `<project>/<session>.jsonl`. */
  path: string;
  body: Readable;
  gzip: boolean;
  /** The pusher's last-write time of the file; idle-finalize keys off it. */
  mtimeMs?: number | undefined;
  maxBytes: number;
  /** Most bytes one person's raw logs may take on the server, all files together. */
  quotaBytes: number;
}

export interface IntakeDeps {
  pipeline: PipelineDeps;
  dataDir: string;
  /** Registers `<data>/intake/<user>/<agent>` as that person's source (idempotent). */
  addSource(agent: Agent, path: string, userId: string): Promise<unknown>;
  /** Queues the ingest of a file inside a source; false when no enabled source holds it. */
  onFile(path: string): Promise<boolean>;
}

/** One message for every conflict, so a pusher cannot probe whose sessions or files exist. */
const CONFLICT =
  'This session or path cannot be stored; it conflicts with data already on the server';

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}${sep}`);

/** Bytes of every file below `dir` (symlinks not followed); 0 when it does not exist. */
async function bytesUnder(dir: string): Promise<number> {
  // ponytail: walks the person's folder on every upload; keep a running total if folders get huge.
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  let total = 0;
  for (const e of entries)
    if (e.isFile()) total += (await lstat(join(e.parentPath, e.name)).catch(() => null))?.size ?? 0;
  return total;
}

/** Capped before and after decompression, so neither a large upload nor a zip bomb gets past the limit. */
const decoders = (gzip: boolean, maxBytes: number): Transform[] =>
  gzip ? [byteCap(maxBytes), createGunzip(), byteCap(maxBytes)] : [byteCap(maxBytes)];

function bodyError(e: unknown): unknown {
  const code = (e as NodeJS.ErrnoException).code;
  return typeof code === 'string' && code.startsWith('Z_')
    ? new InvalidInputError('The body is not valid gzip data')
    : e;
}

/** The whole decoded body, for JSON requests; at most `maxBytes` after decompression. */
export async function readIntakeBody(
  body: Readable,
  gzip: boolean,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  try {
    await pipeline([body, ...decoders(gzip, maxBytes), sink]);
  } catch (e) {
    throw bodyError(e);
  }
  return Buffer.concat(chunks);
}

/** The agent, when `path` is a session log path that agent writes and that cannot leave its folder. */
function checkLogPath(agent: string, path: string): Agent {
  if (!AGENTS.includes(agent as Agent)) throw new InvalidInputError(`Unknown agent "${agent}"`);
  const valid =
    path.length <= MAX_PATH_CHARS &&
    path.split('/').every((s) => SEGMENT.test(s)) &&
    path.endsWith('.jsonl') &&
    adapterFor(agent as Agent).matches(path);
  if (!valid)
    throw new InvalidInputError(
      `"${path}" is not a ${agent} session log path (relative, letters, digits, ".", "_" and "-" only, ending in .jsonl)`,
    );
  return agent as Agent;
}

export function createIntake(deps: IntakeDeps) {
  const { db, workspaceId } = deps.pipeline;
  const now = deps.pipeline.now ?? (() => new Date());
  const root = join(deps.dataDir, INTAKE_DIR);

  /** Stores a raw log under the pusher's folder (0700/0600) and queues its ingest. */
  async function putLog(req: RawLogUpload): Promise<{ sessionId: string; jobQueued: boolean }> {
    const agent = checkLogPath(req.agent, req.path);
    if (!SEGMENT.test(req.userId)) throw new Error('Invalid intake user id');
    // One upload per person at a time, so parallel uploads cannot slip past the quota together.
    return withLock(`intake-user:${req.userId}`, () => storeLog(req, agent));
  }

  /**
   * True when the session is not this person's raw-log session: someone else's, or one pushed
   * redacted (no cursor). The ingest would skip the file, so it must not be stored at all.
   */
  async function ownedElsewhere(sid: string, userId: string): Promise<boolean> {
    const row = await db
      .selectFrom('session')
      .leftJoin('ingest_cursor', 'ingest_cursor.session_id', 'session.id')
      .select(['session.workspace_id', 'session.user_id', 'ingest_cursor.file_path'])
      .where('session.id', '=', sid)
      .executeTakeFirst();
    return (
      row !== undefined &&
      (row.workspace_id !== workspaceId || row.user_id !== userId || row.file_path === null)
    );
  }

  async function storeLog(
    req: RawLogUpload,
    agent: Agent,
  ): Promise<{ sessionId: string; jobQueued: boolean }> {
    const sid = deriveSessionId(agent, adapterFor(agent).nativeIdFromPath(req.path));
    if (await ownedElsewhere(sid, req.userId)) throw new ConflictError(CONFLICT);
    const base = join(root, req.userId, agent);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const disk = await statfs(base);
    if (disk.bavail * disk.bsize < req.maxBytes + DISK_RESERVE_BYTES)
      throw new InsufficientStorageError('The server is low on disk space; try again later');
    const realBase = await realpath(base);
    const target = join(realBase, ...req.path.split('/'));
    const tempDir = join(root, TEMP_DIR);
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const temp = join(tempDir, `${randomUUID()}.part`);
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      // Nothing in the path may lead out of the pusher's folder, a symlink planted there included.
      if (!within(await realpath(dirname(target)), realBase))
        throw new InvalidInputError(`"${req.path}" leads outside the upload folder`);
      // The file being replaced does not count: the upload takes its place.
      const replaced = (await lstat(target).catch(() => null))?.size ?? 0;
      const room = req.quotaBytes - ((await bytesUnder(join(root, req.userId))) - replaced);
      const overQuota = () =>
        new InsufficientStorageError(
          `Your uploads would exceed the storage quota of ${String(req.quotaBytes)} bytes; ask the server owner to raise it`,
        );
      if (room <= 0) throw overQuota();
      await pipeline([
        req.body,
        ...decoders(req.gzip, req.maxBytes),
        byteCap(room, overQuota),
        createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
      ]);
      if (req.mtimeMs !== undefined) {
        const seconds = Math.min(req.mtimeMs, now().getTime()) / 1000;
        await utimes(temp, seconds, seconds);
      }
      await rename(temp, target);
    } catch (e) {
      await rm(temp, { force: true });
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'EEXIST')
        throw new ConflictError(CONFLICT);
      throw bodyError(e);
    }
    await deps.addSource(agent, realBase, req.userId);
    return { sessionId: sid, jobQueued: await deps.onFile(target) };
  }

  /**
   * Upserts a client-redacted session. Every text field is redacted again with this server's rules
   * (ADR-0007, defence in depth); events are replaced in one transaction and keep their ids by
   * `sourceKey`, so grades, pins and labels survive a re-push.
   */
  async function putSession(
    userId: string,
    id: string,
    trace: PushedTrace,
  ): Promise<{ sessionId: string; events: number }> {
    const sid = deriveSessionId(trace.agent, trace.nativeId);
    if (id !== sid)
      throw new InvalidInputError(
        `The session id must be ${sid}, derived from the agent and the native id`,
      );
    if (trace.redactionVersion === 'off')
      throw new InvalidInputError('The session was not redacted; push it with redaction on');

    const settings = await deps.pipeline.settings.get();
    const redactor = createRedactor({
      key: deps.pipeline.redactionKey,
      customPatterns: settings['redaction.custom_patterns'],
    });
    const given = trace.session.warnings;
    const warnings: Warnings = {
      unknown: given?.unknown ?? 0,
      malformed: given?.malformed ?? 0,
      oversized: given?.oversized ?? 0,
      redaction_failed: given?.redaction_failed ?? 0,
    };
    const plain = (text: string | null): string | null => {
      if (text === null || text === '') return text;
      const r = redactor.redact(text);
      if (r.failed) warnings.redaction_failed += 1;
      return r.text;
    };
    const field = (text: string | null): { value: string | null; truncated: boolean } => {
      const value = plain(text);
      return value !== null && value.length > FIELD_CAP_CHARS
        ? { value: value.slice(0, FIELD_CAP_CHARS), truncated: true }
        : { value, truncated: false };
    };
    const iso = (ts: string | null): string | null => (ts ? new Date(ts).toISOString() : null);

    const rows: Insertable<Schema['event']>[] = trace.events.map((e) => {
      const name = plain(e.name);
      const input = field(
        e.input && redactWrite(name ?? undefined, e.input, (t) => redactor.redactWhole(t)),
      );
      const output =
        e.output !== null && resultIsSensitive(name, input.value)
          ? { value: redactor.redactWhole(e.output), truncated: false }
          : field(e.output);
      return {
        id: newId(),
        workspace_id: workspaceId,
        session_id: sid,
        seq: e.seq,
        ts: iso(e.ts),
        kind: e.kind,
        name,
        input: input.value,
        output: output.value,
        is_error: e.isError,
        ms: e.ms,
        truncated: e.truncated || input.truncated || output.truncated,
        call_id: e.callId,
        source_key: e.sourceKey,
      };
    });
    const s = trace.session;
    const startedAt = new Date(s.startedAt).toISOString();
    const endedAt = iso(s.endedAt);
    const title = plain(s.title);
    const values = {
      title: title ? titleOf(title) : null,
      repo: plain(s.repo),
      // Paths from the pusher's machine mean nothing here.
      repo_root: null,
      branch: plain(s.branch),
      cwd: plain(s.cwd),
      started_at: startedAt,
      ended_at: endedAt,
      duration_s: endedAt
        ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
        : null,
      tokens_in: s.tokensIn,
      tokens_out: s.tokensOut,
      tokens_cache_read: s.tokensCacheRead,
      tokens_cache_write: s.tokensCacheWrite,
      usage_tail: null,
      model: plain(s.model),
      status: 'active',
      outcome_kind: s.outcomeKind,
      outcome_ref: plain(s.outcomeRef),
      adapter_version: trace.adapterVersion,
      redaction_version: REDACTION_VERSION,
      ingest_warnings: Object.values(warnings).some((n) => n > 0) ? toJson(warnings) : null,
    } as const;

    // The same lock as the file pipeline: a raw ingest of this session cannot interleave.
    await withLock(sid, () =>
      db.transaction().execute(async (tx: Db) => {
        const existing = await tx
          .selectFrom('session')
          .select(['workspace_id', 'user_id'])
          .where('id', '=', sid)
          .executeTakeFirst();
        if (existing && (existing.workspace_id !== workspaceId || existing.user_id !== userId))
          throw new ConflictError(CONFLICT);
        const fromFile = await tx
          .selectFrom('ingest_cursor')
          .select('file_path')
          .where('session_id', '=', sid)
          .executeTakeFirst();
        if (fromFile) throw new ConflictError(CONFLICT);
        await tx
          .insertInto('session')
          .values({
            id: sid,
            workspace_id: workspaceId,
            user_id: userId,
            agent: trace.agent,
            native_id: trace.nativeId,
            created_at: now().toISOString(),
            ...values,
          })
          .onConflict((oc) => oc.column('id').doUpdateSet(values))
          .execute();
        const old = await tx
          .selectFrom('event')
          .select(['id', 'seq', 'source_key', 'kind', 'ts', 'call_id', 'payload_purged_at'])
          .where('session_id', '=', sid)
          .execute();
        reuseIds(rows, old);
        await tx.deleteFrom('event').where('session_id', '=', sid).execute();
        await tx.deleteFrom('signal').where('session_id', '=', sid).execute();
        for (let i = 0; i < rows.length; i += INSERT_CHUNK)
          await tx
            .insertInto('event')
            .values(rows.slice(i, i + INSERT_CHUNK))
            .execute();
        await markStaleGrades(tx, sid, new Set(rows.map((r) => r.id)));
      }),
    );
    if (trace.ended) await finalizeSession(db, workspaceId, sid, now());
    return { sessionId: sid, events: rows.length };
  }

  return { putLog, putSession };
}

export type Intake = ReturnType<typeof createIntake>;
