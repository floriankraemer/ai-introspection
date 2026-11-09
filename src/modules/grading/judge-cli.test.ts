/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCliJudge, isolationProblem, type CliRunner } from './judge-cli.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'introspect-cli-'));
const request = {
  rubric: { name: 'efficiency', version: 'abc', scale: [0, 1], body: 'Did it work?' },
  trace: '[e0] +0s user hello',
};

function setup(runner: CliRunner, sources: string[] = []) {
  const root = tmp();
  const creds = join(root, 'host-credentials.json');
  writeFileSync(creds, '{"claudeAiOauth":{"accessToken":"secret"}}');
  const home = join(root, 'claude-home');
  const judge = createCliJudge({
    home,
    credentialsPath: creds,
    sourcePaths: () => Promise.resolve(sources),
    run: runner,
  });
  return { judge, home, creds, root };
}

const answer = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    is_error: false,
    structured_output: { score: 1, reason: 'Direct path.', evidenceEventIds: ['e0'] },
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 800,
      cache_read_input_tokens: 0,
      output_tokens: 40,
    },
    modelUsage: { 'claude-sonnet-5-5': {} },
    ...over,
  });

describe('claude CLI judge', () => {
  it('runs in a private home with a copy of the login, no API key, no tools and the verdict schema', async () => {
    const calls: {
      args: string[];
      env: NodeJS.ProcessEnv;
      cwd: string;
      input?: string | undefined;
    }[] = [];
    const runner: CliRunner = (_cmd, args, opts) => {
      calls.push({ args, env: opts.env, cwd: opts.cwd, input: opts.input });
      return Promise.resolve({
        stdout: args[0] === '--version' ? '2.1.319 (Claude Code)' : answer(),
        stderr: '',
        code: 0,
      });
    };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
    const { judge, home, creds } = setup(runner);
    const result = await judge.grade(request);
    delete process.env.ANTHROPIC_API_KEY;

    expect(result).toMatchObject({
      kind: 'verdict',
      score: 1,
      evidence: ['e0'],
      model: 'claude-sonnet-5-5',
      usage: { input: 5, cacheWrite: 800, cacheRead: 0, output: 40 },
    });
    const run = calls.find((c) => c.args[0] === '-p');
    expect(run?.env.HOME).toBe(home);
    expect(run?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(run?.cwd.startsWith(home)).toBe(true);
    expect(run?.args).toEqual(
      expect.arrayContaining(['--tools', '', '--no-session-persistence', '--json-schema']),
    );
    expect(run?.input).toContain('<trace>');
    expect(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).toBe(
      readFileSync(creds, 'utf8'),
    );
    expect(statSync(join(home, '.claude', '.credentials.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses to run when its private home would be read as an agent-log source', async () => {
    const runner: CliRunner = () => Promise.resolve({ stdout: '2.1.0', stderr: '', code: 0 });
    const root = tmp();
    const inside = join(root, 'claude-home');
    mkdirSync(inside, { recursive: true });
    const { judge } = setup(runner, [root]);
    await expect(judge.grade(request))
      .resolves.toBeDefined()
      .catch(() => undefined);
    const overlapping = createCliJudge({
      home: inside,
      credentialsPath: join(root, 'c.json'),
      sourcePaths: () => Promise.resolve([root]),
      run: runner,
    });
    await expect(overlapping.grade(request)).rejects.toThrow(/would be ingested/);
  });

  it('refuses a CLI version outside the tested range', async () => {
    const runner: CliRunner = () => Promise.resolve({ stdout: '9.0.0', stderr: '', code: 0 });
    await expect(setup(runner).judge.grade(request)).rejects.toThrow(/outside the tested range/);
  });

  it('reports a missing login on test()', async () => {
    const runner: CliRunner = () => Promise.resolve({ stdout: '2.1.0', stderr: '', code: 0 });
    const root = tmp();
    const judge = createCliJudge({
      home: join(root, 'h'),
      credentialsPath: join(root, 'none.json'),
      sourcePaths: () => Promise.resolve([]),
      run: runner,
    });
    expect(await judge.test()).toMatchObject({
      ok: false,
      detail: expect.stringContaining('No Claude login'),
    });
  });
});

describe('isolationProblem', () => {
  it('accepts a home outside every source and rejects overlap in either direction', async () => {
    const a = tmp();
    const b = tmp();
    expect(await isolationProblem(a, [b])).toBeNull();
    expect(await isolationProblem(join(a, 'home'), [a])).toMatch(/overlaps/);
    expect(await isolationProblem(a, [join(a, 'projects')])).toMatch(/overlaps/);
  });
});
