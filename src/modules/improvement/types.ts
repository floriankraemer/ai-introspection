import { z } from 'zod';
import type { Usage } from '../grading/index.js';

/** Default improver model (ADR-0006): it edits instructions that shape every later session. */
export const IMPROVER_MODEL = 'claude-opus-5-5';

export type ImproverTransport = 'api' | 'cli' | 'fake';

export interface ClusterFailure {
  sessionId: string;
  title: string;
  rubric: string;
  reason: string;
  /** Condensed, redacted evidence lines (`[e12] bash ✕ ...`). */
  evidence: string[];
}

export interface ClusterInput {
  id: string;
  rubrics: string[];
  summary: string;
  failures: ClusterFailure[];
}

export interface ImproveRequest {
  cluster: ClusterInput;
  target: { kind: 'global' | 'project'; allowList: readonly string[] };
  /** Read-only snapshot of the target's allowed files (repo-relative path to content). */
  files: Readonly<Record<string, string>>;
  /**
   * What the budget reserved for this call, in tokens (input + output). A multi-turn adapter stops
   * with a `budget` decline before a turn that could push its total past it.
   */
  tokenCap?: number;
}

export interface FileEdit {
  path: string;
  /** The whole new content; `null` deletes the file. */
  content: string | null;
}

export type ImproveResult =
  | {
      kind: 'proposal';
      title: string;
      rationale: string;
      edits: FileEdit[];
      model: string;
      usage: Usage;
    }
  | { kind: 'none'; reason: string; model: string; usage: Usage; budget?: true };

/**
 * Port of the improvement module (ADR-0006). An adapter reads the snapshot in the request and
 * returns whole-file edits; Introspect writes them into a git worktree and derives the diff, so
 * an adapter can never touch the user's files, a path outside the worktree, or the git history.
 */
export interface Improver {
  readonly transport: ImproverTransport;
  readonly model: string;
  propose(req: ImproveRequest): Promise<ImproveResult>;
}

/** What an adapter must return, whatever the transport. */
export const proposalSchema = z.object({
  title: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(4000),
  edits: z
    .array(z.object({ path: z.string().min(1), content: z.string().nullable() }))
    .min(1)
    .max(20),
});

export const proposalJsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'At most 80 characters, imperative' },
    rationale: { type: 'string', description: 'Why this change fixes the failures' },
    declineReason: {
      type: 'string',
      description: 'Set only when no instruction change would help; then leave edits empty',
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'The complete new content of the file' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'rationale', 'declineReason', 'edits'],
  additionalProperties: false,
} as const;

/** A call that got a response but no usable proposal; `usage` is what it billed, so the ledger records it. */
export class ImproverCallError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
    readonly model: string,
  ) {
    super(message);
    this.name = 'ImproverCallError';
  }
}

export class ImproverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImproverUnavailableError';
  }
}

export const NO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});
