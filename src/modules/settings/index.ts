import { z } from 'zod';
import { fromJson, toJson } from '../../platform/db/json.js';
import { unsafePatternReason } from '../../platform/regex/index.js';
import type { Db } from '../../platform/db/schema.js';
import type { SecretStore } from './secrets.js';

export { createSecretStore, type SecretStore } from './secrets.js';

/** Rejects invalid patterns and those that can backtrack catastrophically; the message tells the user why. */
const checkPattern = (p: string, ctx: z.RefinementCtx): void => {
  const reason = unsafePatternReason(p);
  if (reason) ctx.addIssue({ code: 'custom', message: reason });
};

// Runtime settings edited in the UI: flat dotted keys, one row per key in `setting` (overview section 7).
// Keys are added by the work packages that own the behaviour.
const keys = {
  'setup.completed': z.boolean(),
  'redaction.enabled': z.boolean(),
  'redaction.custom_patterns': z
    .array(z.string().min(1).max(500).superRefine(checkPattern))
    .max(50),
  'retention.days': z.number().int().min(7),
  'judge.transport': z.enum(['api', 'cli']),
  'judge.sampling': z.enum(['flagged_sample', 'every']),
  'budget.mode': z.enum(['tokens_day', 'tokens_day_and_usd_month', 'usd_month']),
  'budget.tokens_per_day': z.number().int().min(0).nullable(),
  'budget.usd_per_month': z.number().min(0).nullable(),
  'schedule.grade': z.enum(['session_end', 'pr_merge']),
  'schedule.improver': z.enum(['daily', 'weekly', 'manual']),
  'proposals.accept_mode': z.enum(['merge', 'pr']),
} as const;

export const settingsPatchSchema = z.object(keys).partial().strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const settingsSchema = z.object({
  ...keys,
  /** Read-only: the key itself is write-only via `PUT /v1/settings/judge-key`. */
  'judge.api_key_set': z.boolean(),
});
export type Settings = z.infer<typeof settingsSchema>;
const storedSchema = settingsSchema.omit({ 'judge.api_key_set': true });

const DEFAULTS: Omit<Settings, 'judge.api_key_set'> = {
  'setup.completed': false,
  'redaction.enabled': true,
  'redaction.custom_patterns': [],
  'retention.days': 90,
  'judge.transport': 'api',
  'judge.sampling': 'flagged_sample',
  'budget.mode': 'tokens_day',
  'budget.tokens_per_day': 1_000_000,
  'budget.usd_per_month': null,
  'schedule.grade': 'session_end',
  'schedule.improver': 'daily',
  'proposals.accept_mode': 'merge',
};

/**
 * SQLite hands back the stored JSON text; Postgres hands back the parsed value, which for the enum
 * settings is a bare string that `fromJson` would try to parse again. No setting value is itself
 * valid JSON when it is a string (they are enum names), so a failed parse means "already parsed".
 */
function readValue(stored: unknown): unknown {
  try {
    return fromJson(stored);
  } catch {
    return stored;
  }
}

export interface SettingsService {
  get(): Promise<Settings>;
  update(patch: SettingsPatch): Promise<Settings>;
  /** Write-only; the key never comes back through `get`. */
  setJudgeKey(apiKey: string): void;
}

export function createSettings(db: Db, workspaceId: string, secrets: SecretStore): SettingsService {
  async function get(): Promise<Settings> {
    const rows = await db
      .selectFrom('setting')
      .select(['key', 'value'])
      .where('workspace_id', '=', workspaceId)
      .execute();
    const stored = Object.fromEntries(rows.map((r) => [r.key, readValue(r.value)]));
    return settingsSchema.parse({
      ...DEFAULTS,
      ...stored,
      'judge.api_key_set': secrets.hasJudgeKey(),
    });
  }

  return {
    get,
    async update(patch) {
      // Merge into the current values and validate the whole, so no invalid state is ever stored.
      // The derived `judge.api_key_set` is stripped by the schema.
      const next = storedSchema.parse({ ...(await get()), ...patch });
      const now = new Date().toISOString();
      for (const key of Object.keys(patch) as (keyof SettingsPatch)[]) {
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
      return get();
    },
    setJudgeKey: (apiKey) => {
      secrets.setJudgeKey(apiKey);
    },
  };
}
