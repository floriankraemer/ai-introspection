import { realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { SkillRepoRow } from './skill-repos.js';

const real = (p: string): Promise<string> => realpath(p).catch(() => p);

/**
 * The repository a failing session's instructions live in (ADR-0010): the registered project
 * repository the session ran in, else the global skills repository.
 *
 * A session records the host path of its repository, which inside the container is mounted
 * elsewhere (`/repos/projects/<name>`). A project therefore matches when the session's folder
 * (or one of its parents) is the registered path, or when the repository root has the same folder name.
 *
 * ponytail: instruction files loaded in the session (ADR-0010 rule 1) are not consulted, so a
 * failure caused by a global skill inside a registered project still targets the project. Upgrade
 * path: read the session's `skill` and instruction-file events and map their real paths.
 */
export async function resolveTarget(
  session: { repoRoot: string | null; cwd: string | null },
  repos: readonly SkillRepoRow[],
): Promise<SkillRepoRow | null> {
  const enabled = repos.filter((r) => r.enabled);
  const projects = enabled.filter((r) => r.kind === 'project');
  const start = session.repoRoot ?? session.cwd;
  if (start) {
    const known = await Promise.all(
      projects.map(async (row) => ({ row, paths: new Set([row.path, await real(row.path)]) })),
    );
    for (let dir = start; ; dir = dirname(dir)) {
      const hit = known.find((k) => k.paths.has(dir));
      if (hit) return hit.row;
      if (dirname(dir) === dir) break;
    }
  }
  if (session.repoRoot) {
    const name = basename(session.repoRoot);
    const byName = projects.filter((p) => basename(p.path) === name);
    if (byName.length === 1) return byName[0] ?? null;
  }
  return enabled.find((r) => r.kind === 'global') ?? null;
}
