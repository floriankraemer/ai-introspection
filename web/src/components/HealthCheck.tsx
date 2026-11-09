import { Link } from '@tanstack/react-router';
import { useDoctor } from '../api/queries.js';
import type { DoctorCheck } from '../api/types.js';
import { Button, Chip, ErrorState, Loading, type ChipTone } from './ui.js';

const STATUS: Record<DoctorCheck['status'], [string, ChipTone]> = {
  ok: ['OK', 'pass'],
  warn: ['Warning', 'na'],
  fail: ['Failing', 'fail'],
};

function Check({ check }: { check: DoctorCheck }) {
  const [label, tone] = STATUS[check.status];
  // Healthy checks stay on one line so the few that need attention stand out.
  const ok = check.status === 'ok';
  return (
    <li
      className={`flex min-w-0 border-t border-line first:border-t-0 ${ok ? 'flex-wrap items-center gap-x-2 py-1.5' : 'flex-col gap-1 py-2.5'}`}
    >
      <div className="flex items-center gap-2">
        <Chip tone={tone}>{label}</Chip>
        <span className="min-w-0 text-sm font-semibold break-words">{check.label}</span>
      </div>
      <p className={`m-0 text-sm break-words ${ok ? 'text-muted' : 'text-ink-soft'}`}>
        {check.detail}
      </p>
      {check.fix ? <p className="m-0 text-sm break-words text-muted">Fix: {check.fix}</p> : null}
    </li>
  );
}

/** Settings panel: every check, with a way to run them again after fixing something. */
export function HealthCheck() {
  const q = useDoctor();
  const bad = q.data?.checks.filter((c) => c.status !== 'ok').length ?? 0;
  return (
    <section
      aria-labelledby="health-h"
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-[18px]"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="health-h" className="m-0 text-base font-semibold">
          Health check
          {q.data ? (
            <span className="ml-2 text-sm font-normal text-muted">
              {bad === 0 ? 'Everything works.' : `${String(bad)} need attention`}
            </span>
          ) : null}
        </h2>
        <Button className="h-10 shrink-0" disabled={q.isFetching} onClick={() => void q.refetch()}>
          {q.isFetching ? 'Checking…' : 'Run again'}
        </Button>
      </div>
      {q.isPending ? (
        <Loading label="Running checks" />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {q.data.checks.map((c) => (
            <Check key={c.id} check={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Wizard Done step: failures in full, warnings as one line pointing to Settings; healthy stays quiet. */
export function FailingChecks() {
  const q = useDoctor();
  const failing = q.data?.checks.filter((c) => c.status === 'fail') ?? [];
  const warnings = q.data?.checks.filter((c) => c.status === 'warn').length ?? 0;
  return (
    <>
      {failing.length > 0 ? (
        <div
          role="alert"
          className="flex flex-col rounded-xl border border-fail-line bg-fail-bg px-4 py-2"
        >
          <ul className="m-0 flex list-none flex-col p-0">
            {failing.map((c) => (
              <Check key={c.id} check={c} />
            ))}
          </ul>
          <Button
            className="my-2 h-10 self-start"
            disabled={q.isFetching}
            onClick={() => void q.refetch()}
          >
            Run again
          </Button>
        </div>
      ) : null}
      {warnings > 0 ? (
        <p className="m-0 text-sm text-muted">
          {warnings === 1 ? '1 optional item needs' : `${String(warnings)} optional items need`}{' '}
          attention. See the Health check in <Link to="/settings">Settings</Link>.
        </p>
      ) : null}
    </>
  );
}
