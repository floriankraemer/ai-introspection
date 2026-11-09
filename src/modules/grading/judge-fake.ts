import type { Judge, JudgeRequest } from './types.js';

/** Failed events as the condenser writes them: `[e12] +3s bash ✕ ...`. */
const FAILED = /^\[(e\d+)\] \+\d+s \S+ ✕/gm;

export interface FakeDecision {
  score: number;
  reason: string;
  evidence: string[];
}

/**
 * Deterministic judge for tests and for `INTROSPECT_JUDGE=fake`: three or more failed events
 * score the lowest value of the scale, fewer score the highest; the first event is the evidence of a clean session. Never selectable from the UI.
 */
export function createFakeJudge(
  decide?: (req: JudgeRequest) => FakeDecision,
  model = 'fake-judge',
): Judge & { calls: JudgeRequest[] } {
  const calls: JudgeRequest[] = [];
  return {
    transport: 'fake',
    model,
    calls,
    grade(req) {
      calls.push(req);
      const failed = [...req.trace.matchAll(FAILED)].map((m) => m[1] ?? '');
      const verdict = decide?.(req) ?? {
        score: failed.length >= 3 ? Math.min(...req.rubric.scale) : Math.max(...req.rubric.scale),
        reason: `Fake judge: ${String(failed.length)} failed events.`,
        // Every score cites an event; a clean session cites its first one.
        evidence:
          failed.length > 0 ? failed.slice(0, 3) : [/^\[(e\d+)\]/m.exec(req.trace)?.[1] ?? ''],
      };
      return Promise.resolve({
        kind: 'verdict' as const,
        ...verdict,
        model,
        usage: { input: Math.ceil(req.trace.length / 4), cacheRead: 0, cacheWrite: 0, output: 60 },
      });
    },
    test: () => Promise.resolve({ ok: true, detail: 'Fake judge (test only)' }),
  };
}
