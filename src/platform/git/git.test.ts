import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, initRepo, minimalEnv } from './index.js';

describe('minimalEnv', () => {
  const source = {
    PATH: '/bin',
    HOME: '/home/x',
    LANG: 'C',
    ANTHROPIC_API_KEY: 'sk-secret',
    GH_TOKEN: 'ghp_secret',
    GIT_AUTHOR_NAME: 'Ann',
    GIT_COMMITTER_EMAIL: 'a@b',
    GIT_SSH_COMMAND: 'evil',
    GIT_EXTERNAL_DIFF: 'evil',
  };
  it('keeps PATH, HOME, LANG and the git identity, and nothing else', () => {
    expect(minimalEnv(false, source)).toEqual({
      PATH: '/bin',
      HOME: '/home/x',
      LANG: 'C',
      GIT_AUTHOR_NAME: 'Ann',
      GIT_COMMITTER_EMAIL: 'a@b',
      GIT_TERMINAL_PROMPT: '0',
    });
  });
  it('adds the forge token only for network calls', () => {
    expect(minimalEnv(true, source).GH_TOKEN).toBe('ghp_secret');
    expect(minimalEnv(true, source).ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('git runner', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'introspect-git-'));
    await initRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not hand the server’s secrets to git or to what git runs', async () => {
    process.env.INTROSPECT_TEST_SECRET = 'leak-me';
    try {
      const env = await git(dir, ['-c', 'alias.e=!env', 'e']);
      expect(env).not.toContain('leak-me');
      expect(env).toContain('GIT_TERMINAL_PROMPT=0');
    } finally {
      delete process.env.INTROSPECT_TEST_SECRET;
    }
  });

  it('turns off hooks, signing and fsmonitor for every call', async () => {
    await git(dir, ['config', 'core.fsmonitor', 'touch /nonexistent/never']);
    expect(await git(dir, ['config', 'core.hooksPath'])).toBe('/dev/null');
    expect(await git(dir, ['config', 'commit.gpgsign'])).toBe('false');
    expect(await git(dir, ['config', 'core.fsmonitor'])).toBe('false');
  });
});
