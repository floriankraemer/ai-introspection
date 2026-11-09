import { describe, expect, it } from 'vitest';
import { DiffRejectedError, globToRegExp, inspectDiff, pathProblem } from './diff.js';
import { DEFAULT_ALLOW } from './policy.js';

const modify = (path: string, add = 'new line'): string =>
  `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n old\n+${add}\n`;

describe('pathProblem', () => {
  const global = DEFAULT_ALLOW.global;
  const project = DEFAULT_ALLOW.project;
  it('allows only skills, commands, agents and instruction files in a global repository', () => {
    expect(pathProblem('skills/e2e/SKILL.md', global)).toBeNull();
    expect(pathProblem('commands/ship.md', global)).toBeNull();
    expect(pathProblem('agents/reviewer.md', global)).toBeNull();
    expect(pathProblem('CLAUDE.md', global)).toBeNull();
    expect(pathProblem('notes.md', global)).toMatch(/outside the allowed/);
    expect(pathProblem('rubrics/a.md', global)).toMatch(/never allowed/);
    expect(pathProblem('skills/.git/config', global)).toMatch(/\.git/);
  });
  it.each(['rubrics/a.md', 'Rubrics/a.md', 'RUBRICS/a.md', 'rubrics /a.md', 'rubrics./a.md'])(
    'denies %s whatever the allow-list says, case-insensitively',
    (p) => {
      expect(pathProblem(p, ['**'])).toMatch(/never allowed/);
    },
  );
  it.each(['.git/config', '.GIT/config', 'skills/.Git/hooks/x', '.git /config', 'a/.git./b'])(
    'denies %s',
    (p) => {
      expect(pathProblem(p, ['**'])).not.toBeNull();
    },
  );
  it('allows only instruction files in a project repository', () => {
    expect(pathProblem('.claude/skills/x/SKILL.md', project)).toBeNull();
    expect(pathProblem('.claude/commands/x.md', project)).toBeNull();
    expect(pathProblem('AGENTS.md', project)).toBeNull();
    expect(pathProblem('.claude/settings.json', project)).toMatch(/outside the allowed/);
    expect(pathProblem('src/index.ts', project)).toMatch(/outside the allowed/);
    expect(pathProblem('docs/CLAUDE.md', project)).toMatch(/outside the allowed/);
  });
  it.each([
    'skills/x/run.sh',
    'skills/x/tool.py',
    'skills/x/tool.js',
    'hooks/pre.md',
    'skills/hooks/pre.md',
    'settings.json',
    'settings.local.json',
    '.claude/settings.json',
  ])('denies the executable surface %s unless allowExecutable is set', (p) => {
    const list = ['**'];
    expect(pathProblem(p, list)).toMatch(/execute|never|outside/);
    expect(pathProblem(p, list, true)).toBeNull();
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
  describe('headers that git reads differently than a regex', () => {
    const attack = (header: string, minus: string, plus: string): string =>
      `diff --git ${header}\n--- ${minus}\n+++ ${plus}\n@@ -1 +1,2 @@\n old\n+new\n`;
    it('refuses a header with several " b/" that hides rubrics/ behind the first path', () => {
      const d = attack(
        'a/x b/rubrics/efficiency.md b/z',
        'a/rubrics/efficiency.md',
        'b/rubrics/efficiency.md',
      );
      expect(() => inspectDiff(d, ['**'])).toThrow(/ambiguous|rubrics/);
    });
    it('refuses a header whose names disagree with the --- and +++ lines', () => {
      const d = attack('a/CLAUDE.md b/CLAUDE.md', 'a/CLAUDE.md', 'b/skills/other.md');
      expect(() => inspectDiff(d, ['**'])).toThrow(/disagree/);
    });
    it('refuses a header that does not split as a/P b/P without a rename', () => {
      expect(() =>
        inspectDiff(attack('a/CLAUDE.md b/CLAUDE.mdx', 'a/CLAUDE.md', 'b/CLAUDE.md'), ['**']),
      ).toThrow(/ambiguous/);
    });
    it('reads a path with spaces exactly', () => {
      const d = attack('a/my skill.md b/my skill.md', 'a/my skill.md', 'b/my skill.md');
      expect(inspectDiff(d, ['**']).files).toEqual(['my skill.md']);
    });
    it('refuses a second --- line and a mode-only header that cannot be split', () => {
      const twice = `diff --git a/a.md b/a.md\n--- a/a.md\n--- a/b.md\n+++ b/a.md\n@@ -1 +1 @@\n-a\n+b\n`;
      expect(() => inspectDiff(twice, ['**'])).toThrow(/twice/);
      const modeOnly = 'diff --git a/x b/rubrics/y b/z\nnew mode 100644\n';
      expect(() => inspectDiff(modeOnly, ['**'])).toThrow(/ambiguous/);
    });
    it('refuses a renamed file whose header and rename lines disagree', () => {
      const d =
        'diff --git a/a.md b/b.md\nsimilarity index 100%\nrename from a.md\nrename to rubrics/b.md\n';
      expect(() => inspectDiff(d, ['**'])).toThrow(/ambiguous/);
    });
  });
  describe('executable surfaces and invisible characters', () => {
    const newFile = (path: string, mode: string, body = 'echo hi'): string =>
      `diff --git a/${path} b/${path}\nnew file mode ${mode}\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${body}\n`;
    it('refuses mode 100755 unless allowed, then warns', () => {
      const d = newFile('skills/a.md', '100755');
      expect(() => inspectDiff(d, ['skills/**'])).toThrow(/executable/);
      expect(inspectDiff(d, ['skills/**'], true).warnings).toEqual([
        '"skills/a.md" changes a hook/settings file that Claude Code executes',
      ]);
    });
    it('refuses a script, and warns about it when allowed', () => {
      const d = newFile('skills/a/run.sh', '100644');
      expect(() => inspectDiff(d, ['skills/**'])).toThrow(/execute/);
      expect(inspectDiff(d, ['skills/**'], true).warnings).toHaveLength(1);
    });
    it('has no warning for a plain instruction file', () => {
      expect(inspectDiff(newFile('skills/a.md', '100644'), ['skills/**']).warnings).toEqual([]);
    });
    it.each([
      ['a control character', 'x\u0007y'],
      ['a zero-width space', 'x\u200By'],
      ['a bidi override', 'x\u202Ey'],
      ['a bidi isolate', 'x\u2066y'],
      ['a tag character', 'x\u{E0041}y'],
      ['a byte order mark', '\uFEFFx'],
    ])('refuses %s in an added line', (_n, body) => {
      expect(() => inspectDiff(modify('CLAUDE.md', body), ['**'])).toThrow(/invisible/);
    });
    it('allows a tab, CRLF line ends and ordinary Unicode', () => {
      expect(() => inspectDiff(modify('CLAUDE.md', 'a\tb\r'), ['**'])).not.toThrow();
      expect(() => inspectDiff(modify('CLAUDE.md', 'Grüße, 日本語, café ✓'), ['**'])).not.toThrow();
    });
  });
  it('refuses more than 300 changed lines and more than 5 files', () => {
    const big = `diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -0,0 +1,301 @@\n${'+x\n'.repeat(301)}`;
    expect(() => inspectDiff(big, ['**'])).toThrow(/301 lines/);
    const six = Array.from({ length: 6 }, (_, i) => modify(`f${String(i)}.md`)).join('');
    expect(() => inspectDiff(six, ['**'])).toThrow(/6 files/);
  });
});
