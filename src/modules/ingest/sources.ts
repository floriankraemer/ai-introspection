import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { newId } from '../../platform/db/ids.js';
import { asBool } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { InvalidInputError } from '../../platform/errors.js';
import { adapterFor } from './adapters/index.js';
import { AGENTS, type Agent } from './types.js';

export type SourceStatus = 'watching' | 'polling' | 'disabled' | 'missing';

export interface SourceDto {
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

export function createSources(db: Db, workspaceId: string, userId: string, pollMode: boolean) {
  const toDto = (row: {
    id: string;
    agent: string;
    path: string;
    enabled: boolean | number;
  }): SourceDto => {
    const enabled = asBool(row.enabled);
    const status: SourceStatus = !enabled
      ? 'disabled'
      : !existsSync(row.path)
        ? 'missing'
        : pollMode
          ? 'polling'
          : 'watching';
    return { id: row.id, agent: row.agent as Agent, path: row.path, enabled, status };
  };

  return {
    async list(): Promise<SourceDto[]> {
      const rows = await db
        .selectFrom('source')
        .select(['id', 'agent', 'path', 'enabled'])
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(toDto);
    },

    /** Idempotent per (agent, path). */
    async add(agent: Agent, path: string): Promise<SourceDto> {
      if (!AGENTS.includes(agent)) throw new InvalidInputError(`Unknown agent "${agent}"`);
      if (!path.startsWith('/')) throw new InvalidInputError('The path must be absolute');
      if (
        !(await stat(path).then(
          (s) => s.isDirectory(),
          () => false,
        ))
      ) {
        throw new InvalidInputError(`"${path}" is not a folder this server can read`);
      }
      await db
        .insertInto('source')
        .values({
          id: newId(),
          workspace_id: workspaceId,
          user_id: userId,
          agent,
          path,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.columns(['workspace_id', 'agent', 'path']).doNothing())
        .execute();
      const row = await db
        .selectFrom('source')
        .select(['id', 'agent', 'path', 'enabled'])
        .where('workspace_id', '=', workspaceId)
        .where('agent', '=', agent)
        .where('path', '=', path)
        .executeTakeFirstOrThrow();
      return toDto(row);
    },

    async enabledRows(): Promise<{ id: string; agent: Agent; path: string; createdAt: string }[]> {
      const rows = await db
        .selectFrom('source')
        .select(['id', 'agent', 'path', 'created_at'])
        .where('workspace_id', '=', workspaceId)
        .where('enabled', '=', true)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        agent: r.agent as Agent,
        path: r.path,
        createdAt: r.created_at,
      }));
    },
  };
}

export type Sources = ReturnType<typeof createSources>;
