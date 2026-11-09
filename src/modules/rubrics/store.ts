import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../../platform/db/ids.js';
import type { Db } from '../../platform/db/schema.js';
import { fromJson, toJson } from '../../platform/db/json.js';
import { ConflictError, InvalidInputError } from '../../platform/errors.js';
import { commitPaths, git } from '../../platform/git/index.js';
import { parseRubric, serializeRubric, type RubricSpec } from './rubric-file.js';

const RUBRICS_DIR = 'rubrics';

export interface Rubric extends RubricSpec {
  id: string;
  /** Git blob SHA of the file content: content-addressed, stable across rebases (ADR-0010). */
  version: string;
  /** "v3": the number of commits of the file, plus one for uncommitted edits. */
  ordinal: number;
  commitSha: string | null;
}

export interface RubricVersion {
  /** Commit SHA. */
  sha: string;
  at: string;
  message: string;
  ordinal: number;
}

export interface RubricProblem {
  name: string;
  error: string;
}

export interface RubricEdit {
  body?: string | undefined;
  passThreshold?: number | undefined;
  target?: number | null | undefined;
  /** Commit message; a default names the rubric. */
  message?: string | undefined;
}

export interface RubricStoreDeps {
  db: Db;
  workspaceId: string;
  /** Path of the global skills repository, or null when none is set. */
  repoPath: () => Promise<string | null>;
  now?: () => Date;
  /** How long a read of the files stays valid; the list and session endpoints ask often. Default 2 s. */
  cacheMs?: number;
}

export function createRubrics(deps: RubricStoreDeps) {
  const { db, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());

  let cached:
    | { at: number; key: string; value: Promise<{ rubrics: Rubric[]; problems: RubricProblem[] }> }
    | undefined;
  const cacheMs = deps.cacheMs ?? 2000;

  /**
   * Cache key: the repository path plus the mtime of `rubrics/`, so setting a skills repo or adding
   * or removing a rubric file (wizard init, starter rubrics) is seen at once. In-place edits made
   * outside Introspect still wait for `cacheMs`.
   */
  async function cacheKey(): Promise<string> {
    const repo = await deps.repoPath();
    if (!repo) return '';
    const mtime = await stat(join(repo, RUBRICS_DIR)).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    return `${repo}|${String(mtime)}`;
  }

  /** Reads `<repo>/rubrics/*.md`, records every new version in the table, returns the current ones. */
  async function sync(): Promise<{ rubrics: Rubric[]; problems: RubricProblem[] }> {
    const key = await cacheKey();
    if (cached && cached.key === key && Date.now() - cached.at < cacheMs) return cached.value;
    const value = read();
    cached = { at: Date.now(), key, value };
    value.catch(() => {
      cached = undefined;
    });
    return value;
  }

  async function read(): Promise<{ rubrics: Rubric[]; problems: RubricProblem[] }> {
    const repo = await deps.repoPath();
    if (!repo) return { rubrics: [], problems: [] };
    const files = (await readdir(join(repo, RUBRICS_DIR)).catch(() => []))
      .filter((f) => f.endsWith('.md'))
      .sort();
    const rubrics: Rubric[] = [];
    const problems: RubricProblem[] = [];
    for (const file of files) {
      const stem = file.slice(0, -3);
      const rel = `${RUBRICS_DIR}/${file}`;
      try {
        const spec = parseRubric(stem, await readFile(join(repo, rel), 'utf8'));
        const version = await git(repo, ['hash-object', '--', rel]);
        const committed = await git(repo, [
          'rev-parse',
          '--verify',
          '--quiet',
          `HEAD:${rel}`,
        ]).catch(() => null);
        const commits = Number(
          await git(repo, ['rev-list', '--count', 'HEAD', '--', rel]).catch(() => '0'),
        );
        const commitSha =
          commits > 0
            ? await git(repo, ['log', '-1', '--format=%H', '--', rel]).catch(() => null)
            : null;
        const ordinal = commits + (committed === version ? 0 : 1);
        rubrics.push(await upsert(spec, version, ordinal, commitSha));
      } catch (e) {
        problems.push({ name: stem, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { rubrics, problems };
  }

  async function upsert(
    spec: RubricSpec,
    version: string,
    ordinal: number,
    commitSha: string | null,
  ): Promise<Rubric> {
    const values = {
      ordinal,
      commit_sha: commitSha,
      scale: toJson(spec.scale),
      pass_threshold: spec.passThreshold,
      target_pass_rate: spec.target,
      applies_to: toJson(spec.appliesTo),
      body_md: spec.body,
    };
    const existing = await db
      .selectFrom('rubric')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('name', '=', spec.name)
      .where('version', '=', version)
      .executeTakeFirst();
    if (existing) {
      await db.updateTable('rubric').set(values).where('id', '=', existing.id).execute();
      return { ...spec, id: existing.id, version, ordinal, commitSha };
    }
    const id = newId();
    await db
      .insertInto('rubric')
      .values({
        id,
        workspace_id: workspaceId,
        name: spec.name,
        version,
        created_at: now().toISOString(),
        ...values,
      })
      .execute();
    return { ...spec, id, version, ordinal, commitSha };
  }

  async function get(name: string): Promise<Rubric | null> {
    return (await sync()).rubrics.find((r) => r.name === name) ?? null;
  }

  return {
    sync,
    list: async (): Promise<{ rubrics: Rubric[]; problems: RubricProblem[] }> => sync(),
    get,

    /** Commits of the rubric file, newest first; "v3" is the third commit counted from the oldest. */
    async history(name: string): Promise<RubricVersion[]> {
      const repo = await deps.repoPath();
      if (!repo) return [];
      const rel = `${RUBRICS_DIR}/${name}.md`;
      const out = await git(repo, [
        'log',
        '--max-count=50',
        '--format=%H%x1f%aI%x1f%s',
        '--',
        rel,
      ]).catch(() => '');
      const total = Number(
        await git(repo, ['rev-list', '--count', 'HEAD', '--', rel]).catch(() => '0'),
      );
      return out
        .split('\n')
        .filter((l) => l !== '')
        .map((line, i) => {
          const [sha = '', at = '', message = ''] = line.split('\x1f');
          return { sha, at, message, ordinal: total - i };
        });
    },

    /** A stored version by id, for dry runs and for showing what an old grade was judged against. */
    async byId(id: string): Promise<Rubric | null> {
      const r = await db
        .selectFrom('rubric')
        .selectAll()
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        version: r.version,
        ordinal: r.ordinal,
        commitSha: r.commit_sha,
        scale: fromJson(r.scale) as number[],
        passThreshold: r.pass_threshold,
        appliesTo: fromJson(r.applies_to) as string,
        target: r.target_pass_rate,
        body: r.body_md,
      };
    },

    /**
     * Human edit from the Rubrics screen: validates, writes the file, commits only that path.
     * The improver never reaches this (ADR-0010: `rubrics/**` is denied to it).
     */
    async update(name: string, edit: RubricEdit): Promise<Rubric> {
      const repo = await deps.repoPath();
      if (!repo) throw new ConflictError('Set the global skills repository first');
      const current = await get(name);
      // `body` is either the whole file (frontmatter included) or just the text below it.
      const wholeFile = edit.body?.trimStart().startsWith('---') === true;
      let next: RubricSpec;
      if (wholeFile) {
        next = parseRubric(name, edit.body ?? '');
      } else {
        if (!current && edit.body === undefined)
          throw new InvalidInputError(
            `No rubric named "${name}"; send the whole file to create it`,
          );
        next = {
          name,
          scale: current?.scale ?? [0, 1],
          appliesTo: current?.appliesTo ?? 'all',
          body: edit.body ?? current?.body ?? '',
          passThreshold: current?.passThreshold ?? 1,
          target: current?.target ?? null,
        };
      }
      if (edit.passThreshold !== undefined) next.passThreshold = edit.passThreshold;
      if (edit.target !== undefined) next.target = edit.target;
      const text = serializeRubric(next);
      parseRubric(name, text); // the same validation a file edited by hand goes through
      const rel = `${RUBRICS_DIR}/${name}.md`;
      const unchanged = (await readFile(join(repo, rel), 'utf8').catch(() => null)) === text;
      if (!unchanged) {
        await mkdir(join(repo, RUBRICS_DIR), { recursive: true });
        await writeFile(join(repo, rel), text);
        await commitPaths(
          repo,
          [rel],
          edit.message?.trim()
            ? edit.message.trim()
            : `feat(rubrics): update ${name} from the Introspect UI`,
        );
        cached = undefined;
      }
      const saved = await get(name);
      if (!saved) throw new Error(`Rubric ${name} vanished after saving`);
      return saved;
    },
  };
}

export type RubricStore = ReturnType<typeof createRubrics>;
