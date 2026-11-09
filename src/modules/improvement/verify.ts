import { git, gitRaw } from '../../platform/git/index.js';
import { type EditPolicy } from './policy.js';
import {
  DiffRejectedError,
  executableWarning,
  frontmatterProblem,
  isAgentFolderPath,
  inspectDiff,
  isExecutableSurface,
  MAX_CHANGED_LINES,
  MAX_FILES,
  pathProblem,
  type DiffReport,
} from './diff.js';

export interface VerifiedChange extends DiffReport {
  /** git's own diff of `base..head`, without rename detection: the text that is stored and shown. */
  diff: string;
}

const SYMLINK = '120000';
const SUBMODULE = '160000';
const EXECUTABLE = '100755';

/** `:old new oldsha newsha STATUS\0path\0` records of `git diff --raw -z --no-renames`. */
function parseRaw(out: string): { path: string; oldMode: string; newMode: string }[] {
  const tokens = out.split('\0');
  const rows: { path: string; oldMode: string; newMode: string }[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) /.exec(tokens[i] ?? '');
    const path = tokens[i + 1];
    if (!meta || !path) throw new DiffRejectedError('git reported a change that cannot be read');
    rows.push({ path, oldMode: meta[1] ?? '', newMode: meta[2] ?? '' });
  }
  return rows;
}

/**
 * Validates what git itself says changed between `base` and `head`: the authority after any diff is
 * applied, however it was written. The pre-apply text checks (inspectDiff) are only a first filter,
 * because a crafted header can make the text name one file while git changes another.
 * Checks every path, mode (symlink, submodule, executable), binary change, and the size limits,
 * then runs the text checks on git's own diff and requires both views to list the same files.
 */
export async function verifyChange(
  dir: string,
  base: string,
  head: string,
  policy: EditPolicy,
): Promise<VerifiedChange> {
  const raw = parseRaw(
    await gitRaw(dir, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, head]),
  );
  if (raw.length === 0) throw new DiffRejectedError('diff changes nothing');
  const warnings = new Set<string>();
  for (const r of raw) {
    const problem = pathProblem(r.path, policy.allowList, policy.allowExecutable);
    if (problem) throw new DiffRejectedError(problem);
    const modes = [r.oldMode, r.newMode];
    if (modes.includes(SYMLINK) || modes.includes(SUBMODULE))
      throw new DiffRejectedError('symlinks and submodules are not allowed');
    const exec = modes.includes(EXECUTABLE);
    if (exec && !policy.allowExecutable)
      throw new DiffRejectedError(`"${r.path}" is executable; allowExecutable is off`);
    if (exec || isExecutableSurface(r.path)) warnings.add(executableWarning(r.path));
  }
  for (const r of raw) {
    if (!isAgentFolderPath(r.path) || !/\.md$/i.test(r.path)) continue;
    // A deleted file has no frontmatter left to check; a new one has no earlier version.
    const shown = (rev: string): Promise<string | undefined> =>
      gitRaw(dir, ['show', `${rev}:${r.path}`]).catch(() => undefined);
    const after = await shown(head);
    if (after === undefined) continue;
    const problem = frontmatterProblem(after, await shown(base));
    if (!problem) continue;
    if (!policy.allowExecutable)
      throw new DiffRejectedError(
        `"${r.path}": ${problem}; only allowed when the repository sets allowExecutable`,
      );
    warnings.add(`"${r.path}": ${problem}`);
  }
  if (raw.length > MAX_FILES)
    throw new DiffRejectedError(
      `${String(raw.length)} files changed, at most ${String(MAX_FILES)} allowed`,
    );
  let lines = 0;
  for (const rec of (await git(dir, ['diff', '--numstat', '-z', '--no-renames', base, head])).split(
    '\0',
  )) {
    if (rec === '') continue;
    const [add, del] = rec.split('\t');
    if (add === '-' || del === '-') throw new DiffRejectedError('binary changes are not allowed');
    lines += Number(add) + Number(del);
  }
  if (lines > MAX_CHANGED_LINES)
    throw new DiffRejectedError(
      `${String(lines)} lines changed, at most ${String(MAX_CHANGED_LINES)} allowed`,
    );
  const diff = await gitRaw(dir, [
    'diff',
    '--binary',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    base,
    head,
  ]);
  const report = inspectDiff(diff, policy.allowList, policy.allowExecutable);
  const gitFiles = raw.map((r) => r.path).sort();
  if (gitFiles.join('\0') !== report.files.join('\0'))
    throw new DiffRejectedError('the diff text and git disagree about which files change');
  return { ...report, files: gitFiles, warnings: [...warnings].sort(), diff };
}
