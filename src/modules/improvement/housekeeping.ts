import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteBranch, git, listBranches } from '../../platform/git/index.js';
import type { KeyedMutex } from '../../platform/keyed-mutex.js';
import type { ImprovementDeps } from './context.js';

/** Branch prefixes Introspect creates: proposals, and the temporary branch of an edit. */
const OWN_PREFIXES = ['introspect/', 'introspect-tmp/'];

/**
 * Cleans up what a crash or a kill leaves behind. Run at startup, before jobs start, so no run is
 * using a worktree: every folder under `<dataDir>/worktrees`, stale worktree records in each
 * registered repository, and `introspect/*` branches that no open or conflicting proposal owns.
 */
export async function sweepOrphans(
  deps: ImprovementDeps,
  locks: KeyedMutex,
): Promise<{ folders: number; branches: number }> {
  const root = join(deps.dataDir, 'worktrees');
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const e of entries) await rm(join(root, e), { recursive: true, force: true });

  const owned = new Set(
    (
      await deps.db
        .selectFrom('proposal')
        .select('branch')
        .where('workspace_id', '=', deps.workspaceId)
        .where('status', 'in', ['open', 'conflict'])
        .where('branch', 'is not', null)
        .execute()
    ).flatMap((r) => (r.branch === null ? [] : [r.branch])),
  );
  let branches = 0;
  for (const repo of await deps.skillRepos.rows()) {
    await locks.run(repo.id, async () => {
      await git(repo.path, ['worktree', 'prune']).catch(() => undefined);
      for (const prefix of OWN_PREFIXES) {
        for (const b of await listBranches(repo.path, prefix).catch(() => [] as string[])) {
          if (owned.has(b)) continue;
          await deleteBranch(repo.path, b);
          branches += 1;
        }
      }
    });
  }
  return { folders: entries.length, branches };
}
