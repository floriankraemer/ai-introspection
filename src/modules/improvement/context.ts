import type { Db } from '../../platform/db/schema.js';
import type { JobQueue } from '../../platform/jobs/queue.js';
import type { Grading } from '../grading/index.js';
import type { IngestService } from '../ingest/index.js';
import type { SettingsService } from '../settings/index.js';
import type { ImproverProvider } from './improvers.js';
import type { SkillRepos } from './skill-repos.js';

/** Runs the GitHub CLI; rejects with an error whose `code` is `ENOENT` when `gh` is not installed. */
export type GhRunner = (args: string[], opts: { cwd: string }) => Promise<string>;

export interface ImprovementDeps {
  db: Db;
  workspaceId: string;
  userId: string;
  /** Worktrees live in `<dataDir>/worktrees` (ADR-0010). */
  dataDir: string;
  settings: Pick<SettingsService, 'get'>;
  queue: Pick<JobQueue, 'enqueue'>;
  skillRepos: SkillRepos;
  ingest: Pick<IngestService, 'sessions'>;
  grading: Pick<Grading, 'failedGradesSince' | 'budget'>;
  improvers: Pick<ImproverProvider, 'current'>;
  /** True when `text` holds anything the redaction rules would replace. */
  hasSecret: (text: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  gh?: GhRunner;
  now?: () => Date;
}
