import { z } from 'zod';

export type JudgeTransport = 'api' | 'cli' | 'fake';

/** Default judge model (ADR-0006). Every grade records the model that actually answered. */
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

export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeUnavailableError';
  }
}
