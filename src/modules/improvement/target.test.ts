import { describe, expect, it } from 'vitest';
import type { SkillRepoRow } from './skill-repos.js';
import { resolveTarget } from './target.js';

const repo = (id: string, kind: 'global' | 'project', path: string): SkillRepoRow => ({
  id,
  kind,
  path,
  defaultBranch: null,
  allowList: null,
  acceptMode: null,
  enabled: true,
  allowExecutable: false,
  scanWarning: null,
});

describe('resolveTarget', () => {
  const global = repo('g', 'global', '/repos/skills');
  const web = repo('w', 'project', '/repos/projects/a/webapp');
  const web2 = repo('w2', 'project', '/repos/projects/b/webapp');
  const api = repo('a', 'project', '/repos/projects/api');

  it('matches a registered path, or a parent of the session folder', async () => {
    expect(
      await resolveTarget({ repoRoot: null, cwd: '/repos/projects/api/src' }, [global, api]),
    ).toEqual({ repo: api });
  });
  it('matches by folder name when exactly one project has it', async () => {
    expect(
      await resolveTarget({ repoRoot: '/home/dev/code/api', cwd: null }, [global, api, web]),
    ).toEqual({
      repo: api,
    });
  });
  it('skips the session when several projects share the folder name, instead of guessing', async () => {
    const out = await resolveTarget({ repoRoot: '/home/dev/code/webapp', cwd: null }, [
      global,
      web,
      web2,
    ]);
    expect('skip' in out && out.skip).toMatch(
      /2 registered project repositories are named "webapp"/,
    );
  });
  it('falls back to the global repository, or skips when there is none', async () => {
    expect(await resolveTarget({ repoRoot: '/x/other', cwd: null }, [global, api])).toEqual({
      repo: global,
    });
    expect(await resolveTarget({ repoRoot: '/x/other', cwd: null }, [api])).toEqual({
      skip: 'no global skills repository is set',
    });
  });
});
