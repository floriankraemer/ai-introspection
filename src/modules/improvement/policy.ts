import type { SkillRepoRow } from './skill-repos.js';

/** Default allow-lists (ADR-0010; the global one is widened to everything but `rubrics/**`, which `pathProblem` always denies). */
export const DEFAULT_ALLOW = {
  global: ['**'],
  project: ['.claude/**', 'CLAUDE.md', 'AGENTS.md'],
} as const;

export const allowListOf = (repo: Pick<SkillRepoRow, 'kind' | 'allowList'>): readonly string[] =>
  repo.allowList ?? DEFAULT_ALLOW[repo.kind];
