import { newId } from '../../platform/db/ids.js';
import type { Db } from '../../platform/db/schema.js';
import { asBool } from '../../platform/db/json.js';
import { InvalidInputError } from '../../platform/errors.js';
import type { RubricStore } from '../rubrics/index.js';

/** NFR-10: a rubric is trusted with at least 8 of 10 agreeing labels, on at least 10 labels. */
export const GATE = { minLabels: 10, agreeNumerator: 4, agreeDenominator: 5 } as const;

export interface CalibrationStats {
  labelCount: number;
  /** Labels the judge has a grade for, for the current rubric version. */
  compared: number;
  agreed: number;
  /** `agreed / compared`, or null before anything is compared. */
  agreement: number | null;
  trusted: boolean;
}

/** Integer arithmetic, so 8 of 10 passes exactly and 7 of 10 does not. */
export function gateStats(labelCount: number, compared: number, agreed: number): CalibrationStats {
  return {
    labelCount,
    compared,
    agreed,
    agreement: compared === 0 ? null : agreed / compared,
    trusted:
      compared >= GATE.minLabels &&
      agreed * GATE.agreeDenominator >= compared * GATE.agreeNumerator,
  };
}

export interface LabelInput {
  sessionId: string;
  passed: boolean;
  score?: number | undefined;
  note?: string | undefined;
}

export interface CalibrationRow {
  sessionId: string;
  title: string;
  human: { passed: boolean; score: number | null; note: string | null };
  judge: { passed: boolean | null; score: number | null; reason: string | null } | null;
  agrees: boolean | null;
}

export interface CalibrationTable extends CalibrationStats {
  rubric: string;
  rubricOrdinal: number;
  required: { labels: number; agreement: number };
  rows: CalibrationRow[];
}

export function createCalibration(deps: {
  db: Db;
  workspaceId: string;
  userId: string;
  rubrics: Pick<RubricStore, 'get'>;
  sessionExists: (id: string) => Promise<boolean>;
  /** Labelled sessions are pinned: their payloads are never purged (ADR-0007). */
  pin: (sessionId: string) => Promise<boolean>;
  now?: () => Date;
}) {
  const { db, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());

  async function table(rubricName: string): Promise<CalibrationTable | null> {
    const rubric = await deps.rubrics.get(rubricName);
    if (!rubric) return null;
    const labels = await db
      .selectFrom('calibration_label')
      .innerJoin('session', 'session.id', 'calibration_label.session_id')
      .select([
        'calibration_label.session_id',
        'calibration_label.label',
        'calibration_label.score',
        'calibration_label.note',
        'session.title',
      ])
      .where('calibration_label.workspace_id', '=', workspaceId)
      .where('calibration_label.rubric_name', '=', rubricName)
      .orderBy('calibration_label.created_at', 'desc')
      .execute();
    const grades =
      labels.length === 0
        ? []
        : await db
            .selectFrom('grade')
            .select(['session_id', 'score', 'passed', 'reason'])
            .where('rubric_id', '=', rubric.id)
            .where('status', '=', 'ok')
            .where(
              'session_id',
              'in',
              labels.map((l) => l.session_id),
            )
            .orderBy('graded_at', 'desc')
            .execute();
    const judgeBySession = new Map<string, (typeof grades)[number]>();
    for (const g of grades)
      if (!judgeBySession.has(g.session_id)) judgeBySession.set(g.session_id, g);

    let compared = 0;
    let agreed = 0;
    const rows = labels.map((l): CalibrationRow => {
      const g = judgeBySession.get(l.session_id);
      const human = { passed: l.label === 'pass', score: l.score, note: l.note };
      if (!g)
        return {
          sessionId: l.session_id,
          title: l.title ?? 'Untitled session',
          human,
          judge: null,
          agrees: null,
        };
      const judgePassed = g.passed === null ? null : asBool(g.passed);
      const agrees = judgePassed === human.passed;
      compared += 1;
      if (agrees) agreed += 1;
      return {
        sessionId: l.session_id,
        title: l.title ?? 'Untitled session',
        human,
        judge: { passed: judgePassed, score: g.score, reason: g.reason },
        agrees,
      };
    });
    return {
      rubric: rubricName,
      rubricOrdinal: rubric.ordinal,
      required: { labels: GATE.minLabels, agreement: GATE.agreeNumerator / GATE.agreeDenominator },
      ...gateStats(labels.length, compared, agreed),
      rows,
    };
  }

  return {
    table,

    /** Human labels of these sessions for the rubric, for the dry-run comparison. */
    async labelsFor(
      rubricName: string,
      sessionIds: readonly string[],
    ): Promise<Map<string, boolean>> {
      if (sessionIds.length === 0) return new Map();
      const rows = await db
        .selectFrom('calibration_label')
        .select(['session_id', 'label'])
        .where('workspace_id', '=', workspaceId)
        .where('rubric_name', '=', rubricName)
        .where('session_id', 'in', [...sessionIds])
        .execute();
      return new Map(rows.map((r) => [r.session_id, r.label === 'pass']));
    },

    /** Insert or replace this user's label for the session ("judge was wrong" is a label opposite to the grade). */
    async setLabel(rubricName: string, input: LabelInput): Promise<void> {
      const rubric = await deps.rubrics.get(rubricName);
      if (!rubric) throw new InvalidInputError(`No rubric named "${rubricName}"`);
      if (!(await deps.sessionExists(input.sessionId)))
        throw new InvalidInputError('No such session');
      if (input.score !== undefined && !rubric.scale.includes(input.score))
        throw new InvalidInputError(`score must be one of ${rubric.scale.join(', ')}`);
      const values = {
        label: input.passed ? ('pass' as const) : ('fail' as const),
        score: input.score ?? null,
        note: input.note?.trim() ? input.note.trim() : null,
      };
      await db
        .insertInto('calibration_label')
        .values({
          id: newId(),
          workspace_id: workspaceId,
          rubric_name: rubricName,
          session_id: input.sessionId,
          user_id: deps.userId,
          created_at: now().toISOString(),
          ...values,
        })
        .onConflict((oc) =>
          oc
            .columns(['workspace_id', 'rubric_name', 'session_id', 'user_id'])
            .doUpdateSet({ ...values, created_at: now().toISOString() }),
        )
        .execute();
      await deps.pin(input.sessionId);
    },

    /** `trusted` of every rubric that has a calibration set; others are untrusted. */
    async trustedByName(names: readonly string[]): Promise<Map<string, boolean>> {
      const out = new Map<string, boolean>();
      for (const name of names) out.set(name, (await table(name))?.trusted ?? false);
      return out;
    },
  };
}

export type Calibration = ReturnType<typeof createCalibration>;
