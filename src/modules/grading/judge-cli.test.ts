/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCliJudge, isolationProblem, loginFile, type CliRunner } from './judge-cli.js';
import { JudgeCallError } from './types.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'introspect-cli-'));
const request = {
  rubric: { name: 'efficiency', version: 'abc', scale: [0, 1], body: 'Did it work?' },
  trace: '[e0] +0s user hello',
  eventCount: 1,
};

/** `login` is the judge's own login inside its private home; `seed` is the opt-in copy of a host file. */
function setup(
  runner: CliRunner,
  opts: { sources?: string[]; login?: boolean; seed?: boolean } = {},
) {
  const root = tmp();
  const home = join(root, 'claude-home');
  if (opts.login !== false) {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(loginFile(home), '{"claudeAiOauth":{"accessToken":"judge-own"}}');
  }
  const hostFile = join(root, 'host-credentials.json');
  writeFileSync(hostFile, '{"claudeAiOauth":{"accessToken":"host"}}');
  const judge = createCliJudge({
    home,
    ...(opts.seed && { seedCredentials: hostFile }),
    sourcePaths: () => Promise.resolve(opts.sources ?? []),
    run: runner,
  });
  return { judge, home, hostFile, root };
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
  it('runs in a private home with its own login, no API key, no tools and the verdict schema', async () => {
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
    const { judge, home } = setup(runner);
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
    // The rubric comes first (system prompt); the trace sits alone behind a random boundary.
    const system = run?.args[run.args.indexOf('--system-prompt') + 1];
    expect(system).toContain('<rubric name="efficiency">');
    expect(run?.input).toMatch(
      /^<trace-[0-9a-f]{24}>\n\[e0\] \+0s user hello\n<\/trace-[0-9a-f]{24}>/,
    );
    // Nothing is copied from anywhere: the judge's own login stays as it is.
    expect(readFileSync(loginFile(home), 'utf8')).toContain('judge-own');
  });

  it('never reaches for the host login: no login in the private home means a clear error', async () => {
    const calls: string[] = [];
    const runner: CliRunner = (_cmd, args) => {
      calls.push(args[0] ?? '');
      return Promise.resolve({ stdout: '2.1.319', stderr: '', code: 0 });
    };
    const { judge } = setup(runner, { login: false });
    await expect(judge.grade(request)).rejects.toThrow(/make claude-login/);
    expect(calls).toEqual([]); // not even the version check ran
  });

  it("copies a login file only when asked to, only once, and never over the judge's own", async () => {
    const runner: CliRunner = (_cmd, args) =>
      Promise.resolve({
        stdout: args[0] === '--version' ? '2.1.319' : answer(),
        stderr: '',
        code: 0,
      });
    const seeded = setup(runner, { login: false, seed: true });
    await seeded.judge.grade(request);
    expect(readFileSync(loginFile(seeded.home), 'utf8')).toContain('"host"');
    expect(statSync(loginFile(seeded.home)).mode & 0o777).toBe(0o600);
    const own = setup(runner, { login: true, seed: true });
    await own.judge.grade(request);
    expect(readFileSync(loginFile(own.home), 'utf8')).toContain('judge-own');
  });

  it('attaches the billed usage to an answer that is not a verdict, so the ledger can record it', async () => {
    const runner: CliRunner = (_cmd, args) =>
      Promise.resolve({
        stdout:
          args[0] === '--version'
            ? '2.1.319'
            : answer({
                structured_output: { score: 'high' },
                usage: { input_tokens: 7, output_tokens: 9 },
              }),
        stderr: '',
        code: 0,
      });
    const err = await setup(runner)
      .judge.grade(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeCallError);
    expect(err).toMatchObject({ unusable: true, usage: { input: 7, output: 9 } });
  });

  it('refuses to run when its private home would be read as an agent-log source', async () => {
    const runner: CliRunner = () => Promise.resolve({ stdout: '2.1.0', stderr: '', code: 0 });
    const root = tmp();
    const inside = join(root, 'claude-home');
    mkdirSync(inside, { recursive: true });
    const { judge } = setup(runner, { sources: [root] });
    await expect(judge.grade(request))
      .resolves.toBeDefined()
      .catch(() => undefined);
    const overlapping = createCliJudge({
      home: inside,
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
      sourcePaths: () => Promise.resolve([]),
      run: runner,
    });
    expect(await judge.test()).toMatchObject({
      ok: false,
      detail: expect.stringContaining('make claude-login'),
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
