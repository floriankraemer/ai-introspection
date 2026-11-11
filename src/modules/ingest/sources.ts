import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { newId } from '../../platform/db/ids.js';
import { asBool, fromJson, toJson } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { ConflictError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import { adapterFor } from './adapters/index.js';
import type { S3Remote } from './s3.js';
import { AGENTS, type Agent } from './types.js';

export type SourceKind = 'folder' | 'intake' | 's3';
export type SourceStatus = 'watching' | 'polling' | 'disabled' | 'missing';

export interface SourceDto {
  id: string;
  agent: Agent;
  path: string;
  kind: SourceKind;
  /** Connection settings of an S3 source (no credentials); null for other kinds. */
  remote: S3Remote | null;
  enabled: boolean;
  status: SourceStatus;
  /** Who pushes to an intake source; null for the other kinds. */
  person: { id: string; name: string } | null;
  /** Sessions ingested from this source; they stay when the source is removed. */
  sessionCount: number;
}

export interface RemovedSource {
  id: string;
  agent: Agent;
  path: string;
  kind: SourceKind;
  userId: string;
}

export interface DetectedSource {
  agent: Agent;
  path: string;
  sessionCount: number;
}

/** Host-native defaults, and the fixed mount points of compose.yaml. */
function candidates(): { agent: Agent; path: string }[] {
  const home = homedir();
  return [
    { agent: 'claude_code', path: '/sources/claude/projects' },
    { agent: 'claude_code', path: join(home, '.claude', 'projects') },
    { agent: 'codex', path: '/sources/codex/sessions' },
    { agent: 'codex', path: join(home, '.codex', 'sessions') },
  ];
}

/** Session log files below `root` that the agent's adapter accepts. */
export async function* listSessionFiles(agent: Agent, root: string): AsyncGenerator<string> {
  const adapter = adapterFor(agent);
  async function* walk(dir: string): AsyncGenerator<string> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.jsonl') &&
        adapter.matches(relative(root, full))
      )
        yield full;
    }
  }
  yield* walk(root);
}

async function countFiles(agent: Agent, root: string): Promise<number> {
  let n = 0;
  const files = listSessionFiles(agent, root);
  while (!(await files.next()).done) n += 1;
  return n;
}

export async function detectSources(): Promise<DetectedSource[]> {
  const seen = new Set<string>();
  const found: DetectedSource[] = [];
  for (const c of candidates()) {
    if (!existsSync(c.path)) continue;
    const real = await realpath(c.path);
    if (seen.has(`${c.agent}:${real}`)) continue;
    seen.add(`${c.agent}:${real}`);
    found.push({ agent: c.agent, path: c.path, sessionCount: await countFiles(c.agent, c.path) });
  }
  return found;
}

/** Rows from before paths were normalised may end in a slash; the watcher compares with `${path}/`. */
const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);

/**
 * Where the API may register sources: the compose mount points, or the user's home in a native install.
 * Inside the container HOME is `/tmp`, which is no place to read agent logs from.
 */
export function defaultSourceRoots(): string[] {
  const home = homedir();
  return home === '/' || home === '/tmp' ? ['/sources'] : ['/sources', home];
}

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}${sep}`);

export function createSources(
  db: Db,
  workspaceId: string,
  userId: string,
  pollMode: boolean,
  now: () => Date = () => new Date(),
  /** Set for registrations that come in over the API, which must not reach beyond log folders. */
  guard: { roots: readonly string[]; dataDir: string } = { roots: [], dataDir: '' },
) {
  const refusal = async (path: string): Promise<string | null> => {
    const roots = await Promise.all(guard.roots.map((r) => realpath(r).catch(() => r)));
    const data = await realpath(guard.dataDir).catch(() => guard.dataDir);
    if (path === '/' || overlaps(path, data))
      return `"${path}" holds Introspect's own data and cannot be a log source`;
    if (!roots.some((r) => within(path, r)))
      return `"${path}" is outside the folders log sources may come from (${guard.roots.join(', ')})`;
    return null;
  };
  const toDto = (
    row: {
      id: string;
      agent: string;
      path: string;
      kind: string;
      remote: string | null;
      enabled: boolean | number;
      user_id: string;
      display_name: string;
    },
    sessionCount: number,
  ): SourceDto => {
    const enabled = asBool(row.enabled);
    const status: SourceStatus = !enabled
      ? 'disabled'
      : !existsSync(row.path)
        ? 'missing'
        : pollMode
          ? 'polling'
          : 'watching';
    return {
      id: row.id,
      agent: row.agent as Agent,
      path: row.path,
      kind: row.kind as SourceKind,
      remote: row.remote === null ? null : (fromJson(row.remote) as S3Remote),
      enabled,
      status,
      person: row.kind === 'intake' ? { id: row.user_id, name: row.display_name } : null,
      sessionCount,
    };
  };
  /** Distinct sessions per source in one grouped query. */
  const sessionCounts = async (): Promise<Map<string, number>> => {
    const rows = await db
      .selectFrom('ingest_cursor')
      .select(['source_id', (eb) => eb.fn.count('session_id').distinct().as('n')])
      .where('workspace_id', '=', workspaceId)
      .groupBy('source_id')
      .execute();
    return new Map(rows.map((r) => [r.source_id, Number(r.n)]));
  };
  const dtoById = async (id: string): Promise<SourceDto> => {
    const row = await selectDtoRows()
      .where('source.workspace_id', '=', workspaceId)
      .where('source.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Source not found');
    return toDto(row, (await sessionCounts()).get(id) ?? 0);
  };
  const selectDtoRows = () =>
    db
      .selectFrom('source')
      .innerJoin('app_user', 'app_user.id', 'source.user_id')
      .select([
        'source.id',
        'source.agent',
        'source.path',
        'source.kind',
        'source.remote',
        'source.enabled',
        'source.user_id',
        'app_user.display_name',
      ]);

  return {
    async list(): Promise<SourceDto[]> {
      const rows = await selectDtoRows()
        .where('source.workspace_id', '=', workspaceId)
        .orderBy('source.created_at')
        .orderBy('source.id')
        .execute();
      const counts = await sessionCounts();
      return rows.map((r) => toDto(r, counts.get(r.id) ?? 0));
    },

    /** Folder and S3 sources only: an intake source is switched off by revoking the person's token. */
    async setEnabled(id: string, enabled: boolean): Promise<SourceDto> {
      const row = await db
        .selectFrom('source')
        .select('kind')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new NotFoundError('Source not found');
      if (row.kind === 'intake')
        throw new InvalidInputError(
          "A pushed source cannot be disabled; revoke the person's token instead",
        );
      await db.updateTable('source').set({ enabled }).where('id', '=', id).execute();
      return dtoById(id);
    },

    async find(id: string): Promise<RemovedSource> {
      const row = await db
        .selectFrom('source')
        .select(['id', 'agent', 'path', 'kind', 'user_id'])
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new NotFoundError('Source not found');
      return {
        id: row.id,
        agent: row.agent as Agent,
        path: trimSlash(row.path),
        kind: row.kind,
        userId: row.user_id,
      };
    },

    /** Deletes the row (cursors cascade, sessions stay) and returns it so the caller can clean up. */
    async remove(id: string): Promise<RemovedSource> {
      const row = await this.find(id);
      await db.deleteFrom('source').where('id', '=', id).execute();
      return row;
    },

    /**
     * Idempotent per (agent, real path): trailing slashes and symlinks name the same folder.
     * A folder inside or around another source of the same agent would ingest its files twice.
     */
    async add(
      agent: Agent,
      given: string,
      opts: { restrict?: boolean; kind?: SourceKind; userId?: string } = {},
    ): Promise<SourceDto> {
      if (!AGENTS.includes(agent)) throw new InvalidInputError(`Unknown agent "${agent}"`);
      if (!given.startsWith('/')) throw new InvalidInputError('The path must be absolute');
      const path = await realpath(given).catch(() => null);
      if (!path || !(await stat(path)).isDirectory()) {
        throw new InvalidInputError(`"${given}" is not a folder this server can read`);
      }
      if (opts.restrict) {
        const why = await refusal(path);
        if (why) throw new InvalidInputError(why);
      }
      for (const other of await db
        .selectFrom('source')
        .select('path')
        .where('workspace_id', '=', workspaceId)
        .where('agent', '=', agent)
        .execute()) {
        const real = (await realpath(other.path).catch(() => null)) ?? trimSlash(other.path);
        if (real !== path && overlaps(real, path)) {
          throw new ConflictError(
            `"${path}" overlaps the registered source "${other.path}"; its session files would be imported twice`,
          );
        }
      }
      await db
        .insertInto('source')
        .values({
          id: newId(),
          workspace_id: workspaceId,
          user_id: opts.userId ?? userId,
          agent,
          path,
          kind: opts.kind ?? 'folder',
          created_at: now().toISOString(),
        })
        .onConflict((oc) => oc.columns(['workspace_id', 'agent', 'path']).doNothing())
        .execute();
      const row = await selectDtoRows()
        .where('source.workspace_id', '=', workspaceId)
        .where('source.agent', '=', agent)
        .where('source.path', 'in', [path, `${path}/`])
        .executeTakeFirstOrThrow();
      return toDto(row, (await sessionCounts()).get(row.id) ?? 0);
    },

    /**
     * Registers an S3 source whose files are cached in `dir` (created here). Idempotent per agent
     * and bucket location; the folder rules of `add` do not apply because the folder is ours.
     */
    async addS3(
      agent: Agent,
      remote: S3Remote,
      dirFor: (sourceId: string) => Promise<string>,
    ): Promise<SourceDto> {
      if (!AGENTS.includes(agent)) throw new InvalidInputError(`Unknown agent "${agent}"`);
      const same = (r: S3Remote): boolean =>
        r.bucket === remote.bucket &&
        r.prefix === remote.prefix &&
        (r.endpoint ?? '') === (remote.endpoint ?? '');
      for (const row of await this.list()) {
        if (row.kind === 's3' && row.agent === agent && row.remote && same(row.remote)) return row;
      }
      const id = newId();
      await db
        .insertInto('source')
        .values({
          id,
          workspace_id: workspaceId,
          user_id: userId,
          agent,
          path: await dirFor(id),
          kind: 's3',
          remote: toJson(remote),
          created_at: now().toISOString(),
        })
        .execute();
      return dtoById(id);
    },

    async enabledRows(): Promise<
      {
        id: string;
        agent: Agent;
        path: string;
        createdAt: string;
        userId: string;
        kind: SourceKind;
        remote: S3Remote | null;
      }[]
    > {
      const rows = await db
        .selectFrom('source')
        .select(['id', 'agent', 'path', 'created_at', 'user_id', 'kind', 'remote'])
        .where('workspace_id', '=', workspaceId)
        .where('enabled', '=', true)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        agent: r.agent as Agent,
        path: trimSlash(r.path),
        createdAt: r.created_at,
        userId: r.user_id,
        kind: r.kind,
        remote: r.remote === null ? null : (fromJson(r.remote) as S3Remote),
      }));
    },
  };
}

export type Sources = ReturnType<typeof createSources>;
