import { newId } from '../../platform/db/ids.js';
import type { Db } from '../../platform/db/schema.js';
import type { Settings } from '../settings/index.js';
import type { Usage } from './types.js';

/** USD per million tokens, from the model list in ADR-0006. Cache writes cost 1.25x input. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
const FALLBACK_PRICE = { input: 2, output: 10, cacheRead: 0.2 };
const CACHE_WRITE_FACTOR = 1.25;
/** What one verdict costs in output, for the pre-call budget check. */
export const ESTIMATED_OUTPUT_TOKENS = 1500;

/** Estimated dollars at API list prices. For the CLI transport this is an estimate too (ADR-0006). */
export function costOf(model: string, u: Usage): number {
  const p = PRICES[model] ?? FALLBACK_PRICE;
  return (
    (u.input * p.input +
      u.cacheWrite * p.input * CACHE_WRITE_FACTOR +
      u.cacheRead * p.cacheRead +
      u.output * p.output) /
    1_000_000
  );
}

/** Dollars for the pre-call budget check: all input at the list price, no cache discount. */
export const estimateCost = (model: string, inputTokens: number): number =>
  costOf(model, {
    input: inputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    output: ESTIMATED_OUTPUT_TOKENS,
  });

export const startOfDay = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate());
export const nextMidnight = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
export const startOfMonth = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), 1);
export const nextMonth = (now: Date): Date => new Date(now.getFullYear(), now.getMonth() + 1, 1);

type BudgetSettings = Pick<
  Settings,
  'budget.mode' | 'budget.tokens_per_day' | 'budget.usd_per_month'
>;

export interface BudgetStatus {
  mode: BudgetSettings['budget.mode'];
  /** Fresh input plus output tokens since local midnight; cache reads do not count. */
  tokensToday: number;
  /** Null when unlimited or when the mode ignores it. */
  tokensPerDay: number | null;
  /** Estimated dollars since the first of the month, at API list prices. */
  usdMonth: number;
  usdPerMonth: number | null;
  deferredJobs: number;
  tokensResetAt: string;
  usdResetAt: string;
}

export interface Deferral {
  runAfter: Date;
  reason: string;
}

/** Aggregates come back as strings on Postgres and as null over no rows. */
const num = (v: unknown): number => Number(v ?? 0);

export function createBudget(db: Db, workspaceId: string, getSettings: () => Promise<Settings>) {
  async function used(now: Date): Promise<{ tokens: number; usd: number }> {
    const sum = (since: Date) =>
      db
        .selectFrom('llm_call')
        .select((eb) => [
          eb.fn.sum<number>('tokens_in').as('in'),
          eb.fn.sum<number>('tokens_out').as('out'),
          eb.fn.sum<number>('cost_estimate').as('usd'),
        ])
        .where('workspace_id', '=', workspaceId)
        .where('at', '>=', since.toISOString())
        .executeTakeFirstOrThrow();
    const day = await sum(startOfDay(now));
    const month = await sum(startOfMonth(now));
    return { tokens: num(day.in) + num(day.out), usd: num(month.usd) };
  }

  const limitsOf = (s: BudgetSettings) => ({
    tokens: s['budget.mode'] === 'usd_month' ? null : s['budget.tokens_per_day'],
    usd: s['budget.mode'] === 'tokens_day' ? null : s['budget.usd_per_month'],
  });

  return {
    async status(now = new Date()): Promise<BudgetStatus> {
      const s = await getSettings();
      const u = await used(now);
      const limit = limitsOf(s);
      const deferred = await db
        .selectFrom('job')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('workspace_id', '=', workspaceId)
        .where('status', '=', 'deferred')
        .executeTakeFirstOrThrow();
      return {
        mode: s['budget.mode'],
        tokensToday: u.tokens,
        tokensPerDay: limit.tokens,
        usdMonth: u.usd,
        usdPerMonth: limit.usd,
        deferredJobs: num(deferred.n),
        tokensResetAt: nextMidnight(now).toISOString(),
        usdResetAt: nextMonth(now).toISOString(),
      };
    },

    /** Null when the call fits. Otherwise when to try again: midnight for tokens, the next month for dollars. */
    async check(
      estimate: { tokens: number; usd: number },
      now = new Date(),
    ): Promise<Deferral | null> {
      const limit = limitsOf(await getSettings());
      const u = await used(now);
      if (limit.usd !== null && u.usd + estimate.usd > limit.usd) {
        return {
          runAfter: nextMonth(now),
          reason: `the monthly dollar budget of $${String(limit.usd)} is used up`,
        };
      }
      if (limit.tokens !== null && u.tokens + estimate.tokens > limit.tokens) {
        return {
          runAfter: nextMidnight(now),
          reason: `the daily token budget of ${String(limit.tokens)} is used up`,
        };
      }
      return null;
    },

    /** One ledger row per LLM call (ADR-0006); the budget limits are sums over it. */
    async record(
      call: {
        purpose: 'grade' | 'dry_run';
        model: string;
        transport: string;
        usage: Usage;
        refId: string;
        userId: string | null;
      },
      now = new Date(),
    ): Promise<string> {
      const id = newId();
      await db
        .insertInto('llm_call')
        .values({
          id,
          workspace_id: workspaceId,
          user_id: call.userId,
          at: now.toISOString(),
          purpose: call.purpose,
          model: call.model,
          transport: call.transport,
          tokens_in: call.usage.input + call.usage.cacheWrite,
          cache_read_tokens: call.usage.cacheRead,
          tokens_out: call.usage.output,
          cost_estimate: costOf(call.model, call.usage),
          ref_id: call.refId,
        })
        .execute();
      return id;
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;
