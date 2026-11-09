import { Link } from '@tanstack/react-router';
import { Fragment, useState, type ReactNode } from 'react';
import { useSession, useSessionEvents } from '../api/queries.js';
import type { EventFilter, TraceEvent } from '../api/types.js';
import { BTN, Button, Chip, EmptyState, ErrorState, Loading } from '../components/ui.js';
import {
  AGENT_LABEL,
  collapseRuns,
  eventLabel,
  formatDuration,
  formatOffset,
  formatTokens,
  outcomeLabel,
} from '../lib/format.js';
import { ApiError } from '../api/client.js';

/** Renders `code` spans: the API marks code in the one-line summary with backticks. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split('`')
        .map((part, i) =>
          i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>,
        )}
    </>
  );
}

function Payload({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-muted">{label}</div>
      <pre className="m-0 max-h-72 overflow-auto rounded-lg border border-line-soft bg-sunken p-3 font-mono text-[13px] whitespace-pre-wrap text-ink">
        {value}
      </pre>
    </div>
  );
}

function EventRow({ e }: { e: TraceEvent }) {
  const hasPayload = e.input !== null || e.output !== null || e.payloadPurged;
  return (
    <li
      className={`grid grid-cols-[56px_92px_minmax(0,1fr)] gap-3 border-l-[3px] px-[13px] py-2.5 text-sm ${e.isError ? 'border-fail bg-fail-bg' : 'border-transparent'}`}
    >
      <span className="text-muted">{formatOffset(e.offsetS)}</span>
      <Chip tone={e.isError ? 'fail' : 'na'} className="self-start justify-self-start">
        {eventLabel(e)}
      </Chip>
      <div className="min-w-0 break-words">
        <Inline text={e.text} />
        {hasPayload ? (
          <details className="mt-1 text-[13px]">
            <summary className="w-fit cursor-pointer text-accent">Payload</summary>
            {e.payloadPurged ? (
              <p className="m-0 mt-2 text-muted">Payload removed by the retention purge.</p>
            ) : (
              <>
                {e.input !== null ? <Payload label="Input" value={e.input} /> : null}
                {e.output !== null ? <Payload label="Output" value={e.output} /> : null}
                {e.truncated ? (
                  <p className="m-0 mt-2 text-muted">Cut at the 64 KiB cap at ingest.</p>
                ) : null}
              </>
            )}
          </details>
        ) : null}
      </div>
    </li>
  );
}

function Trace({
  id,
  eventCount,
  errorCount,
}: {
  id: string;
  eventCount: number;
  errorCount: number;
}) {
  const [filter, setFilter] = useState<EventFilter>('all');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const events = useSessionEvents(id, filter);
  const rows = collapseRuns(events.data?.pages.flatMap((p) => p.items) ?? []);
  const tab = (f: EventFilter, label: string, disabled = false) => (
    <button
      type="button"
      aria-pressed={filter === f}
      disabled={disabled}
      title={disabled ? 'Available once the session is graded' : undefined}
      onClick={() => {
        setFilter(f);
      }}
      className={`h-8 rounded-full border px-3 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-60 ${filter === f ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-sunken'}`}
    >
      {label}
    </button>
  );
  return (
    <section
      aria-label="Trace"
      className="flex min-w-0 flex-[3_1_480px] flex-col rounded-xl border border-line bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3.5">
        <h2 className="m-0 text-base font-semibold">Trace · {eventCount} events</h2>
        <div className="flex flex-wrap gap-1.5">
          {tab('all', 'All')}
          {tab('errors', `Errors (${String(errorCount)})`)}
          {tab('evidence', 'Evidence only', true)}
        </div>
      </div>
      {events.isPending ? (
        <div className="px-4">
          <Loading label="Loading trace" />
        </div>
      ) : events.isError ? (
        <div className="p-4">
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <p className="m-0 p-4 text-sm text-muted">No events in this view.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col py-2 pl-0">
          {rows.map((r): ReactNode => {
            if (r.type === 'event') return <EventRow key={r.event.id} e={r.event} />;
            if (open.has(r.key)) return r.events.map((e) => <EventRow key={e.id} e={e} />);
            return (
              <li
                key={r.key}
                className="grid grid-cols-[56px_92px_minmax(0,1fr)] gap-3 border-l-[3px] border-transparent px-[13px] py-2.5 text-sm text-muted"
              >
                <span>{formatOffset(r.offsetS)}</span>
                <span />
                <button
                  type="button"
                  aria-expanded={false}
                  onClick={() => {
                    setOpen(new Set(open).add(r.key));
                  }}
                  className="w-fit text-left text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  … {r.events.length} more failed {r.name ?? 'tool'} calls (collapsed)
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {events.hasNextPage ? (
        <div className="flex justify-center border-t border-line-soft p-3">
          <Button disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            {events.isFetchingNextPage ? 'Loading…' : 'Load more events'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const q = useSession(id);
  if (q.isPending) return <Loading label="Loading session" />;
  if (q.isError) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return gone ? (
      <EmptyState
        title="Session not found"
        actions={
          <Link to="/" className={BTN.secondary}>
            Back to Sessions
          </Link>
        }
      >
        This session is not in the database. It may have been removed, or the link is wrong.
      </EmptyState>
    ) : (
      <ErrorState error={q.error} onRetry={() => void q.refetch()} />
    );
  }
  const s = q.data;
  const outcome = outcomeLabel(s.outcome);
  const meta = [
    AGENT_LABEL[s.agent],
    s.repo,
    s.branch,
    formatDuration(s.durationS),
    `${formatTokens(s.tokensIn + s.tokensOut)} tokens`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-5">
      <Link to="/" className="w-fit text-[13px]">
        ← Sessions
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[26px] leading-tight font-bold">{s.title}</h1>
          <p className="m-0 text-sm text-muted">
            {meta.join(' · ')}
            {outcome ? (
              <>
                {' · '}
                {s.outcome.url ? <a href={s.outcome.url}>{outcome}</a> : outcome}
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/v1/sessions/${encodeURIComponent(s.id)}/raw`}
            target="_blank"
            rel="noreferrer"
            className={BTN.secondary}
          >
            Open raw JSONL
          </a>
          <Button disabled title="Grading arrives with rubrics">
            Re-grade
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-5">
        <Trace id={s.id} eventCount={s.eventCount} errorCount={s.errorCount} />
        <aside aria-label="Grades" className="flex min-w-0 flex-[2_1_320px] flex-col gap-3">
          <h2 className="m-0 text-base font-semibold">Grades</h2>
          <EmptyState title="Not graded yet">
            Grades, the judge's reason and the evidence events appear here once rubrics exist and
            this session is graded. Add rubrics to your skills repo in Settings to get started.
          </EmptyState>
        </aside>
      </div>
    </div>
  );
}
