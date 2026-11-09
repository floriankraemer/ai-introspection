export type Agent = 'claude_code' | 'codex';
export const AGENTS: readonly Agent[] = ['claude_code', 'codex'];

export type EventKind =
  'user' | 'assistant' | 'tool_call' | 'file_op' | 'mcp' | 'skill' | 'system' | 'unknown';

/** A normalized event before redaction and storage. Message text lives in `output`; tool arguments in `input`. */
export interface RawEvent {
  kind: EventKind;
  name?: string | undefined;
  /** Tool-use id; a later `result` item with the same id completes this event. */
  callId?: string | undefined;
  ts?: string | undefined;
  input?: string | undefined;
  output?: string | undefined;
  isError?: boolean | undefined;
}

export type ParsedItem =
  | {
      type: 'meta';
      cwd?: string | undefined;
      branch?: string | undefined;
      model?: string | undefined;
      ts?: string | undefined;
      title?: string | undefined;
      /** Per-message usage; the pipeline keeps the latest value per message id, so repeated lines count once. */
      usage?: { messageId: string; tokensIn: number; tokensOut: number } | undefined;
      /** Running totals reported by the agent itself. */
      totalTokens?: { tokensIn: number; tokensOut: number } | undefined;
      outcome?: { kind: 'pr_open'; ref: string } | undefined;
    }
  | { type: 'event'; event: RawEvent }
  | { type: 'result'; callId: string; ts?: string | undefined; output: string; isError: boolean }
  /** The adapter met a record it does not know; stored as an `unknown` event and counted in `ingest_warnings`. */
  | { type: 'unknown'; recordType: string; ts?: string | undefined };

export interface LineParser {
  parseLine(line: string): ParsedItem[];
}

/** One adapter per agent (ADR-0007). `parseLine` replaces the ADR's async iterator so the pipeline owns byte offsets. */
export interface SourceAdapter {
  agent: Agent;
  version: string;
  /** Whether this file is a session log of the agent, judged by its path below the source root. */
  matches(relativePath: string): boolean;
  /** Native session id when the filename alone decides it. */
  nativeIdFromPath(path: string): string;
  /** A fresh parser per file run; `knownNativeId` is set when resuming from a byte offset. */
  createParser(): LineParser;
}

export type MetaItem = Extract<ParsedItem, { type: 'meta' }>;
