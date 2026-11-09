import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffRejectedError } from './diff.js';
import { DEFAULT_ALLOW } from './policy.js';
import { verifyChange } from './verify.js';

const POLICY = { allowList: DEFAULT_ALLOW.global, allowExecutable: false };

/** git's own account of base..head is what counts, whatever text produced the commit. */
describe('verifyChange', () => {
  let repo: string;
  let base: string;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
  const commit = (files: Record<string, string>): string => {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      writeFileSync(join(repo, p), c);
    }
    git('add', '-A');
    git('commit', '-qm', 'change');
    return git('rev-parse', 'HEAD');
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'introspect-verify-'));
    git('init', '-q', '--initial-branch=main');
    mkdirSync(join(repo, 'rubrics'));
    writeFileSync(join(repo, 'rubrics', 'a.md'), 'a\n');
    writeFileSync(join(repo, 'CLAUDE.md'), '# c\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    base = git('rev-parse', 'HEAD');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('accepts a plain instruction change and reports git’s numbers', async () => {
    const head = commit({ 'CLAUDE.md': '# c\nmore\n' });
    const v = await verifyChange(repo, base, head, POLICY);
    expect(v).toMatchObject({ files: ['CLAUDE.md'], additions: 1, deletions: 0, warnings: [] });
    expect(v.diff).toContain('+more');
  });

  it.each([
    ['rubrics/', { 'rubrics/a.md': 'changed\n' }, /never allowed/],
    ['a path outside the allow-list', { 'notes.md': 'x\n' }, /outside the allowed/],
    ['a script', { 'skills/run.sh': 'echo\n' }, /execute/],
    ['an invisible character', { 'CLAUDE.md': '# c\n‮\n' }, /invisible/],
    ['a binary file', { 'skills/b.md': 'a\0b\n' }, /binary/],
  ])('refuses %s', async (_n, files, reason) => {
    const head = commit(files);
    await expect(verifyChange(repo, base, head, POLICY)).rejects.toThrow(reason);
  });

  it('refuses a new symlink, whatever it points to', async () => {
    mkdirSync(join(repo, 'skills'));
    symlinkSync('../rubrics', join(repo, 'skills', 'link'));
    git('add', '-A');
    git('commit', '-qm', 'link');
    await expect(verifyChange(repo, base, git('rev-parse', 'HEAD'), POLICY)).rejects.toThrow(
      /symlink/,
    );
  });

  it('refuses a change to a symlink that is already in the repository', async () => {
    mkdirSync(join(repo, 'skills'));
    symlinkSync('../rubrics/a.md', join(repo, 'skills', 'link.md'));
    git('add', '-A');
    git('commit', '-qm', 'link');
    const mid = git('rev-parse', 'HEAD');
    execFileSync('rm', [join(repo, 'skills', 'link.md')]);
    symlinkSync('../CLAUDE.md', join(repo, 'skills', 'link.md'));
    git('add', '-A');
    git('commit', '-qm', 'retarget');
    await expect(verifyChange(repo, mid, git('rev-parse', 'HEAD'), POLICY)).rejects.toThrow(
      /symlink/,
    );
  });

  it('refuses the executable bit unless allowed, then warns', async () => {
    chmodSync(join(repo, 'CLAUDE.md'), 0o755);
    git('add', '-A');
    git('commit', '-qm', 'chmod');
    const head = git('rev-parse', 'HEAD');
    await expect(verifyChange(repo, base, head, POLICY)).rejects.toThrow(/executable/);
    const v = await verifyChange(repo, base, head, { ...POLICY, allowExecutable: true });
    expect(v.warnings).toEqual([
      '"CLAUDE.md" changes a hook/settings file that Claude Code executes',
    ]);
  });

  it('allows hooks and settings only with allowExecutable, and warns for each', async () => {
    const head = commit({ 'hooks/pre.sh': 'x\n', 'settings.json': '{}\n' });
    await expect(verifyChange(repo, base, head, POLICY)).rejects.toBeInstanceOf(DiffRejectedError);
    const policy = {
      allowList: [...DEFAULT_ALLOW.global, 'hooks/**', 'settings*.json'],
      allowExecutable: true,
    };
    expect((await verifyChange(repo, base, head, policy)).warnings).toHaveLength(2);
  });

  it('refuses a commit that changes nothing and one with more than 5 files', async () => {
    const same = git('rev-parse', 'HEAD');
    await expect(verifyChange(repo, base, same, POLICY)).rejects.toThrow(/changes nothing/);
    const many = commit(
      Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`skills/${String(i)}.md`, 'x\n'])),
    );
    await expect(verifyChange(repo, base, many, POLICY)).rejects.toThrow(/6 files/);
  });

  it('sees a rename as a delete and an add, so a move into rubrics/ is refused', async () => {
    mkdirSync(join(repo, 'skills'));
    writeFileSync(join(repo, 'skills', 'm.md'), 'moved\n');
    git('add', '-A');
    git('commit', '-qm', 'm');
    const mid = git('rev-parse', 'HEAD');
    git('mv', 'skills/m.md', 'rubrics/m.md');
    git('commit', '-qm', 'mv');
    await expect(verifyChange(repo, mid, git('rev-parse', 'HEAD'), POLICY)).rejects.toThrow(
      /never allowed/,
    );
  });
});
