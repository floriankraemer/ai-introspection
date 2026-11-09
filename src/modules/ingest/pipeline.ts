import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { Insertable } from 'kysely';
import { newId, sessionId as deriveSessionId } from '../../platform/db/ids.js';
import { asBool, fromJson, toJson } from '../../platform/db/json.js';
import type { Db, Schema } from '../../platform/db/schema.js';
import type { SettingsService } from '../settings/index.js';
import { adapterFor } from './adapters/index.js';
import { finalizeSession } from './finalize.js';
import { readLines } from './lines.js';
import { createRedactor, isSensitivePath, REDACTION_VERSION, type Redactor } from './redaction.js';
import type { Agent, ParsedItem, RawEvent } from './types.js';

const BATCH_LINES = 1000;
const BATCH_CHARS = 4 * 1024 * 1024;
const INSERT_CHUNK = 250;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** Redaction runs on at most this much of a field, so one giant tool output cannot stall a job. */
const PRE_REDACT_CHARS = 1024 * 1024;
/** Stored per field (ADR-0007). Counted in characters. */
export const FIELD_CAP_CHARS = 64 * 1024;
const TITLE_CHARS = 80;
const FINGERPRINT_BYTES = 1024;
/** No new bytes for this long: the session has ended (ADR-0005). */
export const SESSION_IDLE_MS = 10 * 60_000;
const FILE_READ_TOOLS = new Set(['read', 'view']);

export interface PipelineDeps {
  db: Db;
  workspaceId: string;
  userId: string;
  redactionKey: Buffer;
  settings: Pick<SettingsService, 'get'>;
  now?: () => Date;
}

export interface IngestFileResult {
  status: 'missing' | 'unchanged' | 'ingested';
  sessionId?: string;
  events: number;
  /** The file was truncated or replaced, so the session was rebuilt from the start. */
  reset: boolean;
}

interface Warnings {
  unknown: number;
  malformed: number;
  oversized: number;
  redaction_failed: number;
}
const emptyWarnings = (): Warnings => ({
  unknown: 0,
  malformed: 0,
  oversized: 0,
  redaction_failed: 0,
});

type EventRow = Insertable<Schema['event']>;

// One ingest run per file at a time inside this process.
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** `<length>:<sha1 of the first <length> bytes>`; the length is part of it so appending to a short file keeps it valid. */
async function fingerprint(path: string, length: number): Promise<string | null> {
  const file = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await file.read(buf, 0, length, 0);
    return bytesRead < length
      ? null
      : `${String(length)}:${createHash('sha1').update(buf).digest('hex')}`;
  } finally {
    await file.close();
  }
}

async function currentFingerprint(path: string, size: number): Promise<string | null> {
  return fingerprint(path, Math.min(size, FINGERPRINT_BYTES));
}

async function fingerprintIntact(path: string, stored: string): Promise<boolean> {
  const length = Number(stored.split(':')[0]);
  return (await fingerprint(path, length)) === stored;
}

function trimToBoundary(s: string): string {
  const cut = s.search(/\s\S*$/);
  return cut > 0 ? s.slice(0, cut) : s;
}

function readsSensitiveFile(name: string | null, input: string | null): boolean {
  if (!name || !FILE_READ_TOOLS.has(name) || !input) return false;
  try {
    const parsed = JSON.parse(input) as { file_path?: unknown; path?: unknown };
    const path = parsed.file_path ?? parsed.path;
    return typeof path === 'string' && isSensitivePath(path);
  } catch {
    return false;
  }
}

function titleOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);
}

function findRepoRoot(cwd: string | undefined): Promise<string | null> {
  // Walks up looking for `.git`; paths from another machine or a container mount simply do not exist here.
  const walk = async (dir: string): Promise<string | null> => {
    if (
      await stat(`${dir}/.git`).then(
        () => true,
        () => false,
      )
    )
      return dir;
    const parent = dirname(dir);
    return parent === dir ? null : walk(parent);
  };
  return cwd?.startsWith('/') ? walk(cwd) : Promise.resolve(null);
}

export async function ingestFile(
  deps: PipelineDeps,
  source: { id: string; agent: Agent },
  path: string,
): Promise<IngestFileResult> {
  return withLock(`${source.id}:${path}`, () => run(deps, source, path));
}

async function run(
  deps: PipelineDeps,
  source: { id: string; agent: Agent },
  path: string,
): Promise<IngestFileResult> {
  const { db, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return { status: 'missing', events: 0, reset: false };

  const adapter = adapterFor(source.agent);
  const cursor = await db
    .selectFrom('ingest_cursor')
    .selectAll()
    .where('source_id', '=', source.id)
    .where('file_path', '=', path)
    .executeTakeFirst();

  let start = cursor?.byte_offset ?? 0;
  let reset = false;
  if (cursor) {
    const intact =
      st.size >= cursor.byte_offset &&
      (cursor.file_fingerprint === null ||
        (await fingerprintIntact(path, cursor.file_fingerprint)));
    if (!intact) {
      reset = true;
      start = 0;
    }
  }
  const nativeId = adapter.nativeIdFromPath(path);
  const sid = deriveSessionId(source.agent, nativeId);
  const fp = await currentFingerprint(path, st.size);

  if (!reset && cursor && st.size === start) {
    await upsertCursor(db, workspaceId, source.id, path, {
      offset: start,
      size: st.size,
      mtimeMs: st.mtimeMs,
      fp: cursor.file_fingerprint ?? fp,
      sid: cursor.session_id,
      now: now(),
    });
    return {
      status: 'unchanged',
      ...(cursor.session_id && { sessionId: cursor.session_id }),
      events: 0,
      reset: false,
    };
  }

  if (reset) {
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('event').where('session_id', '=', sid).execute();
      await tx.deleteFrom('signal').where('session_id', '=', sid).execute();
    });
  }

  const settings = await deps.settings.get();
  const redactionOn = settings['redaction.enabled'];
  const redactor: Redactor = createRedactor({
    key: deps.redactionKey,
    customPatterns: settings['redaction.custom_patterns'],
  });

  const existing = reset
    ? undefined
    : await db.selectFrom('session').selectAll().where('id', '=', sid).executeTakeFirst();
  const maxSeq = existing
    ? ((
        await db
          .selectFrom('event')
          .select((eb) => eb.fn.max('seq').as('m'))
          .where('session_id', '=', sid)
          .executeTakeFirst()
      )?.m ?? -1)
    : -1;
  let nextSeq = maxSeq + 1;

  const warnings: Warnings = {
    ...emptyWarnings(),
    ...(existing?.ingest_warnings ? (fromJson(existing.ingest_warnings) as Partial<Warnings>) : {}),
  };
  const s = {
    title: existing?.title ?? null,
    fallbackTitle: null as string | null,
    cwd: existing?.cwd ?? null,
    branch: existing?.branch ?? null,
    model: existing?.model ?? null,
    startedAt: existing?.started_at ?? null,
    endedAt: existing?.ended_at ?? null,
    tokensIn: existing?.tokens_in ?? 0,
    tokensOut: existing?.tokens_out ?? 0,
    outcomeKind: existing?.outcome_kind ?? ('none' as const),
    outcomeRef: existing?.outcome_ref ?? null,
    touched: existing !== undefined,
  };
  let usageDelta = { tokensIn: 0, tokensOut: 0 };
  let absoluteTokens: { tokensIn: number; tokensOut: number } | undefined;
  const usageByMessage = new Map<string, { tokensIn: number; tokensOut: number }>();

  let batch: EventRow[] = [];
  const batchCalls = new Map<string, EventRow>();
  let dbResults: Extract<ParsedItem, { type: 'result' }>[] = [];
  let batchChars = 0;
  let batchLines = 0;
  let lastEnd = start;

  const field = (text: string | undefined): { value: string | null; truncated: boolean } => {
    if (text === undefined || text === '') return { value: null, truncated: false };
    let truncated = false;
    let value = text;
    if (value.length > PRE_REDACT_CHARS) {
      value = trimToBoundary(value.slice(0, PRE_REDACT_CHARS));
      truncated = true;
    }
    if (redactionOn) {
      const r = redactor.redact(value);
      if (r.failed) warnings.redaction_failed += 1;
      value = r.text;
    }
    if (value.length > FIELD_CAP_CHARS) {
      value = value.slice(0, FIELD_CAP_CHARS);
      truncated = true;
    }
    return { value, truncated };
  };

  const track = (ts: string | undefined): void => {
    if (!ts) return;
    if (s.startedAt === null || ts < s.startedAt) s.startedAt = ts;
    if (s.endedAt === null || ts > s.endedAt) s.endedAt = ts;
  };

  const addEvent = (e: RawEvent): void => {
    const input = field(e.input);
    const output = field(e.output);
    const row: EventRow = {
      id: newId(),
      workspace_id: workspaceId,
      session_id: sid,
      seq: nextSeq++,
      ts: e.ts ?? null,
      kind: e.kind,
      name: e.name ?? null,
      input: input.value,
      output: output.value,
      is_error: e.isError ?? false,
      ms: null,
      truncated: input.truncated || output.truncated,
      call_id: e.callId ?? null,
    };
    batch.push(row);
    if (e.callId) batchCalls.set(e.callId, row);
    s.touched = true;
    track(e.ts);
    if (e.kind === 'user' && output.value && s.title === null) {
      const plain = output.value.trim();
      if (!plain.startsWith('<')) s.title = titleOf(plain);
      else s.fallbackTitle ??= titleOf(plain.replace(/<[^>]+>/g, ' ')) || null;
    }
    batchChars += (row.input?.length ?? 0) + (row.output?.length ?? 0) + 200;
  };

  const outputFor = (
    name: string | null,
    input: string | null,
    text: string,
  ): { value: string | null; truncated: boolean } =>
    readsSensitiveFile(name, input) && redactionOn
      ? { value: redactor.redactWhole(text), truncated: false }
      : field(text);

  const durationMs = (from: string | null | undefined, to: string | undefined): number | null => {
    if (!from || !to) return null;
    const ms = Date.parse(to) - Date.parse(from);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  };

  const handle = (item: ParsedItem): void => {
    switch (item.type) {
      case 'meta': {
        s.touched = true;
        track(item.ts);
        s.cwd ??= item.cwd ?? null;
        s.branch ??= item.branch ?? null;
        s.model ??= item.model ?? null;
        if (item.outcome) {
          s.outcomeKind = item.outcome.kind;
          s.outcomeRef = item.outcome.ref;
        }
        if (item.usage) {
          const prev = usageByMessage.get(item.usage.messageId) ?? { tokensIn: 0, tokensOut: 0 };
          usageDelta = {
            tokensIn: usageDelta.tokensIn + item.usage.tokensIn - prev.tokensIn,
            tokensOut: usageDelta.tokensOut + item.usage.tokensOut - prev.tokensOut,
          };
          usageByMessage.set(item.usage.messageId, item.usage);
        }
        if (item.totalTokens) absoluteTokens = item.totalTokens;
        break;
      }
      case 'event':
        addEvent(item.event);
        break;
      case 'result': {
        const row = batchCalls.get(item.callId);
        if (!row) {
          dbResults.push(item);
          break;
        }
        const out = outputFor(row.name ?? null, row.input ?? null, item.output);
        row.output = out.value;
        row.truncated = Boolean(row.truncated) || out.truncated;
        row.is_error = item.isError;
        row.ms = durationMs(row.ts, item.ts);
        track(item.ts);
        break;
      }
      case 'unknown':
        if (item.recordType === 'malformed-json') warnings.malformed += 1;
        else warnings.unknown += 1;
        addEvent({ kind: 'unknown', name: item.recordType, ...(item.ts && { ts: item.ts }) });
        break;
    }
  };

  const flush = async (offset: number): Promise<void> => {
    const toInsert = batch;
    const results = dbResults;
    batch = [];
    dbResults = [];
    batchCalls.clear();
    batchChars = 0;
    batchLines = 0;
    if (absoluteTokens) {
      s.tokensIn = absoluteTokens.tokensIn;
      s.tokensOut = absoluteTokens.tokensOut;
    } else {
      s.tokensIn += usageDelta.tokensIn;
      s.tokensOut += usageDelta.tokensOut;
    }
    usageDelta = { tokensIn: 0, tokensOut: 0 };
    const title = s.title ?? s.fallbackTitle;
    const repoRoot = s.touched ? await findRepoRoot(s.cwd ?? undefined) : null;
    const startedAt = s.startedAt ?? new Date(st.mtimeMs).toISOString();
    await db.transaction().execute(async (tx) => {
      if (s.touched) {
        const values = {
          title: title ? titleOf(title) : null,
          repo: s.cwd ? basename(repoRoot ?? s.cwd) : null,
          repo_root: repoRoot,
          branch: s.branch,
          cwd: s.cwd,
          started_at: startedAt,
          ended_at: s.endedAt,
          duration_s: s.endedAt
            ? Math.max(0, Math.round((Date.parse(s.endedAt) - Date.parse(startedAt)) / 1000))
            : null,
          tokens_in: s.tokensIn,
          tokens_out: s.tokensOut,
          model: s.model,
          status: 'active',
          outcome_kind: s.outcomeKind,
          outcome_ref: s.outcomeRef,
          adapter_version: adapter.version,
          redaction_version: redactionOn ? REDACTION_VERSION : 'off',
          ingest_warnings: Object.values(warnings).some((n) => n > 0) ? toJson(warnings) : null,
        } as const;
        await tx
          .insertInto('session')
          .values({
            id: sid,
            workspace_id: workspaceId,
            user_id: deps.userId,
            agent: source.agent,
            native_id: nativeId,
            created_at: now().toISOString(),
            ...values,
          })
          .onConflict((oc) => oc.column('id').doUpdateSet(values))
          .execute();
      }
      for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
        await tx
          .insertInto('event')
          .values(toInsert.slice(i, i + INSERT_CHUNK))
          .execute();
      }
      for (const r of results) {
        const target = await tx
          .selectFrom('event')
          .select(['id', 'name', 'input', 'ts', 'truncated'])
          .where('session_id', '=', sid)
          .where('call_id', '=', r.callId)
          .executeTakeFirst();
        if (!target) continue;
        const out = outputFor(target.name, target.input, r.output);
        await tx
          .updateTable('event')
          .set({
            output: out.value,
            is_error: r.isError,
            ms: durationMs(target.ts, r.ts),
            truncated: asBool(target.truncated) || out.truncated,
          })
          .where('id', '=', target.id)
          .execute();
      }
      await upsertCursor(tx, workspaceId, source.id, path, {
        offset,
        size: st.size,
        mtimeMs: st.mtimeMs,
        fp,
        sid: s.touched ? sid : null,
        now: now(),
      });
    });
  };

  const parser = adapter.createParser();
  for await (const line of readLines(path, start, st.size, MAX_LINE_BYTES)) {
    lastEnd = line.endOffset;
    batchLines += 1;
    if (line.text === null) {
      if (!line.head.startsWith('{"type":"api-request')) {
        warnings.oversized += 1;
        addEvent({ kind: 'unknown', name: 'oversized-record' });
      }
    } else if (line.text.trim() !== '') {
      batchChars += line.text.length >> 4; // parsing cost, not payload size
      for (const item of parser.parseLine(line.text)) handle(item);
    }
    if (batchLines >= BATCH_LINES || batchChars >= BATCH_CHARS) await flush(lastEnd);
  }
  await flush(lastEnd);

  const eventCount =
    (
      await db
        .selectFrom('event')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('session_id', '=', sid)
        .executeTakeFirst()
    )?.n ?? 0;
  if (s.touched && now().getTime() - st.mtimeMs >= SESSION_IDLE_MS) {
    await finalizeSession(db, workspaceId, sid, now());
  }
  return { status: 'ingested', ...(s.touched && { sessionId: sid }), events: eventCount, reset };
}

async function upsertCursor(
  db: Db,
  workspaceId: string,
  sourceId: string,
  path: string,
  c: {
    offset: number;
    size: number;
    mtimeMs: number;
    fp: string | null;
    sid: string | null;
    now: Date;
  },
): Promise<void> {
  const values = {
    file_fingerprint: c.fp,
    byte_offset: c.offset,
    size: c.size,
    mtime_ms: Math.floor(c.mtimeMs),
    session_id: c.sid,
    updated_at: c.now.toISOString(),
  };
  await db
    .insertInto('ingest_cursor')
    .values({ workspace_id: workspaceId, source_id: sourceId, file_path: path, ...values })
    .onConflict((oc) => oc.columns(['source_id', 'file_path']).doUpdateSet(values))
    .execute();
}
