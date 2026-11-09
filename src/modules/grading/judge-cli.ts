import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { JUDGE_INSTRUCTIONS, rubricPrompt, tracePrompt } from './prompt.js';
import {
  JUDGE_MODEL,
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
  /** Private HOME of every run; holds a copy of the login and the CLI's own session files. */
  home: string;
  /** The user's login file; read-only, copied into `home`. */
  credentialsPath: string;
  /** Registered agent-log folders; the private home must lie outside all of them. */
  sourcePaths: () => Promise<string[]>;
  binary?: string;
  model?: string;
  run?: CliRunner;
}

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

/** True when the login file exists and is not empty (an empty file is what the compose mount creates for a missing login). */
export async function credentialsPresent(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
}

/** Copies the login into the private home when the source is newer; a refreshed copy there stays. */
async function prepareHome(home: string, credentials: string): Promise<void> {
  const dest = join(home, '.claude', '.credentials.json');
  await mkdir(dirname(dest), { recursive: true });
  const [src, dst] = await Promise.all([
    stat(credentials).catch(() => null),
    stat(dest).catch(() => null),
  ]);
  if (!src?.isFile() || src.size === 0)
    throw new JudgeUnavailableError(
      `No Claude login found at ${credentials}. Run \`claude login\` on the host and mount the login file.`,
    );
  if (!dst || src.mtimeMs > dst.mtimeMs) {
    await copyFile(credentials, dest);
    await chmod(dest, 0o600);
  }
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
 * `claude -p` transport (local mode, subscription). Runs in a private HOME with a copy of the login
 * only, with no tools, no project settings and the fixed judge prompt as the whole system prompt;
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
    await prepareHome(opts.home, opts.credentialsPath);
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
    if (json.is_error === true)
      throw new Error(`claude reported an error: ${String(json.result).slice(0, 300)}`);
    return json;
  }

  return {
    transport: 'cli',
    model,

    async grade(req: JudgeRequest): Promise<JudgeResult> {
      const out = await invoke(
        [
          ...baseArgs(JUDGE_INSTRUCTIONS),
          '--json-schema',
          JSON.stringify(verdictJsonSchema(req.rubric.scale)),
        ],
        `${tracePrompt(req.trace)}\n\n${rubricPrompt(req.rubric)}`,
      );
      const json = parse(out);
      const usage = usageOf(json.usage as Record<string, unknown> | undefined);
      const answered = Object.keys((json.modelUsage as object | undefined) ?? {})[0] ?? model;
      if (typeof json.safety_stops === 'number' && json.safety_stops > 0)
        return { kind: 'refused', model: answered, usage };
      const raw =
        json.structured_output ??
        (typeof json.result === 'string' ? (JSON.parse(json.result) as unknown) : null);
      const v = verdictSchema.parse(raw);
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
        const answered = Object.keys((json.modelUsage as object | undefined) ?? {})[0] ?? model;
        return { ok: true, detail: `The claude CLI answered as ${answered}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
