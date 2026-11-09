import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { newId } from '../../platform/db/ids.js';
import { asBool, fromJson } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { ConflictError, InvalidInputError } from '../../platform/errors.js';
import { initRepo, isGitRepoRoot } from '../../platform/git/index.js';
import { copyStarterRubrics, hasRubrics } from '../rubrics/index.js';

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
  /** A folder with no entries at all (not even hidden ones): Introspect may initialise it. */
  isEmpty: boolean;
}

/** The fixed mount point of compose.yaml first, then the host-native default for the npm install. */
const SKILL_REPO_CANDIDATES = ['/repos/skills', join(homedir(), '.claude')];
/** Folders below which Introspect may create a repository: the compose mounts, and the data folder of a host install. */
const MOUNT_ROOTS = ['/repos', join(homedir(), '.introspect')];

/** Project repositories must live below one of these: the compose mount, and the data folder of a host install. */
const PROJECT_ROOTS = ['/repos/projects', join(homedir(), '.introspect', 'projects')];

/** A registered repository with everything the improver needs. */
export interface SkillRepoRow {
  id: string;
  kind: 'global' | 'project';
  path: string;
  defaultBranch: string | null;
  /** Glob allow-list override; null means the kind's default. */
  allowList: string[] | null;
  acceptMode: 'merge' | 'pr' | null;
  enabled: boolean;
}

export interface SkillReposOptions {
  /** Init is only allowed below one of these (tests inject their own). */
  mountRoots?: readonly string[];
  /** Project repositories may only be registered below one of these. */
  projectRoots?: readonly string[];
  candidates?: readonly string[];
}

/** Existing folders where a global skills repository usually lives, for the setup wizard to propose. */
export async function detectSkillRepos(
  candidates: readonly string[] = SKILL_REPO_CANDIDATES,
): Promise<DetectedSkillRepo[]> {
  const found: DetectedSkillRepo[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    const real = await realpath(path).catch(() => null);
    if (!real || seen.has(real) || !(await stat(real)).isDirectory()) continue;
    seen.add(real);
    found.push({
      path,
      isGitRepo: await isGitRepoRoot(real),
      hasRubrics: await hasRubrics(real),
      isEmpty: (await readdir(real)).length === 0,
    });
  }
  return found;
}

/** The real path `target` would have: symlinks of the nearest existing ancestor are resolved, so `..` and links cannot leave a root. */
async function resolveEventually(target: string): Promise<string> {
  let existing = target;
  while (
    !(await stat(existing).then(
      () => true,
      () => false,
    ))
  )
    existing = dirname(existing);
  return join(await realpath(existing), relative(existing, target));
}

export function createSkillRepos(db: Db, workspaceId: string, options: SkillReposOptions = {}) {
  const mountRoots = options.mountRoots ?? MOUNT_ROOTS;
  const projectRoots = options.projectRoots ?? PROJECT_ROOTS;
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

  const toRow = (r: {
    id: string;
    kind: 'global' | 'project';
    path: string;
    default_branch: string | null;
    allow_list: string | null;
    accept_mode: string | null;
    enabled: boolean | number;
  }): SkillRepoRow => ({
    id: r.id,
    kind: r.kind,
    path: r.path,
    defaultBranch: r.default_branch,
    allowList: r.allow_list === null ? null : (fromJson(r.allow_list) as string[]),
    acceptMode: r.accept_mode === 'merge' || r.accept_mode === 'pr' ? r.accept_mode : null,
    enabled: asBool(r.enabled),
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

    detect: (): Promise<DetectedSkillRepo[]> => detectSkillRepos(options.candidates),

    /**
     * Creates the global repository for users who have none: `git init` on `main`, the starter
     * rubrics, one commit. Only an empty (or missing) folder below a mounted root qualifies, so
     * this can never touch existing files.
     */
    async initGlobal(given: string): Promise<SkillRepoDto> {
      if (!given.startsWith('/')) throw new InvalidInputError('The path must be absolute');
      const target = await resolveEventually(resolve(given));
      const roots = await Promise.all(mountRoots.map((r) => realpath(r).catch(() => null)));
      if (!roots.some((r) => r !== null && target.startsWith(r + sep))) {
        throw new InvalidInputError(
          `Introspect only creates a repository below ${mountRoots.join(' or ')}`,
        );
      }
      const entries = await readdir(target).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new InvalidInputError(`"${given}" is not a folder`);
      });
      if (entries.length > 0) {
        throw new ConflictError(
          `"${given}" is not empty; point Introspect at it as an existing repository instead`,
        );
      }
      await mkdir(target, { recursive: true });
      await initRepo(target);
      await copyStarterRubrics(target);
      return this.putGlobal(target);
    },

    /** Enable or disable a repository, and set or clear (null) its accept-mode override. */
    async update(
      id: string,
      patch: { enabled?: boolean | undefined; acceptMode?: 'merge' | 'pr' | null | undefined },
    ): Promise<SkillRepoDto | null> {
      const set = {
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        ...(patch.acceptMode !== undefined && { accept_mode: patch.acceptMode }),
      };
      if (Object.keys(set).length > 0)
        await db
          .updateTable('skill_repo')
          .set(set)
          .where('id', '=', id)
          .where('workspace_id', '=', workspaceId)
          .execute();
      const row = await select().where('id', '=', id).executeTakeFirst();
      return row ? toDto(row) : null;
    },

    /**
     * Registers a project repository: the root of a git work tree below a mounted projects folder.
     * Its allow-list is fixed to `.claude/**`, `CLAUDE.md` and `AGENTS.md` (ADR-0010); source code is never in it.
     */
    async registerProject(path: string): Promise<SkillRepoDto> {
      if (!path.startsWith('/')) throw new InvalidInputError('The path must be absolute');
      const real = await realpath(path).catch(() => null);
      if (!real || !(await isGitRepoRoot(real)))
        throw new InvalidInputError(`"${path}" is not the root of a git repository`);
      const roots = await Promise.all(projectRoots.map((r) => realpath(r).catch(() => null)));
      if (!roots.some((r) => r !== null && real.startsWith(r + sep)))
        throw new InvalidInputError(
          `Project repositories must be below ${projectRoots.join(' or ')}; mount them there`,
        );
      const existing = await select().where('path', '=', real).executeTakeFirst();
      if (existing) {
        if (existing.kind === 'global')
          throw new ConflictError('That folder is the global skills repository');
        return toDto(existing);
      }
      await db
        .insertInto('skill_repo')
        .values({ id: newId(), workspace_id: workspaceId, kind: 'project', path: real })
        .execute();
      const row = await select().where('path', '=', real).executeTakeFirstOrThrow();
      return toDto(row);
    },

    /** Full rows of the enabled repositories, for target resolution. */
    async rows(): Promise<SkillRepoRow[]> {
      const all = await db
        .selectFrom('skill_repo')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .execute();
      return all.map(toRow);
    },

    async row(id: string): Promise<SkillRepoRow | null> {
      const found = await db
        .selectFrom('skill_repo')
        .selectAll()
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      return found ? toRow(found) : null;
    },

    async rememberDefaultBranch(id: string, branch: string): Promise<void> {
      await db
        .updateTable('skill_repo')
        .set({ default_branch: branch })
        .where('id', '=', id)
        .execute();
    },
  };
}

export type SkillRepos = ReturnType<typeof createSkillRepos>;
