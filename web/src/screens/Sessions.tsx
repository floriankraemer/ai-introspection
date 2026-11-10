import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useBudget,
  useGradeJob,
  useImport,
  usePeople,
  useSessions,
  useTrendSummary,
} from '../api/queries.js';
import type { Agent, SessionResultFilter, SessionSummary, TrendSummary } from '../api/types.js';
import {
  Button,
  BTN,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FIELD,
  LinkButton,
  Loading,
  PageHeader,
  VerdictChip,
} from '../components/ui.js';
import { JobNote } from '../components/JobNote.js';
import { BudgetBanner } from '../components/BudgetBanner.js';
import { estimateGrading } from '../lib/budget.js';
import { formatTokens } from '../lib/format.js';
import { rubricLabel } from '../lib/trends.js';
import { AGENT_LABEL, formatPercent, plural, formatWhen, titleText } from '../lib/format.js';

function ImportButton() {
  const { start, job } = useImport();
  const status = job.data?.status;
  const running = start.isPending || status === 'queued' || status === 'running';
  const p = job.data?.progress;
  return (
    <>
      <Button
        onClick={() => {
          start.mutate();
        }}
        disabled={running}
      >
        Import history
      </Button>
      <p role="status" className="m-0 basis-full text-right text-xs text-muted empty:hidden">
        {start.isError
          ? 'Import could not start. Check that the source folders are mounted.'
          : running
            ? `Importing…${p ? ` ${String(p.done)} / ${String(p.total)}` : ''}`
            : status === 'succeeded'
              ? 'Import finished.'
              : status === 'failed' || status === 'dead'
                ? `Import failed: ${job.data?.error ?? 'unknown error'}`
                : ''}
      </p>
    </>
  );
}

function PassRateCards({ summary }: { summary: TrendSummary }) {
  if (summary.rubrics.length === 0)
    return (
      <Card className="flex flex-col gap-1.5 p-4">
        <span className="text-[13px] text-muted">Pass rate per rubric</span>
        <span className="text-[26px] leading-tight font-bold">Not graded yet</span>
        <span className="text-xs text-muted">
          Grades appear once rubrics exist in your skills repo and sessions are graded.
        </span>
      </Card>
    );
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
      {summary.rubrics.map((r) => {
        const below = r.passRate !== null && r.passRate < r.target;
        return (
          <Card key={r.name} className="flex flex-col gap-1.5 p-4">
            <span className="text-[13px] text-muted">{rubricLabel(r.name)} · pass rate</span>
            <span className="text-[26px] leading-tight font-bold">
              {r.passRate === null ? '—' : formatPercent(r.passRate)}
            </span>
            <span className={`text-xs ${below ? 'text-fail' : 'text-muted'}`}>
              {r.passRate === null
                ? 'not graded yet'
                : below
                  ? `below ${formatPercent(r.target)} target`
                  : 'on target'}
            </span>
          </Card>
        );
      })}
    </div>
  );
}

/** Column headers from the Sessions mockup; the full name stays in the tooltip. */
const RUBRIC_SHORT: Record<string, string> = {
  'redundant-tests': 'Tests',
  'silent-workaround': 'Workaround',
};

function SessionRow({
  s,
  rubricCols,
  showPerson,
  checked,
  onToggle,
}: {
  s: SessionSummary;
  rubricCols: string[];
  showPerson: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className={checked ? 'bg-accent-soft' : ''}>
      <td className="pr-0">
        <input
          type="checkbox"
          aria-label={`Select ${titleText(s.title)}`}
          checked={checked}
          onChange={onToggle}
          className="size-4 align-middle accent-accent"
        />
      </td>
      <td>
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: s.id }}
          title={titleText(s.title)}
          className="block truncate font-semibold"
        >
          {titleText(s.title)}
        </Link>
      </td>
      {showPerson ? (
        <td>
          <span className="block truncate" title={s.person.name}>
            {s.person.name}
          </span>
        </td>
      ) : null}
      <td>{AGENT_LABEL[s.agent]}</td>
      <td>
        <span className="block truncate" title={s.repo ?? undefined}>
          {s.repo ?? '—'}
        </span>
      </td>
      <td>{formatWhen(s.startedAt)}</td>
      <td className={s.toolErrors >= 5 ? 'font-semibold text-fail' : ''}>{s.toolErrors}</td>
      {s.grades.length === 0 ? (
        <td
          colSpan={rubricCols.length}
          className="text-muted"
          title={`Not graded${s.notGradedReason ? ` · ${s.notGradedReason}` : ' yet'}`}
        >
          Not graded
        </td>
      ) : (
        rubricCols.map((name) => {
          const g = s.grades.find((x) => x.rubric === name);
          return (
            <td key={name}>
              <span
                title={`${rubricLabel(name)}: ${g?.passed == null ? 'n/a' : g.passed ? 'Pass' : 'Fail'}`}
              >
                <VerdictChip passed={g?.passed ?? null} />
              </span>
            </td>
          );
        })
      )}
    </tr>
  );
}

export interface SessionsSearch {
  q?: string | undefined;
  agent?: Agent | undefined;
  person?: string | undefined;
  result?: SessionResultFilter | undefined;
  range?: SessionRange | undefined;
}

export type SessionRange = '7' | '30' | 'all';
export const SESSION_RANGES: SessionRange[] = ['7', '30', 'all'];
const RANGE_LABEL: Record<SessionRange, string> = {
  '7': '7 days',
  '30': '30 days',
  all: 'All time',
};
const RESULT_HINT: Record<SessionResultFilter, string> = {
  failed_any: 'sessions that failed any rubric',
  not_graded: 'sessions that are not graded',
  all: 'all sessions',
};
const DAY_MS = 86_400_000;
/** `days` for the summary API; 0 means all time. */
const RANGE_DAYS: Record<SessionRange, number> = { '7': 7, '30': 30, all: 0 };

/** Header checkbox: selects or clears every loaded row; shows a dash for a partial selection. */
function SelectAll({ all, some, onChange }: { all: boolean; some: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some && !all;
  }, [some, all]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all loaded sessions"
      checked={all}
      onChange={onChange}
      className="size-4 align-middle accent-accent"
    />
  );
}

export function Sessions({
  search,
  onSearch,
}: {
  search: SessionsSearch;
  onSearch: (patch: SessionsSearch | null) => void;
}) {
  const [resetKey, setResetKey] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const grade = useGradeJob((api, ids) => api.gradeBatch(ids));
  const budget = useBudget();
  const [confirming, setConfirming] = useState(false);
  const range = search.range ?? '7';
  const summary = useTrendSummary(RANGE_DAYS[range]);
  // Until something is graded, "Failed any rubric" would always be empty, so default to All.
  const defaultResult: SessionResultFilter =
    (summary.data?.sessionsGraded ?? 0) > 0 ? 'failed_any' : 'all';
  const result = search.result ?? defaultResult;
  // Fixed per period, so the query key does not change on every render.
  const since = useMemo(
    () =>
      range === 'all' ? undefined : new Date(Date.now() - RANGE_DAYS[range] * DAY_MS).toISOString(),
    [range],
  );
  const people = usePeople();
  const sessions = useSessions({
    q: search.q,
    agent: search.agent,
    person: search.person,
    result,
    since,
  });

  if (summary.isPending) return <Loading label="Loading sessions" />;
  if (summary.isError)
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;

  if (summary.data.sessionsCollected === 0 && sessions.isPending)
    return <Loading label="Loading sessions" />;

  const s = summary.data;
  const filtered = Boolean(
    search.q ?? search.agent ?? search.person ?? search.result ?? search.range,
  );
  // Only worth a column and a filter once sessions of more than one person exist.
  const showPerson = (people.data?.length ?? 0) > 1;
  const items = sessions.data?.pages.flatMap((p) => p.items) ?? [];
  const names = s.rubrics.map((r) => r.name);
  const rubricCols = names.length ? names : ['Rubrics'];
  const allSelected = items.length > 0 && items.every((r) => selected.has(r.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };
  const estimate = budget.data
    ? estimateGrading(budget.data, selected.size, s.rubrics.length)
    : null;
  const startGrading = (ids: string[]) => {
    grade.run.mutate(ids);
    setSelected(new Set());
    setConfirming(false);
  };
  // Nothing in the chosen period is not the same as nothing collected: older sessions may exist.
  const noData = s.sessionsCollected === 0 && !filtered && items.length === 0;
  // A short list under a narrowing filter: say what it hides, so the empty space is not a mystery.
  const narrowed = result !== 'all' || range !== 'all';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        subtitle={`${range === 'all' ? 'All time' : `Last ${plural(RANGE_DAYS[range], 'day')}`} · ${plural(s.sessionsCollected, 'session')} collected · ${String(s.sessionsGraded)} graded`}
        actions={
          <>
            <ImportButton />
            <Button
              variant="primary"
              disabled={selected.size === 0 || grade.run.isPending}
              title={selected.size === 0 ? 'Select sessions in the table first' : undefined}
              onClick={() => {
                if (estimate?.over) setConfirming(true);
                else startGrading([...selected]);
              }}
            >
              Grade selected{selected.size ? ` (${String(selected.size)})` : ''}
            </Button>
            <JobNote job={grade.job} failed={grade.run.isError} className="basis-full text-right" />
          </>
        }
      />
      <BudgetBanner />
      {confirming && estimate?.over ? (
        <div
          role="alertdialog"
          aria-label="Confirm grading"
          className="flex flex-col gap-3 rounded-lg border border-warn-line bg-warn-bg px-3 py-2.5 text-warn"
        >
          <p className="m-0 leading-normal">
            Grading {plural(selected.size, 'session')} × {plural(s.rubrics.length, 'rubric')} uses
            about {formatTokens(estimate.needed)} tokens; {formatTokens(estimate.left ?? 0)} left
            today. About {plural(estimate.fits, 'session')} fit.
          </p>
          <div className="flex flex-wrap gap-2">
            {estimate.fits > 0 ? (
              <Button
                variant="primary"
                onClick={() => {
                  startGrading([...selected].slice(0, estimate.fits));
                }}
              >
                Grade {estimate.fits} that fit
              </Button>
            ) : null}
            <Button
              onClick={() => {
                startGrading([...selected]);
              }}
            >
              Grade all anyway (rest waits for tomorrow)
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {noData ? (
        <EmptyState
          title="No sessions collected yet"
          actions={
            <>
              <Link to="/settings" className={BTN.secondary}>
                Check source folders
              </Link>
            </>
          }
        >
          Introspect reads the session logs your coding agents write. Run a Claude Code or Codex
          session and it shows up here, or press Import history to load the sessions already on
          disk.
        </EmptyState>
      ) : (
        <>
          <PassRateCards summary={s} />
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Search" className="flex-[1_1_260px]">
              <input
                type="search"
                className={FIELD}
                placeholder="Prompt, repo, branch…"
                key={resetKey}
                defaultValue={search.q ?? ''}
                onChange={(e) => {
                  onSearch({ q: e.target.value || undefined });
                }}
              />
            </Field>
            <Field label="Agent">
              <select
                className={FIELD}
                value={search.agent ?? ''}
                onChange={(e) => {
                  onSearch({ agent: (e.target.value || undefined) as Agent | undefined });
                }}
              >
                <option value="">All agents</option>
                <option value="claude_code">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </Field>
            {showPerson ? (
              <Field label="Person">
                <select
                  className={FIELD}
                  value={search.person ?? ''}
                  onChange={(e) => {
                    onSearch({ person: e.target.value || undefined });
                  }}
                >
                  <option value="">Everyone</option>
                  {people.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Period">
              <select
                className={FIELD}
                value={range}
                onChange={(e) => {
                  onSearch({ range: e.target.value as SessionRange });
                }}
              >
                {SESSION_RANGES.map((r) => (
                  <option key={r} value={r}>
                    {RANGE_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Result">
              <select
                className={FIELD}
                value={result}
                onChange={(e) => {
                  onSearch({ result: e.target.value as SessionResultFilter });
                }}
              >
                <option value="failed_any">Failed any rubric</option>
                <option value="all">All</option>
                <option value="not_graded">Not graded</option>
              </select>
            </Field>
          </div>
          {sessions.isError ? (
            <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
          ) : sessions.isPending ? (
            <Loading label="Loading sessions" />
          ) : items.length === 0 ? (
            <EmptyState
              title="No sessions match these filters"
              actions={
                <Button
                  onClick={() => {
                    setResetKey((k) => k + 1);
                    onSearch(null);
                  }}
                >
                  Clear filters
                </Button>
              }
            >
              Widen the search, the period, or switch Result to All.
            </EmptyState>
          ) : (
            <>
              {narrowed && items.length < 10 && !sessions.hasNextPage ? (
                <p className="m-0 text-[13px] text-muted">
                  Showing {RESULT_HINT[result]}
                  {range === 'all' ? '' : ` in the last ${plural(RANGE_DAYS[range], 'day')}`} ·{' '}
                  <LinkButton
                    onClick={() => {
                      onSearch({ result: 'all', range: 'all' });
                    }}
                  >
                    Show all
                  </LinkButton>
                </p>
              ) : null}
              <Card className="overflow-x-auto">
                <table
                  className={`w-full table-fixed border-collapse ${names.length ? (showPerson ? 'min-w-[62.25rem]' : 'min-w-[58.5rem]') : showPerson ? 'min-w-[46.5rem]' : 'min-w-[42.5rem]'}`}
                >
                  <caption className="sr-only">Sessions</caption>
                  <colgroup>
                    <col className="w-10" />
                    <col />
                    {/* Person and a narrower Repo still fit a 1280px window without scrolling. */}
                    {showPerson ? <col className="w-20" /> : null}
                    <col className="w-[6.5rem]" />
                    <col className={showPerson ? 'w-24' : 'w-28'} />
                    <col className="w-[5.75rem]" />
                    <col className="w-[5.75rem]" />
                    {rubricCols.map((n) => (
                      <col key={n} className={names.length ? 'w-[5.5rem]' : 'w-28'} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col" className="pr-0">
                        <SelectAll
                          all={allSelected}
                          some={selected.size > 0}
                          onChange={() => {
                            setSelected(allSelected ? new Set() : new Set(items.map((r) => r.id)));
                          }}
                        />
                      </th>
                      <th scope="col">Session</th>
                      {showPerson ? <th scope="col">Person</th> : null}
                      <th scope="col">Agent</th>
                      <th scope="col">Repo</th>
                      <th scope="col">When</th>
                      <th scope="col" className="whitespace-nowrap">
                        Tool errors
                      </th>
                      {rubricCols.map((n) => (
                        <th key={n} scope="col" title={rubricLabel(n)} className="truncate">
                          {RUBRIC_SHORT[n] ?? rubricLabel(n)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <SessionRow
                        key={row.id}
                        s={row}
                        rubricCols={rubricCols}
                        showPerson={showPerson}
                        checked={selected.has(row.id)}
                        onToggle={() => {
                          toggle(row.id);
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </Card>
              {sessions.hasNextPage ? (
                <Button
                  className="self-center"
                  disabled={sessions.isFetchingNextPage}
                  onClick={() => void sessions.fetchNextPage()}
                >
                  {sessions.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
