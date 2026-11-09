import { z } from 'zod';

export type JudgeTransport = 'api' | 'cli' | 'fake';

/** Default judge model (ADR-0006). A grade records the model asked for and the one that answered. */
export const JUDGE_MODEL = 'claude-sonnet-5-5';

export interface JudgeRubric {
  name: string;
  version: string;
  scale: readonly number[];
  body: string;
}

export interface JudgeRequest {
  rubric: JudgeRubric;
  /** Condensed redacted trace; events are labelled `[e<seq>]`. */
  trace: string;
  /** Events in the whole session; a trace with fewer than three needs no evidence ids. */
  eventCount: number;
}

export interface Usage {
  /** Fresh input only. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export type JudgeResult =
  | {
      kind: 'verdict';
      score: number;
      reason: string;
      /** Event labels as the model wrote them (`e12`). */
      evidence: string[];
      model: string;
      usage: Usage;
    }
  | { kind: 'refused'; model: string; usage: Usage };

/** Port of the grading module (ADR-0006): one request per (session, rubric). */
export interface Judge {
  readonly transport: JudgeTransport;
  /** The model asked for; a verdict reports the one that answered. */
  readonly model: string;
  grade(req: JudgeRequest): Promise<JudgeResult>;
  /** A tiny real request that proves the transport works. */
  test(): Promise<{ ok: boolean; detail: string }>;
}

/** What a judge must return, whatever the transport. */
export const verdictSchema = z.object({
  score: z.number(),
  reason: z.string().min(1),
  evidenceEventIds: z.array(z.string()),
});

export const verdictJsonSchema = (scale: readonly number[]): Record<string, unknown> => ({
  type: 'object',
  properties: {
    score: { type: 'number', enum: [...scale] },
    reason: { type: 'string' },
    evidenceEventIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'reason', 'evidenceEventIds'],
  additionalProperties: false,
});

/**
 * A call that got a response but not a verdict. `usage` is what the response billed, so the
 * ledger records it. `unusable` means the answer itself was bad (cut off, not JSON, off schema):
 * the grader counts it as one of its own attempts instead of failing the job.
 */
export class JudgeCallError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
    readonly model: string,
    readonly unusable: boolean,
  ) {
    super(message);
    this.name = 'JudgeCallError';
  }
}

export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeUnavailableError';
  }
}
