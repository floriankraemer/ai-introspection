import type { Db } from '../db/schema.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../identity/index.js';
import type { JobQueue } from '../jobs/queue.js';
import { createFakeJudge, createGrading, type Judge } from '../../modules/grading/index.js';
import {
  createFakeImprover,
  createImprovement,
  type GhRunner,
  type Improver,
  type SkillRepos,
} from '../../modules/improvement/index.js';
import type { IngestService } from '../../modules/ingest/index.js';
import { createRubrics } from '../../modules/rubrics/index.js';
import { createTrends } from '../../modules/trends/index.js';
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

/** The improvement service around a fake improver and no secret scanner hits, for API tests. */
export function wireImprovement(deps: {
  db: Db;
  ingest: IngestService;
  settings: SettingsService;
  queue: JobQueue;
  skillRepos: SkillRepos;
  grading: ReturnType<typeof wireGrading>['grading'];
  dataDir: string;
  improver?: Improver;
  hasSecret?: (text: string) => Promise<boolean>;
  gh?: GhRunner;
  env?: NodeJS.ProcessEnv;
}) {
  const improver = deps.improver ?? createFakeImprover();
  return createImprovement({
    db: deps.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    dataDir: deps.dataDir,
    settings: deps.settings,
    queue: deps.queue,
    skillRepos: deps.skillRepos,
    ingest: deps.ingest,
    grading: deps.grading,
    improvers: { current: () => Promise.resolve(improver) },
    hasSecret: deps.hasSecret ?? (() => Promise.resolve(false)),
    ...(deps.gh && { gh: deps.gh }),
    ...(deps.env && { env: deps.env }),
  });
}

/** The trends service over the same fake-judge wiring, for API tests. */
export function wireTrends(deps: {
  db: Db;
  ingest: IngestService;
  settings: SettingsService;
  skillRepos: SkillRepos;
  grading: ReturnType<typeof wireGrading>['grading'];
  rubrics: ReturnType<typeof wireGrading>['rubrics'];
  judges: ReturnType<typeof wireGrading>['judges'];
  now?: () => Date;
}) {
  return createTrends({
    db: deps.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    settings: deps.settings,
    ingest: deps.ingest,
    grading: deps.grading,
    rubrics: deps.rubrics,
    judges: deps.judges,
    skillRepos: deps.skillRepos,
    ...(deps.now && { now: deps.now }),
  });
}
