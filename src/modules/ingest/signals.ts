import { createHash } from 'node:crypto';

/** Bump when a signal definition changes, so stored signals can be recomputed. */
export const SIGNAL_VERSION = 1;
const RETRY_WINDOW = 5;
const REPEAT_THRESHOLD = 3;
export const SAMPLE_PERCENT = 20;
const FLAG_THRESHOLDS = { failedToolCalls: 3, repeatedCommands: 1, retries: 2 } as const;
const SHELL_NAMES = new Set(['bash', 'shell']);
const TOOL_KINDS = new Set(['tool_call', 'file_op', 'mcp', 'skill']);
const TEST_COMMAND =
  /\b(?:vitest|jest|pytest|phpunit|mocha|rspec|go test|cargo test|dotnet test|make test|(?:npm|pnpm|yarn|bun)(?: run)? test)\b/;

export interface Signals {
  failedToolCalls: number;
  retries: number;
  repeatedCommands: number;
  filesTouched: number;
  testsRun: number;
}

export interface SignalEvent {
  kind: string;
  name: string | null;
  input: string | null;
  isError: boolean;
}

function parseInput(input: string | null): Record<string, unknown> {
  if (!input) return {};
  try {
    const v: unknown = JSON.parse(input);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {}; // truncated or purged payload
  }
}

/** The shell command line of a Bash or Codex shell call. */
function commandOf(input: Record<string, unknown>): string | undefined {
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((p) => typeof p === 'string')) {
    const parts = c;
    const flag = parts[1];
    return parts.length >= 3 && (flag === '-c' || flag === '-lc') ? parts[2] : parts.join(' ');
  }
  return undefined;
}

function pathsOf(input: Record<string, unknown>): string[] {
  const single = [input.file_path, input.path, input.notebook_path].filter(
    (p): p is string => typeof p === 'string',
  );
  const many = Array.isArray(input.files)
    ? input.files.filter((p): p is string => typeof p === 'string')
    : [];
  return [...single, ...many];
}

/** Streaming computation, so a session of any length is processed page by page. */
export class SignalAccumulator {
  private index = 0;
  private failed = 0;
  private retries = 0;
  private tests = 0;
  private readonly commands = new Map<string, number>();
  private readonly files = new Set<string>();
  private recentErrors: { index: number; key: string }[] = [];

  add(e: SignalEvent): void {
    const i = this.index++;
    this.recentErrors = this.recentErrors.filter((r) => i - r.index <= RETRY_WINDOW);
    const input = parseInput(e.input);
    const key = `${e.name ?? ''}\u0000${(e.input ?? '').replace(/\s+/g, ' ')}`;
    if (TOOL_KINDS.has(e.kind)) {
      const retried = this.recentErrors.findIndex((r) => r.key === key);
      if (retried >= 0) {
        this.retries += 1;
        this.recentErrors.splice(retried, 1);
      }
      if (e.isError) {
        this.failed += 1;
        this.recentErrors.push({ index: i, key });
      }
    }
    if (e.kind === 'file_op') for (const p of pathsOf(input)) this.files.add(p);
    if (e.kind === 'tool_call' && e.name && SHELL_NAMES.has(e.name)) {
      const command = commandOf(input)?.trim();
      if (command) {
        this.commands.set(command, (this.commands.get(command) ?? 0) + 1);
        if (TEST_COMMAND.test(command)) this.tests += 1;
      }
    }
  }

  result(): Signals {
    return {
      failedToolCalls: this.failed,
      retries: this.retries,
      repeatedCommands: [...this.commands.values()].filter((n) => n >= REPEAT_THRESHOLD).length,
      filesTouched: this.files.size,
      testsRun: this.tests,
    };
  }
}

export function isFlagged(s: Signals): boolean {
  return (
    s.failedToolCalls >= FLAG_THRESHOLDS.failedToolCalls ||
    s.repeatedCommands >= FLAG_THRESHOLDS.repeatedCommands ||
    s.retries >= FLAG_THRESHOLDS.retries
  );
}

/** Stable across re-runs: depends on the session id only (ADR-0007). */
export function isSampled(sessionId: string): boolean {
  return createHash('sha1').update(sessionId).digest().readUInt32BE(0) % 100 < SAMPLE_PERCENT;
}
