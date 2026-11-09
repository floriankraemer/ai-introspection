import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';
import { useDoctor } from '../api/queries.js';
import type { DoctorCheck } from '../api/types.js';
import { humanizeSources } from '../lib/format.js';
import { Button, Chip, ErrorState, Loading, type ChipTone } from './ui.js';

const STATUS: Record<DoctorCheck['status'], [string, ChipTone]> = {
  ok: ['OK', 'pass'],
  warn: ['Warning', 'na'],
  fail: ['Failing', 'fail'],
};

/** Prose with `code` spans; source names are humanised outside the code spans. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text
        .split('`')
        .map((part, i) =>
          i % 2 === 1 ? (
            <code key={i}>{part}</code>
          ) : (
            <Fragment key={i}>{humanizeSources(part)}</Fragment>
          ),
        )}
    </>
  );
}

function Check({ check }: { check: DoctorCheck }) {
  const [label, tone] = STATUS[check.status];
  // One aligned grid for every status. Healthy rows put the detail inline after the label so the
  // few that need attention (detail and fix stacked under the label) stand out.
  const ok = check.status === 'ok';
  return (
    <li className="grid min-w-0 grid-cols-[4.25rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5 border-t border-line py-2 first:border-t-0">
      <Chip tone={tone} className="justify-self-start">
        {label}
      </Chip>
      <p className="m-0 text-sm break-words">
        <span className="font-semibold">
          <Rich text={check.label} />
        </span>
        {ok ? (
          <span className="text-muted">
            {' · '}
            <Rich text={check.detail} />
          </span>
        ) : null}
      </p>
      {ok ? null : (
        <p className="m-0 col-start-2 text-sm break-words text-muted">
          <Rich text={check.detail} />
        </p>
      )}
      {check.fix ? (
        <p className="m-0 col-start-2 text-sm break-words text-ink-soft">
          Fix: <Rich text={check.fix} />
        </p>
      ) : null}
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
