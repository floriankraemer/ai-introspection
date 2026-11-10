import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  useGradeJob,
  useReferenceSet,
  useReferenceToggle,
  useSession,
  useSessionEvents,
} from '../api/queries.js';
import type { EventFilter, TraceEvent } from '../api/types.js';
import { JobNote } from '../components/JobNote.js';
import { BTN, Button, Chip, EmptyState, ErrorState, Loading } from '../components/ui.js';
import { rubricLabel } from '../lib/trends.js';
import {
  AGENT_LABEL,
  collapseRuns,
  eventLabel,
  formatDuration,
  formatOffset,
  formatTokenSplit,
  outcomeLabel,
  plural,
  titleText,
} from '../lib/format.js';
import { ApiError } from '../api/client.js';
import { LOCAL_USER_ID } from '../lib/format.js';
import { GradesPanel } from './GradesPanel.js';

/** Renders `code` spans: the API marks code in the one-line summary with backticks. */
/** An outcome link opens only when it is http(s); `javascript:` and `data:` URLs stay plain text. */
function safeHref(url: string | null): string | undefined {
  if (url === null) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

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

function EventRow({ e, evidence }: { e: TraceEvent; evidence: boolean }) {
  // Long summaries are clamped in the row; the disclosure carries the full text.
  const long = e.text.length > 100;
  const hasPayload = e.input !== null || e.output !== null || e.payloadPurged;
  return (
    <li
      data-evidence={evidence ? 'true' : undefined}
      className={`grid grid-cols-[56px_92px_minmax(0,1fr)] gap-3 border-l-[3px] px-[13px] py-2.5 text-sm ${evidence ? 'border-accent bg-accent-soft' : e.isError ? 'border-fail bg-fail-bg' : 'border-transparent'}`}
    >
      <span className="text-muted">{formatOffset(e.offsetS)}</span>
      <Chip tone={e.isError ? 'fail' : 'na'} className="self-start justify-self-start">
        {eventLabel(e)}
      </Chip>
      <div className="min-w-0 break-words">
        <div className="line-clamp-2">
          {evidence ? <span className="sr-only">Evidence: </span> : null}
          <Inline text={e.text} />
        </div>
        {hasPayload || long ? (
          <details className="mt-1 text-[13px]">
            <summary className="w-fit cursor-pointer text-accent">Payload</summary>
            {long ? <Payload label="Summary" value={e.text.replaceAll('`', '')} /> : null}
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

/** Evidence events of the grade the user asked to see; `ids` are highlighted and scrolled to. */
export interface EvidenceFocus {
  rubric: string;
  ids: string[];
}

function Trace({
  id,
  eventCount,
  errorCount,
  hasGrades,
  filter,
  onFilter,
  focus,
  onClearFocus,
}: {
  id: string;
  eventCount: number;
  errorCount: number;
  hasGrades: boolean;
  filter: EventFilter;
  onFilter: (f: EventFilter) => void;
  focus: EvidenceFocus | null;
  onClearFocus: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const events = useSessionEvents(id, filter);
  const rows = collapseRuns(events.data?.pages.flatMap((p) => p.items) ?? []);
  const section = useRef<HTMLElement>(null);
  const scrolled = useRef<EvidenceFocus | null>(null);
  const focused = new Set(focus?.ids);

  // Bring the focused evidence into view once; open a collapsed run that hides some of it first.
  useEffect(() => {
    if (!focus || filter !== 'evidence' || events.isPending || scrolled.current === focus) return;
    const hidden = rows.filter(
      (r) =>
        r.type === 'collapsed' &&
        !open.has(r.key) &&
        r.events.some((e) => focus.ids.includes(e.id)),
    );
    if (hidden.length) {
      setOpen((o) => new Set([...o, ...hidden.map((r) => (r.type === 'collapsed' ? r.key : ''))]));
      return;
    }
    scrolled.current = focus;
    section.current?.querySelector('[data-evidence]')?.scrollIntoView({ block: 'center' });
  });
  const tab = (f: EventFilter, label: string, disabled = false) => (
    <button
      type="button"
      aria-pressed={filter === f}
      disabled={disabled}
      title={disabled ? 'Available once the session is graded' : undefined}
      onClick={() => {
        onFilter(f);
      }}
      className={`h-8 rounded-full border px-3 text-[13px] text-ink disabled:cursor-not-allowed disabled:border-line-soft disabled:bg-disabled disabled:text-disabled-ink ${filter === f ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-sunken'}`}
    >
      {label}
    </button>
  );
  return (
    <section
      ref={section}
      aria-label="Trace"
      className="flex min-w-0 flex-[3_1_480px] flex-col rounded-xl border border-line bg-surface"
    >
      <div className="flex min-h-[61px] flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3.5">
        <h2 className="m-0 text-base font-semibold">Trace · {plural(eventCount, 'event')}</h2>
        <div className="flex flex-wrap gap-1.5">
          {tab('all', 'All')}
          {tab('errors', `Errors (${String(errorCount)})`)}
          {tab('evidence', 'Evidence only', !hasGrades)}
        </div>
      </div>
      {focus ? (
        <p className="m-0 flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2 text-[13px] text-muted">
          Highlighted: evidence for {rubricLabel(focus.rubric)}
          <button
            type="button"
            onClick={onClearFocus}
            className="cursor-pointer border-0 bg-transparent p-0 text-[13px] text-accent underline"
          >
            Clear
          </button>
        </p>
      ) : null}
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
            if (r.type === 'event')
              return <EventRow key={r.event.id} e={r.event} evidence={focused.has(r.event.id)} />;
            if (open.has(r.key))
              return r.events.map((e) => (
                <EventRow key={e.id} e={e} evidence={focused.has(e.id)} />
              ));
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
                  … {r.events.length} more failed {r.name ?? 'tool'}{' '}
                  {r.events.length === 1 ? 'call' : 'calls'} (collapsed)
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

/** Pins the session into the fixed set Trends re-grades after every change. */
function ReferenceButton({ id }: { id: string }) {
  const ref = useReferenceSet();
  const toggle = useReferenceToggle(id);
  const isMember = ref.data?.items.some((m) => m.id === id) ?? false;
  return (
    <>
      <Button
        disabled={!ref.data || toggle.isPending}
        onClick={() => {
          toggle.mutate(!isMember);
        }}
      >
        {isMember ? 'Remove from reference set' : 'Add to reference set'}
      </Button>
      {toggle.isError ? (
        <p role="alert" className="m-0 basis-full text-right text-[13px] text-fail">
          {toggle.error instanceof ApiError && toggle.error.status === 409
            ? `${toggle.error.message} Remove a session on Trends or here first.`
            : `Could not update the reference set: ${toggle.error.message}`}
        </p>
      ) : null}
    </>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const q = useSession(id);
  const [filter, setFilter] = useState<EventFilter>('all');
  const [focus, setFocus] = useState<EvidenceFocus | null>(null);
  const regrade = useGradeJob((api) => api.regradeSession(id));
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
    s.person.id === LOCAL_USER_ID ? null : `Pushed by ${s.person.name}`,
    formatDuration(s.durationS),
    formatTokenSplit(s),
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-5">
      <Link to="/" className="w-fit text-[13px]">
        ← Sessions
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[26px] leading-tight font-bold break-words">
            {titleText(s.title)}
          </h1>
          <p className="m-0 text-sm text-muted">
            {meta.join(' · ')}
            {outcome ? (
              <>
                {' · '}
                {safeHref(s.outcome.url) ? (
                  <a href={safeHref(s.outcome.url)} rel="noopener noreferrer">
                    {outcome}
                  </a>
                ) : (
                  outcome
                )}
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
          <Button
            disabled={regrade.run.isPending}
            onClick={() => {
              regrade.run.mutate([id]);
            }}
          >
            Re-grade
          </Button>
          <ReferenceButton id={id} />
          <JobNote
            job={regrade.job}
            failed={regrade.run.isError}
            className="basis-full text-right"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-5">
        <Trace
          id={s.id}
          eventCount={s.eventCount}
          errorCount={s.errorCount}
          hasGrades={s.grades.length > 0}
          filter={filter}
          onFilter={setFilter}
          focus={focus}
          onClearFocus={() => {
            setFocus(null);
          }}
        />
        <GradesPanel
          sessionId={s.id}
          grades={s.grades}
          onShowEvidence={(rubric, ids) => {
            setFilter('evidence');
            setFocus({ rubric, ids });
          }}
        />
      </div>
    </div>
  );
}
