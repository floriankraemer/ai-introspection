import type { Improver, ImproveRequest, ImproveResult } from './types.js';
import { NO_USAGE } from './types.js';

/**
 * Deterministic improver for tests and `INTROSPECT_IMPROVER=fake`: appends one rule derived from
 * the cluster's first reason to CLAUDE.md. Never selectable from the UI.
 */
export function createFakeImprover(
  decide?: (req: ImproveRequest) => ImproveResult | undefined,
  model = 'fake-improver',
): Improver & { calls: ImproveRequest[] } {
  const calls: ImproveRequest[] = [];
  return {
    transport: 'fake',
    model,
    calls,
    propose(req) {
      calls.push(req);
      const custom = decide?.(req);
      if (custom) return Promise.resolve(custom);
      const first = req.cluster.failures[0];
      const existing = req.files['CLAUDE.md'] ?? '# Instructions\n';
      const rule = `\n## Avoid: ${req.cluster.rubrics.join(', ')}\n\n- ${(first?.reason ?? req.cluster.summary).slice(0, 200)} (${req.cluster.summary})\n`;
      return Promise.resolve({
        kind: 'proposal' as const,
        title: `Address ${req.cluster.rubrics.join(', ')} failures`,
        rationale: `Fake improver: ${req.cluster.summary}`,
        edits: [{ path: 'CLAUDE.md', content: existing.replace(/\n*$/, '\n') + rule }],
        model,
        usage: { ...NO_USAGE, input: 1000, output: 200 },
      });
    },
  };
}
