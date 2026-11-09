import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../api/context.js';
import { GRADE_KEYS, invalidateKeys, useSessions } from '../api/queries.js';
import { titleText } from '../lib/format.js';
import { Button, Field, FIELD } from './ui.js';

/**
 * Records your verdict on one session for one rubric. The same form serves "Judge was wrong"
 * (session fixed, verdict preset to the opposite of the judge) and the calibration table's
 * "Add label" (you pick the session).
 */
export function LabelForm({
  rubric,
  sessionId,
  defaultPassed,
  skip = [],
  onDone,
  onCancel,
}: {
  rubric: string;
  sessionId?: string;
  /** Preset verdict; leave out to require an explicit pick. */
  defaultPassed?: boolean;
  /** Sessions that already have a label for this rubric. */
  skip?: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const name = useId();
  const sessions = useSessions({ result: 'all', limit: 50 });
  // The picker offers only sessions the judge has already graded for this rubric, with its verdict.
  const options = (sessions.data?.pages.flatMap((p) => p.items) ?? []).flatMap((s) => {
    const g = s.grades.find((x) => x.rubric === rubric);
    return skip.includes(s.id) || g?.passed == null ? [] : [{ s, judge: g.passed }];
  });
  const [picked, setPicked] = useState('');
  const [passed, setPassed] = useState<boolean | undefined>(defaultPassed);
  const [score, setScore] = useState('');
  const [note, setNote] = useState('');
  const target = sessionId ?? picked;
  const parsed = score.trim() === '' ? undefined : Number(score);
  const scoreBad = parsed !== undefined && !(parsed >= 0 && parsed <= 1);
  const save = useMutation({
    mutationFn: () => {
      if (passed === undefined) throw new Error('Pick Pass or Fail first');
      return api.addLabel(rubric, {
        sessionId: target,
        passed,
        ...(parsed === undefined ? {} : { score: parsed }),
        note: note.trim(),
      });
    },
    onSuccess: async () => {
      // A label moves agreement, so the trusted flag on every grade, session and trend follows.
      await invalidateKeys(qc, GRADE_KEYS);
      onDone();
    },
  });
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface-alt p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (target && passed !== undefined && !scoreBad && !save.isPending) save.mutate();
      }}
    >
      {sessionId ? null : (
        <Field label="Session to label">
          <select
            className={FIELD}
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
            }}
          >
            <option value="">Pick a session…</option>
            {options.map(({ s, judge }) => (
              <option key={s.id} value={s.id}>
                {titleText(s.title)} — judge: {judge ? 'Pass' : 'Fail'}
              </option>
            ))}
          </select>
        </Field>
      )}
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0 text-xs text-muted">
        <legend className="mb-1 p-0">Your verdict</legend>
        <div className="flex gap-4 text-sm text-ink">
          {[true, false].map((v) => (
            <label key={String(v)} className="flex h-10 items-center gap-2">
              <input
                type="radio"
                name={name}
                checked={passed === v}
                onChange={() => {
                  setPassed(v);
                }}
                className="size-4 accent-accent"
              />
              {v ? 'Pass' : 'Fail'}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <Field label="Score (optional, 0 to 1)">
          <input
            type="number"
            min={0}
            max={1}
            step={0.1}
            className={`${FIELD} w-24`}
            value={score}
            onChange={(e) => {
              setScore(e.target.value);
            }}
          />
        </Field>
        <Field label="Note" className="min-w-40 flex-1">
          <input
            type="text"
            className={FIELD}
            placeholder="Why the judge is off"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </Field>
      </div>
      {save.isError ? (
        <p role="alert" className="m-0 text-[13px] text-fail">
          Could not save the label: {save.error.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={!target || passed === undefined || scoreBad || save.isPending}
        >
          Save label
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
