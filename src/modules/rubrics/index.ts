import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitPaths } from '../../platform/git/index.js';

// Resolved next to this file; the build copies the folder to dist (package.json `build`).
const STARTER_DIR = fileURLToPath(new URL('./starter/', import.meta.url));
const RUBRICS_DIR = 'rubrics';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );
const markdownFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md'));

/** True when `<repo>/rubrics/` holds at least one rubric file. */
export async function hasRubrics(repoPath: string): Promise<boolean> {
  return (await markdownFiles(join(repoPath, RUBRICS_DIR))).length > 0;
}

/** Copies the starter rubrics the repo does not have yet and commits them. Existing files are never touched. */
export async function copyStarterRubrics(repoPath: string): Promise<{ copied: string[] }> {
  const target = join(repoPath, RUBRICS_DIR);
  await mkdir(target, { recursive: true });
  const copied: string[] = [];
  for (const file of await markdownFiles(STARTER_DIR)) {
    if (await exists(join(target, file))) continue;
    await copyFile(join(STARTER_DIR, file), join(target, file));
    copied.push(file);
  }
  if (copied.length > 0) {
    await commitPaths(
      repoPath,
      copied.map((f) => join(RUBRICS_DIR, f)),
      'chore(rubrics): add Introspect starter rubrics',
    );
  }
  return { copied: copied.map((f) => f.replace(/\.md$/, '')) };
}
