import type { Db } from '../db/schema.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../identity/index.js';
import type { JobQueue } from '../jobs/queue.js';
import { createFakeJudge, createGrading, type Judge } from '../../modules/grading/index.js';
import type { SkillRepos } from '../../modules/improvement/index.js';
import type { IngestService } from '../../modules/ingest/index.js';
import { createRubrics } from '../../modules/rubrics/index.js';
import type { SettingsService } from '../../modules/settings/index.js';

/** Rubric store, grading service and a judge provider around one fixed (fake by default) judge. */
export function wireGrading(deps: {
  db: Db;
  ingest: IngestService;
  settings: SettingsService;
  queue: JobQueue;
  skillRepos: SkillRepos;
  judge?: Judge;
}) {
  const judge = deps.judge ?? createFakeJudge();
  const rubrics = createRubrics({
    db: deps.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    repoPath: async () => (await deps.skillRepos.getGlobal())?.path ?? null,
    cacheMs: 0,
  });
  const judges = {
    current: () => Promise.resolve(judge),
    test: () => judge.test(),
  };
  const grading = createGrading({
    db: deps.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    settings: deps.settings,
    queue: deps.queue,
    ingest: deps.ingest,
    rubrics,
    judges,
  });
  return { judge, rubrics, judges, grading };
}
