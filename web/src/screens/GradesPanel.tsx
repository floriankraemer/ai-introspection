import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { GradeDetail } from '../api/types.js';
import { LabelForm } from '../components/LabelForm.js';
import { Card, Chip, EmptyState, VerdictChip } from '../components/ui.js';

// Quiet inline action: text only, with padding so the touch target stays tall enough.
const QUIET = 'cursor-pointer border-0 bg-transparent px-0 py-2.5 text-[13px] leading-none';
const TRANSPORT: Record<string, string> = { api: 'API', cli: 'claude CLI' };

function GradeCard({
  g,
  sessionId,
  onShowEvidence,
}: {
  g: GradeDetail;
  sessionId: string;
  onShowEvidence: (rubric: string, ids: string[]) => void;
}) {
  const [labelling, setLabelling] = useState(false);
  const [saved, setSaved] = useState(false);
  const n = g.evidenceEventIds.length;
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-[15px]">{g.rubric}</strong>
        {g.status === 'stale' ? (
          <Chip
            tone="na"
            title="A newer rubric version is being graded; this verdict is from the old one."
          >
            stale — re-grading
          </Chip>
        ) : (
          <VerdictChip passed={g.passed} score={g.score} />
        )}
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span>
          v{g.rubricVersion} · {g.judgeModel} · {TRANSPORT[g.transport] ?? g.transport}
        </span>
        {g.status === 'refused' || g.status === 'invalid' ? (
          <Chip tone="fail">{g.status === 'refused' ? 'judge refused' : 'invalid verdict'}</Chip>
        ) : null}
        {g.answeredModel && g.answeredModel !== g.judgeModel ? (
          <span>answered by {g.answeredModel}</span>
        ) : null}
        {g.trusted ? null : (
          <Chip
            tone="warn"
            title="This rubric has not passed the 8 / 10 calibration gate, so the improver ignores it."
          >
            untrusted
          </Chip>
        )}
      </p>
      {g.reason ? <p className="m-0 text-sm leading-normal">{g.reason}</p> : null}
      {labelling ? (
        <LabelForm
          rubric={g.rubric}
          sessionId={sessionId}
          defaultPassed={g.passed === null ? true : !g.passed}
          onDone={() => {
            setLabelling(false);
            setSaved(true);
          }}
          onCancel={() => {
            setLabelling(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4">
          {n > 0 ? (
            <button
              type="button"
              onClick={() => {
                onShowEvidence(g.rubric, g.evidenceEventIds);
              }}
              className={QUIET}
            >
              <span className="text-accent underline hover:text-accent-hover">
                Show {n} evidence {n === 1 ? 'event' : 'events'}
              </span>
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => {
              setSaved(false);
              setLabelling(true);
            }}
            className={`${QUIET} text-muted hover:text-ink`}
          >
            Judge was wrong…
          </button>
        </div>
      )}
      {saved ? (
        <span role="status" className="text-[13px] text-pass">
          Label saved. It counts toward the{' '}
          <Link to="/rubrics" className="text-pass underline">
            calibration of {g.rubric}
          </Link>
          .
        </span>
      ) : null}
    </Card>
  );
}

export function GradesPanel({
  sessionId,
  grades,
  onShowEvidence,
}: {
  sessionId: string;
  grades: GradeDetail[];
  onShowEvidence: (rubric: string, ids: string[]) => void;
}) {
  const models = [...new Set(grades.map((g) => g.judgeModel))];
  const versions = [...new Set(grades.map((g) => g.rubricVersion))];
  return (
    <aside aria-label="Grades" className="flex min-w-0 flex-[2_1_320px] flex-col gap-3">
      <h2 className="m-0 text-base font-semibold">
        Grades
        {grades.length
          ? ` · judge: ${models.join(', ')}${versions.length === 1 ? ` · rubrics v${String(versions[0])}` : ''}`
          : ''}
      </h2>
      {grades.length === 0 ? (
        <EmptyState title="Not graded yet">
          Grades, the judge's reason and the evidence events appear here once this session is
          graded. Press Re-grade to grade it now.
        </EmptyState>
      ) : (
        grades.map((g) => (
          <GradeCard key={g.rubric} g={g} sessionId={sessionId} onShowEvidence={onShowEvidence} />
        ))
      )}
    </aside>
  );
}
