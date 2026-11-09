import { z } from 'zod';
import { fromJson, toJson } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';

// Runtime settings edited in the UI; one row per group in `setting` (overview section 7).
// Groups are added by the work packages that own the behaviour (judge, sources, team, ...).
const groups = {
  retention: z.object({ payload_days: z.number().int().min(7) }),
  sampling: z.object({ rate: z.number().min(0).max(1) }),
  budget: z.object({
    mode: z.enum(['tokens', 'tokens_and_dollars', 'dollars']),
    tokens_per_day: z.number().int().min(0),
    monthly_dollar_ceiling: z.number().min(0).nullable(),
  }),
  improver: z.object({ schedule: z.enum(['daily', 'weekly', 'manual']) }),
} as const;

export const settingsSchema = z.object(groups);
export type Settings = z.infer<typeof settingsSchema>;

/** Every field optional inside each group; unknown keys are rejected. */
export const settingsPatchSchema = z
  .object({
    retention: groups.retention.partial().strict(),
    sampling: groups.sampling.partial().strict(),
    budget: groups.budget.partial().strict(),
    improver: groups.improver.partial().strict(),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

const DEFAULTS: Settings = {
  retention: { payload_days: 90 },
  sampling: { rate: 0.2 },
  budget: { mode: 'tokens', tokens_per_day: 1_000_000, monthly_dollar_ceiling: null },
  improver: { schedule: 'daily' },
};

export interface SettingsService {
  get(): Promise<Settings>;
  update(patch: SettingsPatch): Promise<Settings>;
}

export function createSettings(db: Db, workspaceId: string): SettingsService {
  async function get(): Promise<Settings> {
    const rows = await db
      .selectFrom('setting')
      .select(['key', 'value'])
      .where('workspace_id', '=', workspaceId)
      .execute();
    const stored = Object.fromEntries(rows.map((r) => [r.key, fromJson(r.value)]));
    const merged = Object.fromEntries(
      Object.entries(DEFAULTS).map(([key, defaults]) => [
        key,
        { ...defaults, ...(stored[key] ?? {}) },
      ]),
    );
    return settingsSchema.parse(merged);
  }

  return {
    get,
    async update(patch) {
      const next = settingsSchema.parse(
        Object.fromEntries(
          Object.entries(await get()).map(([key, group]) => [
            key,
            { ...group, ...patch[key as keyof SettingsPatch] },
          ]),
        ),
      );
      const now = new Date().toISOString();
      for (const key of Object.keys(patch) as (keyof Settings)[]) {
        await db
          .insertInto('setting')
          .values({ workspace_id: workspaceId, key, value: toJson(next[key]), updated_at: now })
          .onConflict((oc) =>
            oc
              .columns(['workspace_id', 'key'])
              .doUpdateSet({ value: toJson(next[key]), updated_at: now }),
          )
          .execute();
      }
      return next;
    },
  };
}
