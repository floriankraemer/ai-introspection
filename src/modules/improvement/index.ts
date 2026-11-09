import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newId } from '../../platform/db/ids.js';
import { asBool } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { InvalidInputError } from '../../platform/errors.js';
import { isGitRepoRoot } from '../../platform/git/index.js';
import { hasRubrics } from '../rubrics/index.js';

export interface SkillRepoDto {
  id: string;
  kind: 'global' | 'project';
  path: string;
  /** True when `<path>/rubrics/` exists and holds at least one rubric file. */
  hasRubrics: boolean;
  enabled: boolean;
  acceptMode: 'merge' | 'pr' | null;
}

export interface DetectedSkillRepo {
  path: string;
  isGitRepo: boolean;
  hasRubrics: boolean;
}

/** The fixed mount point of compose.yaml first, then the host-native default for the npm install. */
const SKILL_REPO_CANDIDATES = ['/repos/skills', join(homedir(), '.claude')];

/** Existing folders where a global skills repository usually lives, for the setup wizard to propose. */
export async function detectSkillRepos(): Promise<DetectedSkillRepo[]> {
  const found: DetectedSkillRepo[] = [];
  const seen = new Set<string>();
  for (const path of SKILL_REPO_CANDIDATES) {
    const real = await realpath(path).catch(() => null);
    if (!real || seen.has(real) || !(await stat(real)).isDirectory()) continue;
    seen.add(real);
    found.push({ path, isGitRepo: await isGitRepoRoot(real), hasRubrics: await hasRubrics(real) });
  }
  return found;
}

export function createSkillRepos(db: Db, workspaceId: string) {
  const select = () =>
    db
      .selectFrom('skill_repo')
      .select(['id', 'kind', 'path', 'enabled', 'accept_mode'])
      .where('workspace_id', '=', workspaceId);
  type Row = Awaited<ReturnType<ReturnType<typeof select>['execute']>>[number];

  const toDto = async (r: Row): Promise<SkillRepoDto> => ({
    id: r.id,
    kind: r.kind,
    path: r.path,
    hasRubrics: await hasRubrics(r.path),
    enabled: asBool(r.enabled),
    acceptMode: r.accept_mode === 'merge' || r.accept_mode === 'pr' ? r.accept_mode : null,
  });

  return {
    async list(): Promise<SkillRepoDto[]> {
      const rows = await select().orderBy('kind').orderBy('path').execute();
      return Promise.all(rows.map(toDto));
    },

    async getGlobal(): Promise<SkillRepoDto | null> {
      const row = await select().where('kind', '=', 'global').executeTakeFirst();
      return row ? toDto(row) : null;
    },

    /** There is one global repo; setting another path replaces it. The path must be the root of a git work tree. */
    async putGlobal(path: string): Promise<SkillRepoDto> {
      if (!path.startsWith('/')) throw new InvalidInputError('The path must be absolute');
      const real = await realpath(path).catch(() => null);
      if (!real || !(await isGitRepoRoot(real))) {
        throw new InvalidInputError(`"${path}" is not the root of a git repository`);
      }
      const existing = await select().where('kind', '=', 'global').executeTakeFirst();
      if (existing) {
        await db
          .updateTable('skill_repo')
          .set({ path: real })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('skill_repo')
          .values({ id: newId(), workspace_id: workspaceId, kind: 'global', path: real })
          .execute();
      }
      const saved = await this.getGlobal();
      if (!saved) throw new Error('The global skills repository vanished after saving');
      return saved;
    },

    async setEnabled(id: string, enabled: boolean): Promise<SkillRepoDto | null> {
      await db
        .updateTable('skill_repo')
        .set({ enabled })
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .execute();
      const row = await select().where('id', '=', id).executeTakeFirst();
      return row ? toDto(row) : null;
    },
  };
}

export type SkillRepos = ReturnType<typeof createSkillRepos>;
