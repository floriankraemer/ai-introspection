import { describe, expect, it } from 'vitest';
import { DiffRejectedError, globToRegExp, inspectDiff, pathProblem } from './diff.js';
import { DEFAULT_ALLOW } from './policy.js';

const modify = (path: string, add = 'new line'): string =>
  `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n old\n+${add}\n`;

describe('pathProblem', () => {
  const global = DEFAULT_ALLOW.global;
  const project = DEFAULT_ALLOW.project;
  it('allows anything but rubrics/ and .git in a global repository', () => {
    expect(pathProblem('skills/e2e/SKILL.md', global)).toBeNull();
    expect(pathProblem('CLAUDE.md', global)).toBeNull();
    expect(pathProblem('rubrics/a.md', global)).toMatch(/never allowed/);
    expect(pathProblem('Rubrics/a.md', global)).toMatch(/never allowed/);
    expect(pathProblem('skills/.git/config', global)).toMatch(/\.git/);
  });
  it('allows only instruction files in a project repository', () => {
    expect(pathProblem('.claude/skills/x/SKILL.md', project)).toBeNull();
    expect(pathProblem('AGENTS.md', project)).toBeNull();
    expect(pathProblem('src/index.ts', project)).toMatch(/outside the allowed/);
    expect(pathProblem('docs/CLAUDE.md', project)).toMatch(/outside the allowed/);
  });
  it.each(['../x', 'a/../../x', '/abs', 'a//b', './a', 'a\\b', ''])('refuses %j', (p) => {
    expect(pathProblem(p, ['**'])).toMatch(/plain relative path/);
  });
  it('matches globs', () => {
    expect(globToRegExp('.claude/**').test('.claude/a/b.md')).toBe(true);
    expect(globToRegExp('*.md').test('a/b.md')).toBe(false);
    expect(globToRegExp('skills/**').test('skills')).toBe(false);
  });
});

describe('inspectDiff', () => {
  it('reports files, counts and the added text', () => {
    const r = inspectDiff(modify('CLAUDE.md', 'hello'), ['**']);
    expect(r).toMatchObject({
      files: ['CLAUDE.md'],
      additions: 1,
      deletions: 0,
      addedText: 'hello\n',
    });
  });
  it('does not mistake a deleted line starting with "--" for a header', () => {
    const d = `diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1 @@\n--- not a header\n keep\n`;
    expect(inspectDiff(d, ['**'])).toMatchObject({ deletions: 1, additions: 0 });
  });
  it.each([
    ['binary', 'diff --git a/x.md b/x.md\nGIT binary patch\nliteral 0\n'],
    [
      'symlink',
      'diff --git a/x.md b/x.md\nnew file mode 120000\n--- /dev/null\n+++ b/x.md\n@@ -0,0 +1 @@\n+target\n',
    ],
    ['quoted', 'diff --git "a/x y.md" "b/x y.md"\n'],
    ['empty', '\n'],
    [
      'rename into rubrics',
      'diff --git a/a.md b/rubrics/a.md\nsimilarity index 100%\nrename from a.md\nrename to rubrics/a.md\n',
    ],
  ])('refuses %s', (_n, diff) => {
    expect(() => inspectDiff(diff, ['**'])).toThrow(DiffRejectedError);
  });
  it('refuses more than 300 changed lines and more than 5 files', () => {
    const big = `diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -0,0 +1,301 @@\n${'+x\n'.repeat(301)}`;
    expect(() => inspectDiff(big, ['**'])).toThrow(/301 lines/);
    const six = Array.from({ length: 6 }, (_, i) => modify(`f${String(i)}.md`)).join('');
    expect(() => inspectDiff(six, ['**'])).toThrow(/6 files/);
  });
});
