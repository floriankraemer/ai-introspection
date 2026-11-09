import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initRepo } from '../../platform/git/index.js';
import { LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { sqliteTestDb, type TestDb } from '../../platform/testkit/db.js';
import { createRubrics } from './store.js';

const STARTER = fileURLToPath(new URL('./starter/', import.meta.url));

describe('rubric cache', () => {
  let tdb: TestDb;
  let dir: string;

  beforeEach(async () => {
    tdb = await sqliteTestDb();
    dir = await mkdtemp(join(tmpdir(), 'introspect-rubrics-'));
  });
  afterEach(async () => {
    await tdb.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it('sees a skills repo set and rubrics added after the first read, despite a long cache', async () => {
    let repoPath: string | null = null;
    const rubrics = createRubrics({
      db: tdb.handle.db,
      workspaceId: LOCAL_WORKSPACE_ID,
      repoPath: () => Promise.resolve(repoPath),
      cacheMs: 60 * 60 * 1000,
    });
    expect((await rubrics.list()).rubrics).toEqual([]);

    // The wizard creates the repository, then copies the starter rubrics into it.
    await initRepo(dir);
    repoPath = dir;
    expect((await rubrics.list()).rubrics).toEqual([]);

    await mkdir(join(dir, 'rubrics'));
    await copyFile(join(STARTER, 'efficiency.md'), join(dir, 'rubrics', 'efficiency.md'));
    expect((await rubrics.list()).rubrics.map((r) => r.name)).toEqual(['efficiency']);
  });
});
