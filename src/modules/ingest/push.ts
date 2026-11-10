import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { gzipSync, createGzip } from 'node:zlib';
import { dialectOf, openDatabase } from '../../platform/db/connection.js';
import { sessionId as deriveSessionId } from '../../platform/db/ids.js';
import { asBool, fromJson } from '../../platform/db/json.js';
import { migrateToLatest } from '../../platform/db/migrate.js';
import { InvalidInputError } from '../../platform/errors.js';
import { transportAllowed } from '../../platform/transport.js';
import {
  ensureLocalIdentity,
  LOCAL_USER_ID,
  LOCAL_WORKSPACE_ID,
} from '../../platform/identity/index.js';
import { createSecretStore, createSettings } from '../settings/index.js';
import { adapterFor } from './adapters/index.js';
import { finalizeSession } from './finalize.js';
import { ingestFile, SESSION_IDLE_MS, type PipelineDeps } from './pipeline.js';
import { loadOrCreateRedactionKey, REDACTION_VERSION } from './redaction.js';
import { createSources, detectSources, listSessionFiles } from './sources.js';
import type { PushedTrace } from './intake.js';
import type { Agent } from './types.js';

export interface PushOptions {
  server: string;
  token: string;
  /** Parse and redact here; send sessions instead of raw logs. */
  redact: boolean;
  /** Skip files last written before this. */
  since?: Date | undefined;
  /** Log roots; empty means the host's detected Claude Code and Codex folders. */
  dirs: { agent: Agent; path: string }[];
  dryRun: boolean;
  /** Allow plain http to a host that is not this machine. */
  insecure: boolean;
  dataDir: string;
  /** The pusher's own Introspect database; `--redact` applies its custom redaction patterns. */
  databaseUrl: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PushSummary {
  pushed: number;
  unchanged: number;
  failed: number;
  errors: string[];
}

interface StateEntry {
  size: number;
  mtimeMs: number;
  mode: 'raw' | 'redacted';
  adapterVersion: string;
  redactionVersion: string | null;
  ended: boolean;
}
type State = Record<string, Record<string, StateEntry>>;

/** Raw logs hold secrets: they travel over TLS unless the server is this machine. */
function checkServer(server: string, insecure: boolean): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new InvalidInputError(`"${server}" is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new InvalidInputError('The server URL must start with https:// or http://');
  if (!transportAllowed(url, insecure))
    throw new InvalidInputError(
      `Refusing to send session logs over plain http to ${url.hostname}; use https, or pass --insecure`,
    );
  return url.toString().replace(/\/+$/, '');
}

async function loadState(file: string): Promise<State> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as State;
  } catch {
    return {};
  }
}

/**
 * Records one pushed file. The file is read again just before the write, so a push running
 * alongside (cron and a manual run) keeps its entries; the rename makes each write atomic.
 */
async function saveEntry(
  file: string,
  server: string,
  path: string,
  entry: StateEntry,
): Promise<void> {
  // ponytail: a write landing between another run's read and rename is lost; that file is just pushed again next run.
  const state = await loadState(file);
  (state[server] ??= {})[path] = entry;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

const CONFLICT_HINT =
  '. The server already holds this session in the other mode (raw vs --redact) or from another person; push it the way you first did.';

async function problem(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const p = JSON.parse(text) as { title?: string; detail?: string };
    return `${String(res.status)} ${p.title ?? ''}${p.detail ? `: ${p.detail}` : ''}`.trim();
  } catch {
    return `${String(res.status)} ${text.slice(0, 200)}`.trim();
  }
}

/**
 * The custom redaction patterns of the pusher's own Introspect. No local database means the
 * defaults; a database that exists but cannot be read refuses, so no rule is silently dropped.
 */
async function localPatterns(
  databaseUrl: string,
  dataDir: string,
  log: (line: string) => void,
): Promise<string[]> {
  if (dialectOf(databaseUrl) === 'sqlite' && !existsSync(databaseUrl)) {
    log(
      `No local Introspect database at ${databaseUrl}: redacting with the default rules only, without custom patterns.`,
    );
    return [];
  }
  let local: ReturnType<typeof openDatabase> | undefined;
  try {
    local = openDatabase(databaseUrl);
    const settings = createSettings(local.db, LOCAL_WORKSPACE_ID, createSecretStore(dataDir));
    return (await settings.get())['redaction.custom_patterns'];
  } catch (e) {
    throw new Error(
      `Cannot read the custom redaction patterns of your local Introspect database (${e instanceof Error ? e.message : String(e)}); nothing was pushed`,
      { cause: e },
    );
  } finally {
    await local?.close();
  }
}

/** One in-memory database per run so `ingestFile` redacts exactly as the server pipeline does. */
async function openRedactor(dataDir: string, customPatterns: string[], now: () => Date) {
  const handle = openDatabase(':memory:');
  await migrateToLatest(handle);
  await ensureLocalIdentity(handle.db, now());
  const settings = createSettings(handle.db, LOCAL_WORKSPACE_ID, createSecretStore(dataDir), now);
  await settings.update({ 'redaction.custom_patterns': customPatterns });
  const deps: PipelineDeps = {
    db: handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    redactionKey: loadOrCreateRedactionKey(dataDir),
    settings,
    now,
  };
  const sources = createSources(handle.db, LOCAL_WORKSPACE_ID, LOCAL_USER_ID, false, now);

  return {
    close: () => handle.close(),
    /** The file as a redacted session, ready to PUT. */
    async trace(agent: Agent, root: string, file: string, idle: boolean): Promise<PushedTrace> {
      const source = await sources.add(agent, root);
      const result = await ingestFile(deps, { id: source.id, agent, userId: LOCAL_USER_ID }, file);
      if (!result.sessionId) throw new Error('Nothing in the file could be read as a session');
      const sid = result.sessionId;
      if (idle) await finalizeSession(handle.db, LOCAL_WORKSPACE_ID, sid, now());
      const s = await handle.db
        .selectFrom('session')
        .selectAll()
        .where('id', '=', sid)
        .executeTakeFirstOrThrow();
      // Never send what was not redacted: the server would refuse it, and it must not leave here.
      if (s.redaction_version === null || s.redaction_version === 'off')
        throw new Error('Redaction is off, so the session is not sent');
      const events = await handle.db
        .selectFrom('event')
        .selectAll()
        .where('session_id', '=', sid)
        .orderBy('seq')
        .execute();
      // Bound the memory of a long run: this session is done once its body is built.
      await handle.db.deleteFrom('event').where('session_id', '=', sid).execute();
      return {
        agent,
        nativeId: s.native_id,
        adapterVersion: s.adapter_version ?? adapterFor(agent).version,
        redactionVersion: s.redaction_version,
        ended: idle,
        session: {
          title: s.title,
          cwd: s.cwd,
          repo: s.repo,
          branch: s.branch,
          model: s.model,
          startedAt: s.started_at ?? new Date().toISOString(),
          endedAt: s.ended_at,
          tokensIn: s.tokens_in,
          tokensOut: s.tokens_out,
          tokensCacheRead: s.tokens_cache_read,
          tokensCacheWrite: s.tokens_cache_write,
          outcomeKind: s.outcome_kind,
          outcomeRef: s.outcome_ref,
          warnings: s.ingest_warnings ? (fromJson(s.ingest_warnings) as never) : null,
        },
        events: events.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          kind: e.kind as PushedTrace['events'][number]['kind'],
          name: e.name,
          input: e.input,
          output: e.output,
          isError: asBool(e.is_error),
          ms: e.ms,
          truncated: asBool(e.truncated),
          callId: e.call_id,
          sourceKey: e.source_key,
        })),
      };
    },
  };
}

/** Pushes every session log that changed since the last run to the intake at `opts.server`. */
export async function runPush(opts: PushOptions): Promise<PushSummary> {
  const server = checkServer(opts.server, opts.insecure);
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const summary: PushSummary = { pushed: 0, unchanged: 0, failed: 0, errors: [] };

  // The container mount points are no host folders.
  const dirs =
    opts.dirs.length > 0
      ? opts.dirs
      : (await detectSources()).filter((d) => !d.path.startsWith('/sources/'));
  const stateFile = join(opts.dataDir, 'push-state.json');
  const known = (await loadState(stateFile))[server] ?? {};
  const redactor =
    opts.redact && !opts.dryRun
      ? await openRedactor(
          opts.dataDir,
          await localPatterns(opts.databaseUrl, opts.dataDir, log),
          now,
        )
      : null;
  const mode = opts.redact ? 'redacted' : 'raw';

  try {
    for (const { agent, path } of dirs) {
      const root = await realpath(path).catch(() => null);
      if (!root) {
        summary.failed += 1;
        summary.errors.push(`${path}: not a folder this machine can read`);
        continue;
      }
      const adapterVersion = adapterFor(agent).version;
      for await (const file of listSessionFiles(agent, root)) {
        const st = await stat(file).catch(() => null);
        if (!st || st.mtimeMs < (opts.since?.getTime() ?? 0)) continue;
        const idle = now().getTime() - st.mtimeMs >= SESSION_IDLE_MS;
        const prev = known[file];
        const redactionVersion = opts.redact ? REDACTION_VERSION : null;
        const due =
          prev?.size !== st.size ||
          prev.mtimeMs !== st.mtimeMs ||
          prev.mode !== mode ||
          prev.adapterVersion !== adapterVersion ||
          prev.redactionVersion !== redactionVersion ||
          // A raw log is finalized by the server from its mtime; a redacted session must say it ended.
          (opts.redact && !prev.ended && idle);
        if (!due) {
          summary.unchanged += 1;
          continue;
        }
        const rel = relative(root, file).split(sep).map(encodeURIComponent).join('/');
        if (opts.dryRun) {
          log(`would push ${file}`);
          summary.pushed += 1;
          continue;
        }
        try {
          const res = redactor
            ? await putSession(server, opts.token, await redactor.trace(agent, root, file, idle))
            : await putRaw(server, opts.token, agent, rel, file, st.mtimeMs);
          if (!res.ok)
            throw new Error(`${await problem(res)}${res.status === 409 ? CONFLICT_HINT : ''}`);
          await saveEntry(stateFile, server, file, {
            size: st.size,
            mtimeMs: st.mtimeMs,
            mode,
            adapterVersion,
            redactionVersion,
            ended: idle,
          });
          summary.pushed += 1;
          log(`pushed ${file}`);
        } catch (e) {
          summary.failed += 1;
          const message = `${file}: ${e instanceof Error ? e.message : String(e)}`;
          summary.errors.push(message);
          log(`failed ${message}`);
        }
      }
    }
  } finally {
    await redactor?.close();
  }
  return summary;
}

function putRaw(
  server: string,
  token: string,
  agent: Agent,
  rel: string,
  file: string,
  mtimeMs: number,
): Promise<Response> {
  const gz = createGzip();
  const source = createReadStream(file);
  source.on('error', (e) => gz.destroy(e));
  source.pipe(gz);
  return fetch(`${server}/v1/intake/logs/${agent}/${rel}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-ndjson',
      'content-encoding': 'gzip',
      'x-introspect-mtime': String(Math.floor(mtimeMs)),
    },
    body: Readable.toWeb(gz) as WebReadableStream<Uint8Array>,
    duplex: 'half',
    // A redirect could carry the token and the log to another host.
    redirect: 'error',
  } as RequestInit);
}

function putSession(server: string, token: string, trace: PushedTrace): Promise<Response> {
  const id = deriveSessionId(trace.agent, trace.nativeId);
  return fetch(`${server}/v1/intake/sessions/${id}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    body: new Uint8Array(gzipSync(JSON.stringify(trace))),
    redirect: 'error',
  });
}
