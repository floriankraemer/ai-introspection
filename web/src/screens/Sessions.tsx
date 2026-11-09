import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useJob, useSessions, useStartImport, useTrendSummary } from '../api/queries.js';
import type { Agent, SessionResultFilter, SessionSummary, TrendSummary } from '../api/types.js';
import {
  Button,
  BTN,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  FIELD,
  Loading,
  PageHeader,
} from '../components/ui.js';
import { AGENT_LABEL, formatPercent, formatWhen } from '../lib/format.js';

function ImportButton() {
  const qc = useQueryClient();
  const start = useStartImport();
  const job = useJob(start.data?.id ?? null);
  const status = job.data?.status;
  useEffect(() => {
    if (status === 'succeeded') void qc.invalidateQueries();
  }, [status, qc]);
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

function SessionRow({ s, rubricCols }: { s: SessionSummary; rubricCols: string[] }) {
  return (
    <tr>
      <td>
        <Link to="/sessions/$sessionId" params={{ sessionId: s.id }} className="font-semibold">
          {s.title}
        </Link>
      </td>
      <td>{AGENT_LABEL[s.agent]}</td>
      <td>{s.repo ?? '—'}</td>
      <td>{formatWhen(s.startedAt)}</td>
      <td className={s.toolErrors >= 5 ? 'font-semibold text-fail' : ''}>{s.toolErrors}</td>
      {s.grades.length === 0 ? (
        <td colSpan={rubricCols.length} className="text-muted">
          Not graded{s.notGradedReason ? ` · ${s.notGradedReason}` : ' yet'}
        </td>
      ) : (
        rubricCols.map((name) => {
          const g = s.grades.find((x) => x.rubric === name);
          return (
            <td key={name}>
              {g?.passed == null ? (
                <Chip tone="na">n/a</Chip>
              ) : (
                <Chip tone={g.passed ? 'pass' : 'fail'}>{g.passed ? 'Pass' : 'Fail'}</Chip>
              )}
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

export function Sessions({
  search,
  onSearch,
}: {
  search: SessionsSearch;
  onSearch: (patch: SessionsSearch | null) => void;
}) {
  const [resetKey, setResetKey] = useState(0);
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
  const noData = s.sessionsCollected === 0 && !filtered;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        subtitle={`Last ${String(s.days)} days · ${String(s.sessionsCollected)} sessions collected · ${String(s.sessionsGraded)} graded`}
        actions={
          <>
            <ImportButton />
            <Button variant="primary" disabled title="Grading arrives with rubrics">
              Grade selected
            </Button>
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
                <table className="w-full border-collapse">
                  <caption className="sr-only">Sessions</caption>
                  <thead>
                    <tr>
                      <th scope="col">Session</th>
                      <th scope="col">Agent</th>
                      <th scope="col">Repo</th>
                      <th scope="col">When</th>
                      <th scope="col" className="whitespace-nowrap">
                        Tool errors
                      </th>
                      {rubricCols.map((n) => (
                        <th key={n} scope="col">
                          {n}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <SessionRow key={row.id} s={row} rubricCols={rubricCols} />
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
