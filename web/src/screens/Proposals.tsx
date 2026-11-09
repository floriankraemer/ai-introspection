import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { ApiError } from '../api/client.js';
import {
  useImproverRun,
  useImproverRuns,
  useProposal,
  useProposalAction,
  useProposals,
  useProposalTab,
  useRubrics,
  useSession,
} from '../api/queries.js';
import type { ImproverRun, Proposal, ProposalStatus } from '../api/types.js';
import { NextRun } from '../components/NextRun.js';
import { DiffView } from '../components/DiffView.js';
import {
  BTN,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  FIELD,
  Loading,
  PageHeader,
} from '../components/ui.js';
import { formatWhen, titleText } from '../lib/format.js';

// CodeMirror only loads when someone edits a diff.
const Editor = lazy(() => import('../components/MarkdownEditor.js'));

type TabId = 'open' | 'attention' | 'accepted' | 'rejected';
// Superseded proposals are replaced by a newer one, so they sit under Rejected; conflicts and
// refused diffs need you to edit or reject them, so they get their own tab once there are any.
const TABS: { id: TabId; label: string; statuses: ProposalStatus[] }[] = [
  { id: 'open', label: 'Open', statuses: ['open'] },
  { id: 'attention', label: 'Needs attention', statuses: ['conflict', 'failed'] },
  { id: 'accepted', label: 'Accepted', statuses: ['accepted'] },
  { id: 'rejected', label: 'Rejected', statuses: ['rejected', 'superseded'] },
];

function tabCount(id: TabId, c: Partial<Record<ProposalStatus, number>>): number {
  const n = (k: ProposalStatus) => c[k] ?? 0;
  if (id === 'open') return n('open');
  if (id === 'attention') return n('conflict') + n('failed');
  if (id === 'accepted') return n('accepted');
  return n('rejected') + n('superseded');
}

const Code = ({ children }: { children: string }) => (
  <code className="font-mono text-[13px]">{children}</code>
);

function RunNow() {
  const { run, job } = useImproverRun();
  const busy = run.isPending || job?.status === 'queued' || job?.status === 'running';
  const note = run.isError
    ? 'The improver could not start. Try again in a moment.'
    : job?.status === 'deferred'
      ? (job.error ?? 'Deferred: the judge budget is used up.')
      : job && (job.status === 'failed' || job.status === 'dead')
        ? `The improver failed: ${job.error ?? 'unknown error'}`
        : busy
          ? 'Improver running…'
          : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          run.mutate();
        }}
      >
        {busy ? 'Running…' : 'Run improver now'}
      </Button>
      <p role="status" className="m-0 text-[13px] text-muted empty:hidden">
        {note}
      </p>
    </div>
  );
}

function LastRun({ run }: { run: ImproverRun }) {
  return (
    <div className="flex flex-col gap-1 text-[13px] text-muted">
      <p className="m-0">
        Last run {formatWhen(run.startedAt)}: {run.status}, {String(run.proposals)}{' '}
        {run.proposals === 1 ? 'proposal' : 'proposals'}
        {run.clustersSkipped > 0
          ? `, ${String(run.clustersSkipped)} ${run.clustersSkipped === 1 ? 'cluster' : 'clusters'} skipped`
          : ''}
        .
      </p>
      {run.summary && run.summary.clusters.length > 0 ? (
        <details>
          <summary className="w-fit cursor-pointer text-accent">
            Cluster outcomes ({String(run.summary.clusters.length)})
          </summary>
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {run.summary.clusters.map((c) => (
              <li key={c.id}>
                <strong>{c.outcome}</strong> · {c.rubric} · {c.summary} (
                {String(c.sessionIds.length)} sessions): {c.detail}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <NextRun className="!text-[13px]" />
      {run.untrustedRubrics.length > 0 ? (
        <p className="m-0 text-warn">
          {run.untrustedRubrics.map((r) => `${r} needs calibration — excluded`).join('; ')}.{' '}
          <Link to="/rubrics">Calibrate in Rubrics</Link>
        </p>
      ) : null}
    </div>
  );
}

function SessionChip({ id }: { id: string }) {
  const s = useSession(id);
  return (
    <Chip tone="fail" className="max-w-full truncate">
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: id }}
        className="text-fail no-underline hover:text-fail hover:underline"
      >
        {s.data ? titleText(s.data.title) : id}
      </Link>
    </Chip>
  );
}

const SHOWN = 2;

function Evidence({ ids }: { ids: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? ids : ids.slice(0, SHOWN);
  const rest = ids.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((id) => (
        <SessionChip key={id} id={id} />
      ))}
      {rest > 0 ? (
        <button
          type="button"
          onClick={() => {
            setAll(true);
          }}
          className="cursor-pointer rounded-full border border-line bg-sunken px-2 py-0.5 text-xs leading-4 font-semibold text-muted"
        >
          + {rest} more
        </button>
      ) : null}
    </div>
  );
}

function Problems({ items, title }: { items: string[]; title: string }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-lg border border-fail-line bg-fail-bg p-3 text-[13px] text-fail"
    >
      <strong>{title}</strong>
      <ul className="m-0 list-disc pl-5">
        {items.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div
      role="note"
      aria-label="Executable change"
      className="flex gap-2 rounded-lg border border-warn-line bg-warn-bg p-3 text-[13px] text-warn"
    >
      <span aria-hidden="true">⚠</span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function ActionError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 422)
    return <Problems title={error.detail ?? error.title} items={error.problems} />;
  if (error instanceof ApiError && error.status === 409)
    return (
      <div
        role="alert"
        className="flex flex-col gap-1 rounded-lg border border-fail-line bg-fail-bg p-3 text-[13px] text-fail"
      >
        <strong>{error.detail ?? error.title}</strong>
        {error.fix ? <span>How to fix: {error.fix}</span> : null}
      </div>
    );
  return <ErrorState error={error} />;
}

type Mode = 'view' | 'edit' | 'reject';

function Actions({
  p,
  mode,
  setMode,
  onDone,
}: {
  p: Proposal;
  mode: Mode;
  setMode: (m: Mode) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(p.diff);
  const [reason, setReason] = useState('');
  const accept = useProposalAction(p.id, (api) => api.acceptProposal(p.id), { refreshAll: true });
  const save = useProposalAction(p.id, (api, d: string) => api.patchProposal(p.id, d), {
    refreshAll: false,
  });
  const reject = useProposalAction(p.id, (api, r: string) => api.rejectProposal(p.id, r), {
    refreshAll: true,
  });
  const busy = accept.isPending || save.isPending || reject.isPending;
  const warnings = p.validation.warnings;
  const [reviewed, setReviewed] = useState(false);

  if (mode === 'edit')
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 text-xs text-muted">
          <span>Diff (unified)</span>
          <Suspense
            fallback={
              <div className="flex h-[19rem] items-start rounded-lg border border-line p-3 text-sm">
                Loading editor…
              </div>
            }
          >
            <Editor plain label="Diff (unified)" value={draft} onChange={setDraft} />
          </Suspense>
        </div>
        {save.error instanceof ApiError && save.error.status === 422 ? (
          <Problems
            title={save.error.detail ?? 'The diff does not validate.'}
            items={save.error.problems}
          />
        ) : save.error ? (
          <ErrorState error={save.error} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={busy || draft === p.diff}
            onClick={() => {
              save.mutate(draft, {
                onSuccess: () => {
                  setMode('view');
                },
              });
            }}
          >
            {save.isPending ? 'Saving…' : 'Save diff'}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              save.reset();
              setDraft(p.diff);
              setMode('view');
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );

  const label = p.acceptMode === 'pr' ? 'Open pull request' : 'Merge into main';
  return (
    <div className="flex flex-col gap-3">
      {accept.error ? <ActionError error={accept.error} /> : null}
      {reject.error ? <ActionError error={reject.error} /> : null}
      {mode === 'reject' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            reject.mutate(reason.trim(), { onSuccess: onDone });
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted">
            Reason for rejecting
            <input
              className={FIELD}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
              autoFocus
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy || reason.trim() === ''}>
              {reject.isPending ? 'Rejecting…' : 'Reject proposal'}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setMode('view');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <Warnings items={warnings} />
          {warnings.length > 0 ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => {
                  setReviewed(e.target.checked);
                }}
              />
              I reviewed the executable change
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy || !p.validation.ok || (warnings.length > 0 && !reviewed)}
              onClick={() => {
                accept.mutate(undefined, { onSuccess: onDone });
              }}
            >
              {accept.isPending ? 'Working…' : label}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setDraft(p.diff);
                setMode('edit');
              }}
            >
              Edit first
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setMode('reject');
              }}
            >
              Reject with reason…
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Outcome({ p }: { p: Proposal }) {
  if (p.status === 'superseded')
    return <p className="m-0 text-sm">Superseded by a newer proposal for the same target.</p>;
  if (p.status === 'rejected') {
    const why = p.decisionNote ?? p.rejectReason;
    return <p className="m-0 text-sm">Rejected{why ? `: ${why}` : '.'}</p>;
  }
  if (p.status === 'open' && p.prUrl)
    return (
      <p className="m-0 text-sm">
        PR opened — waiting for merge:{' '}
        <a href={p.prUrl} target="_blank" rel="noreferrer">
          {p.prUrl}
        </a>
      </p>
    );
  return (
    <p className="m-0 text-sm">
      Merged
      {p.mergeCommit ? (
        <>
          {' '}
          as commit <Code>{p.mergeCommit}</Code>
        </>
      ) : null}
      {p.decidedAt ? ` ${formatWhen(p.decidedAt)}` : ''}.
    </p>
  );
}

const NOTICE: Partial<Record<Proposal['status'], string>> = {
  conflict:
    'Merge conflict: the target changed since this was drafted. Edit the diff to rebase it, then accept again, or reject it.',
  failed: 'The improver drafted a diff that was refused. Fix it with Edit first, or reject it.',
};

function Detail({ id, onDone }: { id: string; onDone: () => void }) {
  const q = useProposal(id);
  const [mode, setMode] = useState<Mode>('view');
  const p = q.data;
  return (
    <section
      aria-label="Proposal detail"
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-surface p-5"
    >
      {q.isPending ? <Loading /> : null}
      {q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => {
            void q.refetch();
          }}
        />
      ) : null}
      {p ? (
        <>
          <div className="flex flex-col gap-1.5">
            <h2 className="m-0 text-xl font-bold">{p.title}</h2>
            <p className="m-0 text-[13px] text-muted">
              {p.branch ? (
                <>
                  Branch <Code>{p.branch}</Code> ·{' '}
                </>
              ) : null}
              drafted {formatWhen(p.createdAt)} · targets{' '}
              {p.targetPaths.map((t, i) => (
                <span key={t}>
                  {i > 0 ? ', ' : null}
                  <Code>{t}</Code>
                </span>
              ))}{' '}
              {p.targetRepo ? (
                <>
                  in <Code>{p.targetRepo.path}</Code> ({p.targetRepo.kind})
                </>
              ) : null}{' '}
              · +{String(p.additions)} −{String(p.deletions)} in {String(p.files.length)}{' '}
              {p.files.length === 1 ? 'file' : 'files'}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <h3 className="m-0 text-sm font-semibold">Why</h3>
            <p className="m-0 text-sm leading-[1.55]">{p.rationale}</p>
            {p.cluster && p.cluster.reasons.length > 0 ? (
              <ul className="m-0 list-disc pl-5 text-[13px] text-muted">
                {p.cluster.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <h3 className="m-0 text-sm font-semibold">Evidence</h3>
            <Evidence ids={p.evidenceSessionIds} />
          </div>
          {mode === 'edit' ? null : (
            <div className="flex flex-col gap-1.5">
              <Warnings items={p.validation.warnings} />
              <h3 className="m-0 text-sm font-semibold">Diff</h3>
              <DiffView diff={p.diff} />
            </div>
          )}
          {NOTICE[p.status] ? (
            <p
              role="status"
              className="m-0 rounded-lg border border-warn-line bg-warn-bg p-3 text-[13px] text-warn"
            >
              {NOTICE[p.status]}
              {p.decisionNote ? ` ${p.decisionNote}` : ''}
            </p>
          ) : null}
          {!p.validation.ok ? (
            <Problems title="This diff does not validate." items={p.validation.problems} />
          ) : null}
          <p className="m-0 text-[13px] text-muted">
            Expected effect: {p.rubricNames.join(' and ')} pass{' '}
            {p.rubricNames.length === 1 ? 'rate' : 'rates'}. Measured on Trends after{' '}
            {p.acceptMode === 'pr' ? 'the pull request is merged' : 'merge'}.
          </p>
          {(p.status === 'open' && !p.prUrl) || p.status === 'conflict' || p.status === 'failed' ? (
            <Actions
              key={`${p.id}:${p.diff}`}
              p={p}
              mode={mode}
              setMode={setMode}
              onDone={onDone}
            />
          ) : (
            <Outcome p={p} />
          )}
        </>
      ) : null}
    </section>
  );
}

function ListItem({
  p,
  selected,
  onSelect,
}: {
  p: Proposal;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={`flex w-full cursor-pointer flex-col gap-1.5 rounded-[10px] border p-3.5 text-left font-[inherit] text-ink ${selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-sunken'}`}
    >
      <strong className="text-sm">{p.title}</strong>
      <span className="text-xs text-muted">
        {p.clusterSize} sessions · {p.rubricNames.join(', ')}
        {p.status === 'open' && p.prUrl ? ' · PR open' : ''}
        {p.status === 'conflict' || p.status === 'failed' || p.status === 'superseded'
          ? ` · ${p.status}`
          : ''}
      </span>
    </button>
  );
}

function Empty({ status }: { status: TabId }) {
  const runs = useImproverRuns();
  const rubrics = useRubrics();
  if (status !== 'open')
    return (
      <EmptyState
        title={status === 'attention' ? 'Nothing needs attention' : `Nothing ${status} yet`}
      >
        {status === 'accepted'
          ? 'Accepted proposals show up here with their merge commit.'
          : status === 'attention'
            ? 'Proposals with a merge conflict or a refused diff show up here.'
            : 'Rejected and superseded proposals show up here with the reason.'}
      </EmptyState>
    );
  if (runs.isPending || rubrics.isPending) return <Loading />;
  if (rubrics.data && !rubrics.data.some((r) => r.trusted))
    return (
      <EmptyState
        title="No rubric is trusted yet"
        actions={
          <Link to="/rubrics" className={BTN.secondary}>
            Calibrate a rubric
          </Link>
        }
      >
        The improver only learns from rubrics whose judge agrees with your labels. Label a few
        sessions on the Rubrics screen until one is calibrated.
      </EmptyState>
    );
  if (runs.data?.length === 0)
    return (
      <EmptyState title="The improver has not run yet">
        It runs every night on the failing grades of the last 24 hours. Use Run improver now to try
        it on what you have.
      </EmptyState>
    );
  return (
    <EmptyState title="No open proposals">
      The last run found nothing worth fixing. The improver runs again tonight, or use Run improver
      now.
    </EmptyState>
  );
}

export function Proposals() {
  const [tab, setTab] = useState<TabId>('open');
  const [picked, setPicked] = useState<string | null>(null);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const list = useProposalTab(active?.statuses ?? ['open']);
  const counts = useProposals('open').data?.counts ?? {};
  const runs = useImproverRuns();
  const items = list.items;
  // A picked proposal stays on screen after it leaves the tab, so the outcome of accept or reject
  // (merge commit, PR link) is not replaced by the next one.
  // Default to the first item only once every status of the tab has loaded: the statuses arrive
  // separately and the sort would otherwise move the selection from under the reader.
  const selectedId = picked ?? (list.loaded ? items[0]?.id : undefined);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Proposals"
        subtitle="Drafted by the nightly improver from the last 24 h of failing grades. Nothing changes until you accept."
        actions={<RunNow />}
      />
      {runs.data?.[0] ? <LastRun run={runs.data[0]} /> : null}
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-2">
          <div role="tablist" aria-label="Status" className="flex flex-wrap gap-1.5">
            {TABS.filter(
              (t) => t.id !== 'attention' || tabCount(t.id, counts) > 0 || tab === t.id,
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  setPicked(null);
                }}
                className={`h-9 cursor-pointer whitespace-nowrap rounded-full border px-3 font-[inherit] text-[13px] text-ink ${tab === t.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`}
              >
                {t.label}
                {Object.keys(counts).length > 0 || t.id === 'open'
                  ? ` (${String(tabCount(t.id, counts))})`
                  : ''}
              </button>
            ))}
          </div>
          {list.pending ? <Loading /> : null}
          {list.error ? <ErrorState error={list.error} /> : null}
          {items.map((p) => (
            <ListItem
              key={p.id}
              p={p}
              selected={p.id === selectedId}
              onSelect={() => {
                setPicked(p.id);
              }}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-[3_1_480px] flex-col">
          {selectedId ? (
            <Detail
              key={selectedId}
              id={selectedId}
              onDone={() => {
                setPicked(selectedId);
              }}
            />
          ) : null}
          {list.loaded && !selectedId ? <Empty status={tab} /> : null}
        </div>
      </div>
    </div>
  );
}
