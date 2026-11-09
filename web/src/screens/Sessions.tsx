import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useGradeJob, useImport, useSessions, useTrendSummary } from '../api/queries.js';
import type { Agent, SessionResultFilter, SessionSummary, TrendSummary } from '../api/types.js';
import {
  Button,
  BTN,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FIELD,
  Loading,
  PageHeader,
  VerdictChip,
} from '../components/ui.js';
import { JobNote } from '../components/JobNote.js';
import { AGENT_LABEL, formatPercent, formatWhen, titleText } from '../lib/format.js';

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
            <span className="text-[13px] text-muted">{r.name} · pass rate</span>
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
  'Redundant tests': 'Tests',
  'Silent workaround': 'Workaround',
};

function SessionRow({
  s,
  rubricCols,
  checked,
  onToggle,
}: {
  s: SessionSummary;
  rubricCols: string[];
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
              <VerdictChip passed={g?.passed ?? null} />
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
  result?: SessionResultFilter | undefined;
}

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
  const summary = useTrendSummary(7);
  // Until something is graded, "Failed any rubric" would always be empty, so default to All.
  const defaultResult: SessionResultFilter =
    (summary.data?.sessionsGraded ?? 0) > 0 ? 'failed_any' : 'all';
  const result = search.result ?? defaultResult;
  const sessions = useSessions({ q: search.q, agent: search.agent, result });

  if (summary.isPending) return <Loading label="Loading sessions" />;
  if (summary.isError)
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;

  const s = summary.data;
  const filtered = Boolean(search.q ?? search.agent ?? search.result);
  const items = sessions.data?.pages.flatMap((p) => p.items) ?? [];
  const names = s.rubrics.map((r) => r.name);
  const rubricCols = names.length ? names : ['Rubrics'];
  const allSelected = items.length > 0 && items.every((r) => selected.has(r.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };
  const noData = s.sessionsCollected === 0 && !filtered;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        subtitle={`Last ${String(s.days)} days · ${String(s.sessionsCollected)} sessions collected · ${String(s.sessionsGraded)} graded`}
        actions={
          <>
            <ImportButton />
            <Button
              variant="primary"
              disabled={selected.size === 0 || grade.run.isPending}
              title={selected.size === 0 ? 'Select sessions in the table first' : undefined}
              onClick={() => {
                grade.run.mutate([...selected]);
                setSelected(new Set());
              }}
            >
              Grade selected{selected.size ? ` (${String(selected.size)})` : ''}
            </Button>
            <JobNote job={grade.job} failed={grade.run.isError} className="basis-full text-right" />
          </>
        }
      />
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
              Widen the search, or switch Result to All.
            </EmptyState>
          ) : (
            <>
              <Card className="overflow-x-auto">
                <table
                  className={`w-full table-fixed border-collapse ${names.length ? 'min-w-[58.5rem]' : 'min-w-[42.5rem]'}`}
                >
                  <caption className="sr-only">Sessions</caption>
                  <colgroup>
                    <col className="w-10" />
                    <col />
                    <col className="w-[6.5rem]" />
                    <col className="w-28" />
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
                      <th scope="col">Agent</th>
                      <th scope="col">Repo</th>
                      <th scope="col">When</th>
                      <th scope="col" className="whitespace-nowrap">
                        Tool errors
                      </th>
                      {rubricCols.map((n) => (
                        <th key={n} scope="col" title={n} className="whitespace-nowrap">
                          {RUBRIC_SHORT[n] ?? n}
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
