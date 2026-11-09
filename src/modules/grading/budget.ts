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
/** A reservation older than this belongs to a process that died; it stops counting against the budget. Longer than any call can run (an improver loop is up to 10 API turns, a CLI call times out at 20 minutes). */
export const STALE_RESERVATION_MS = 3 * 60 * 60_000;

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

/** The wall-clock parts of an instant in a time zone. */
function zonedParts(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month') - 1, d: get('day') };
}

/** The instant at which the wall clock of `timeZone` reads midnight on the given date (month and day may overflow). */
export function zonedMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const wall = Date.UTC(y, m, d);
  const offsetAt = (instant: number): number => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(new Date(instant));
    const g = (type: string): number => Number(p.find((x) => x.type === type)?.value);
    return (
      Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - instant
    );
  };
  // Two passes settle the offset across a DST change.
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

/** Budget windows follow the configured time zone (env `TZ`, default UTC). */
export const windows = (timeZone: string) => ({
  startOfDay: (now: Date): Date => {
    const { y, m, d } = zonedParts(now, timeZone);
    return zonedMidnight(y, m, d, timeZone);
  },
  nextMidnight: (now: Date): Date => {
    const { y, m, d } = zonedParts(now, timeZone);
    return zonedMidnight(y, m, d + 1, timeZone);
  },
  startOfMonth: (now: Date): Date => {
    const { y, m } = zonedParts(now, timeZone);
    return zonedMidnight(y, m, 1, timeZone);
  },
  nextMonth: (now: Date): Date => {
    const { y, m } = zonedParts(now, timeZone);
    return zonedMidnight(y, m + 1, 1, timeZone);
  },
});

type BudgetSettings = Pick<
  Settings,
  'budget.mode' | 'budget.tokens_per_day' | 'budget.usd_per_month'
>;

export interface BudgetStatus {
  mode: BudgetSettings['budget.mode'];
  /** Fresh input plus output tokens since midnight in the configured time zone; cache reads do not count. */
  tokensToday: number;
  /** Null when unlimited or when the mode ignores it. */
  tokensPerDay: number | null;
  /** Estimated dollars since the first of the month, at API list prices. */
  usdMonth: number;
  usdPerMonth: number | null;
  /** The improver's share of the two figures above (its calls are on the same ledger). */
  improver: { tokensToday: number; usdMonth: number };
  deferredJobs: number;
  tokensResetAt: string;
  usdResetAt: string;
}

export interface Deferral {
  runAfter: Date;
  reason: string;
}

export interface CallMeta {
  purpose: 'grade' | 'dry_run' | 'improve';
  /** The model asked for; `settle` replaces it with the one that answered. */
  model: string;
  transport: string;
  refId: string;
  userId: string | null;
}

export type Reservation =
  | { kind: 'reserved'; id: string }
  | { kind: 'deferred'; deferral: Deferral }
  /** The estimate alone exceeds the whole limit; waiting would never help. */
  | { kind: 'too_large'; reason: string };

/** Aggregates come back as strings on Postgres and as null over no rows. */
const num = (v: unknown): number => Number(v ?? 0);

export function createBudget(
  db: Db,
  workspaceId: string,
  getSettings: () => Promise<Settings>,
  timeZone = 'UTC',
) {
  const w = windows(timeZone);

  async function used(
    q: Db,
    now: Date,
  ): Promise<{ tokens: number; usd: number; improver: { tokens: number; usd: number } }> {
    const live = new Date(now.getTime() - STALE_RESERVATION_MS).toISOString();
    const sum = (since: Date, onlyImprover: boolean) => {
      let qb = q
        .selectFrom('llm_call')
        .select((eb) => [
          eb.fn.sum<number>('tokens_in').as('in'),
          eb.fn.sum<number>('tokens_out').as('out'),
          eb.fn.sum<number>('cost_estimate').as('usd'),
        ])
        .where('workspace_id', '=', workspaceId)
        .where('at', '>=', since.toISOString())
        .where((eb) => eb.or([eb('status', '!=', 'reserved'), eb('at', '>=', live)]));
      if (onlyImprover) qb = qb.where('purpose', 'in', ['improve', 'cluster']);
      return qb.executeTakeFirstOrThrow();
    };
    const [day, month, iDay, iMonth] = [
      await sum(w.startOfDay(now), false),
      await sum(w.startOfMonth(now), false),
      await sum(w.startOfDay(now), true),
      await sum(w.startOfMonth(now), true),
    ];
    return {
      tokens: num(day.in) + num(day.out),
      usd: num(month.usd),
      improver: { tokens: num(iDay.in) + num(iDay.out), usd: num(iMonth.usd) },
    };
  }

  const limitsOf = (s: BudgetSettings) => ({
    tokens: s['budget.mode'] === 'usd_month' ? null : s['budget.tokens_per_day'],
    usd: s['budget.mode'] === 'tokens_day' ? null : s['budget.usd_per_month'],
  });

  return {
    async status(now = new Date()): Promise<BudgetStatus> {
      const s = await getSettings();
      const u = await used(db, now);
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
        improver: { tokensToday: u.improver.tokens, usdMonth: u.improver.usd },
        deferredJobs: num(deferred.n),
        tokensResetAt: w.nextMidnight(now).toISOString(),
        usdResetAt: w.nextMonth(now).toISOString(),
      };
    },

    /**
     * Checks the budget and puts the estimate on the ledger in one transaction, so parallel
     * calls cannot all see the same free room. The row counts against the limits until `settle`
     * replaces the estimate with the real usage, or `release` drops it.
     */
    async reserve(
      call: CallMeta,
      estimate: { inputTokens: number; usd: number; outputTokens?: number },
      now = new Date(),
    ): Promise<Reservation> {
      const outputTokens = estimate.outputTokens ?? ESTIMATED_OUTPUT_TOKENS;
      const tokens = estimate.inputTokens + outputTokens;
      // Read before the transaction: on SQLite the transaction owns the only connection.
      const limit = limitsOf(await getSettings());
      if (limit.usd !== null && estimate.usd > limit.usd)
        return {
          kind: 'too_large',
          reason: `this call is estimated at $${estimate.usd.toFixed(4)}, more than the whole monthly dollar budget of $${String(limit.usd)}; raise the budget or grade a shorter session`,
        };
      if (limit.tokens !== null && tokens > limit.tokens)
        return {
          kind: 'too_large',
          reason: `this call is estimated at ${String(tokens)} tokens, more than the whole daily token budget of ${String(limit.tokens)}; raise the budget or grade a shorter session`,
        };
      return db.transaction().execute(async (tx): Promise<Reservation> => {
        // A row lock on the workspace serialises reservations on Postgres (SQLite has one writer).
        await tx
          .updateTable('workspace')
          .set({ id: workspaceId })
          .where('id', '=', workspaceId)
          .execute();
        const u = await used(tx, now);
        if (limit.usd !== null && u.usd + estimate.usd > limit.usd) {
          return {
            kind: 'deferred',
            deferral: {
              runAfter: w.nextMonth(now),
              reason: `the monthly dollar budget of $${String(limit.usd)} is used up`,
            },
          };
        }
        if (limit.tokens !== null && u.tokens + tokens > limit.tokens) {
          return {
            kind: 'deferred',
            deferral: {
              runAfter: w.nextMidnight(now),
              reason: `the daily token budget of ${String(limit.tokens)} is used up`,
            },
          };
        }
        const id = newId();
        await tx
          .insertInto('llm_call')
          .values({
            id,
            workspace_id: workspaceId,
            user_id: call.userId,
            at: now.toISOString(),
            purpose: call.purpose,
            model: call.model,
            transport: call.transport,
            tokens_in: estimate.inputTokens,
            tokens_out: outputTokens,
            cost_estimate: estimate.usd,
            ref_id: call.refId,
            status: 'reserved',
          })
          .execute();
        return { kind: 'reserved', id };
      });
    },

    /** One ledger row per LLM call that got a response (ADR-0006); the budget limits are sums over it. */
    async settle(
      id: string,
      result: { model: string; usage: Usage; status: 'ok' | 'error' },
    ): Promise<number> {
      const cost = costOf(result.model, result.usage);
      await db
        .updateTable('llm_call')
        .set({
          model: result.model,
          tokens_in: result.usage.input + result.usage.cacheWrite,
          cache_read_tokens: result.usage.cacheRead,
          tokens_out: result.usage.output,
          cost_estimate: cost,
          status: result.status,
        })
        .where('id', '=', id)
        .execute();
      return cost;
    },

    /** The call never got a response: nothing was spent, so the reservation goes away. */
    async release(id: string): Promise<void> {
      await db
        .deleteFrom('llm_call')
        .where('id', '=', id)
        .where('status', '=', 'reserved')
        .execute();
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;
