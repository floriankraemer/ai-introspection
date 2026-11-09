import type { SkillRepoRow } from './skill-repos.js';

/**
 * Default allow-lists (ADR-0010): only files an agent reads as instructions. Everything Claude Code
 * or a shell can execute (hooks, settings, scripts) stays out unless the repository sets `allowExecutable`.
 * `rubrics/**` and `.git/**` are denied by `pathProblem` whatever the list says.
 */
export const DEFAULT_ALLOW = {
  global: ['skills/**', 'commands/**', 'agents/**', 'CLAUDE.md', 'AGENTS.md'],
  project: [
    '.claude/skills/**',
    '.claude/commands/**',
    '.claude/agents/**',
    'CLAUDE.md',
    'AGENTS.md',
  ],
} as const;

/** What `allowExecutable` adds to the default list. */
export const EXECUTABLE_ALLOW = {
  global: ['hooks/**', 'settings*.json'],
  project: ['.claude/hooks/**', '.claude/settings*.json'],
} as const;

export const allowListOf = (
  repo: Pick<SkillRepoRow, 'kind' | 'allowList' | 'allowExecutable'>,
): readonly string[] =>
  repo.allowList ??
  (repo.allowExecutable
    ? [...DEFAULT_ALLOW[repo.kind], ...EXECUTABLE_ALLOW[repo.kind]]
    : DEFAULT_ALLOW[repo.kind]);

/** What a proposal to one repository may change. */
export interface EditPolicy {
  allowList: readonly string[];
  allowExecutable: boolean;
}

export const policyOf = (
  repo: Pick<SkillRepoRow, 'kind' | 'allowList' | 'allowExecutable'>,
): EditPolicy => ({ allowList: allowListOf(repo), allowExecutable: repo.allowExecutable });
