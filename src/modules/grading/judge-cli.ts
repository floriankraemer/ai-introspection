import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { buildPrompt } from './prompt.js';
import {
  JUDGE_MODEL,
  JudgeCallError,
  JudgeUnavailableError,
  verdictJsonSchema,
  verdictSchema,
  type Judge,
  type JudgeRequest,
  type JudgeResult,
  type Usage,
} from './types.js';

const CLI_TIMEOUT_MS = 10 * 60_000;
/** The CLI flags used here were checked against this major version (ADR-0006: refuse an untested range). */
const TESTED_MAJOR = 2;

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
}
export type CliRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number },
) => Promise<CliRun>;

export const spawnRunner: CliRunner = (cmd, args, { cwd, env, input, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => undefined); // the CLI may exit before reading all input
    child.stdin.end(input ?? '');
  });

export interface CliJudgeOptions {
  /**
   * The judge's own HOME. It holds the judge's own `claude login` (never the user's: a second
   * client of the same login can rotate its refresh token and sign the user out) and the CLI's
   * session files.
   */
  home: string;
  /**
   * Opt-in, native runs only: a login file copied into `home` once, when `home` has none.
   * The copy shares the user's refresh token, so a refresh on either side can invalidate the other.
   */
  seedCredentials?: string | undefined;
  /** Registered agent-log folders; the private home must lie outside all of them. */
  sourcePaths: () => Promise<string[]>;
  binary?: string;
  model?: string;
  run?: CliRunner;
}

/** Where `claude auth login` stores the login when HOME is `home`. */
export const loginFile = (home: string): string => join(home, '.claude', '.credentials.json');

export const LOGIN_HINT =
  'Run `make claude-login` (Docker) or `introspect judge-login` (native) once: the judge keeps its own Claude login, separate from yours.';

const contains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Null when the private home cannot be mistaken for agent logs: neither inside a source folder nor
 * holding one. The judge's own sessions then never reach the ingest watcher (ADR-0006).
 */
export async function isolationProblem(
  home: string,
  sources: readonly string[],
): Promise<string | null> {
  const resolve = (p: string): Promise<string> => realpath(p).catch(() => p);
  const h = await resolve(home);
  for (const source of sources) {
    const s = await resolve(source);
    if (contains(s, h) || contains(h, s))
      return `${home} overlaps the agent-log source ${source}; judge sessions would be ingested`;
  }
  return null;
}

/** True when the login file exists and is not empty. */
export async function credentialsPresent(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
}

/** Makes the private home, and seeds the opt-in login copy when `home` has none; throws when there is no login. */
async function prepareHome(home: string, seed: string | undefined): Promise<void> {
  const dest = loginFile(home);
  await mkdir(dirname(dest), { recursive: true });
  if (!(await credentialsPresent(dest)) && seed && (await credentialsPresent(seed))) {
    await copyFile(seed, dest);
    await chmod(dest, 0o600);
  }
  if (!(await credentialsPresent(dest)))
    throw new JudgeUnavailableError(`The judge has no Claude login in ${home}. ${LOGIN_HINT}`);
}

/** `claude auth login` in the judge's private home, attached to the terminal. Resolves with the exit code. */
export function judgeLogin(home: string, binary = 'claude'): Promise<number | null> {
  return mkdir(join(home, '.claude'), { recursive: true }).then(
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(binary, ['auth', 'login', '--claudeai'], {
          env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: '' },
          stdio: 'inherit',
        });
        child.on('error', reject);
        child.on('close', resolve);
      }),
  );
}

function usageOf(u: Record<string, unknown> | undefined): Usage {
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    input: n(u?.input_tokens),
    cacheRead: n(u?.cache_read_input_tokens),
    cacheWrite: n(u?.cache_creation_input_tokens),
    output: n(u?.output_tokens),
  };
}

/**
 * `claude -p` transport (local mode, subscription). Runs in a private HOME with the judge's own login,
 * with no tools, no project settings and the fixed judge prompt as the whole system prompt;
 * the verdict comes back as structured output and is checked with the same schema as the API's.
 */
export function createCliJudge(opts: CliJudgeOptions): Judge {
  const model = opts.model ?? JUDGE_MODEL;
  const binary = opts.binary ?? 'claude';
  const run = opts.run ?? spawnRunner;
  let versionChecked = false;

  const env = (): NodeJS.ProcessEnv => ({
    // No API key: this transport is the subscription login, whatever the environment holds.
    PATH: process.env.PATH,
    HOME: opts.home,
    LANG: process.env.LANG ?? 'C.UTF-8',
  });

  async function invoke(args: string[], input: string): Promise<CliRun> {
    const problem = await isolationProblem(opts.home, await opts.sourcePaths());
    if (problem) throw new JudgeUnavailableError(problem);
    await prepareHome(opts.home, opts.seedCredentials);
    const cwd = join(opts.home, 'runs');
    await mkdir(cwd, { recursive: true });
    if (!versionChecked) {
      const v = await run(binary, ['--version'], { cwd, env: env(), timeoutMs: 30_000 }).catch(
        () => {
          throw new JudgeUnavailableError('The claude CLI is not installed');
        },
      );
      const major = Number(/^(\d+)\./.exec(v.stdout.trim())?.[1]);
      if (major !== TESTED_MAJOR)
        throw new JudgeUnavailableError(
          `claude ${v.stdout.trim()} is outside the tested range (${String(TESTED_MAJOR)}.x)`,
        );
      versionChecked = true;
    }
    return run(binary, args, { cwd, env: env(), input, timeoutMs: CLI_TIMEOUT_MS });
  }

  const baseArgs = (system: string): string[] => [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--model',
    model,
    '--system-prompt',
    system,
  ];

  function parse(out: CliRun): Record<string, unknown> {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(out.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(
        `claude exited with ${String(out.code)} and no JSON: ${out.stderr.slice(0, 300)}`,
      );
    }
    return json;
  }

  return {
    transport: 'cli',
    model,

    async grade(req: JudgeRequest): Promise<JudgeResult> {
      const prompt = buildPrompt(req);
      const out = await invoke(
        [
          ...baseArgs(prompt.system),
          '--json-schema',
          JSON.stringify(verdictJsonSchema(req.rubric.scale)),
        ],
        prompt.user,
      );
      const json = parse(out);
      const usage = usageOf(json.usage as Record<string, unknown> | undefined);
      const answered = Object.keys((json.modelUsage as object | undefined) ?? {})[0] ?? model;
      // The CLI answered, so whatever it billed goes on the ledger even when the verdict is unusable.
      if (json.is_error === true)
        throw new JudgeCallError(
          `claude reported an error: ${String(json.result).slice(0, 300)}`,
          usage,
          answered,
          false,
        );
      if (typeof json.safety_stops === 'number' && json.safety_stops > 0)
        return { kind: 'refused', model: answered, usage };
      const parsed = (() => {
        try {
          const raw =
            json.structured_output ??
            (typeof json.result === 'string' ? (JSON.parse(json.result) as unknown) : null);
          return verdictSchema.safeParse(raw);
        } catch {
          return undefined;
        }
      })();
      if (!parsed?.success)
        throw new JudgeCallError(
          'The judge answered with something that is not a verdict',
          usage,
          answered,
          true,
        );
      const v = parsed.data;
      return {
        kind: 'verdict',
        score: v.score,
        reason: v.reason,
        evidence: v.evidenceEventIds,
        model: answered,
        usage,
      };
    },

    async test() {
      try {
        const out = await invoke(baseArgs('You answer with one word.'), 'Reply with the word OK.');
        const json = parse(out);
        if (json.is_error === true)
          throw new Error(`claude reported an error: ${String(json.result).slice(0, 300)}`);
        const answered = Object.keys((json.modelUsage as object | undefined) ?? {})[0] ?? model;
        return { ok: true, detail: `The claude CLI answered as ${answered}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
