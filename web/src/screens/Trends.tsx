import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { ApiError } from '../api/client.js';
import {
  useReferenceRegrade,
  useReferenceSet,
  useRubrics,
  useTrendChanges,
  useTrends,
} from '../api/queries.js';
import type {
  ChangeVerdict,
  TrendBucketSize,
  TrendChange,
  Trends as TrendData,
} from '../api/types.js';
import { plural, titleText } from '../lib/format.js';
import { JobNote } from '../components/JobNote.js';
import {
  BTN,
  Button,
  Card,
  Chip,
  type ChipTone,
  EmptyState,
  ErrorState,
  Field,
  FIELD,
  Loading,
  PageHeader,
  VerdictChip,
} from '../components/ui.js';
import {
  bucketTitle,
  formatDayLocal,
  gradedTotal,
  LOW_SAMPLE,
  overlapGroups,
  pct,
  rubricLabel,
  seriesColor,
} from '../lib/trends.js';
import type { Series } from '../components/TrendChart.js';

// Recharts is ~100 KB gzip and only this screen draws charts.
const TrendChart = lazy(() => import('../components/TrendChart.js'));

const RANGES = [4, 12, 26] as const;
const ALL = 'all';

export function Trends() {
  const [rubric, setRubric] = useState(ALL);
  const [weeks, setWeeks] = useState<number>(12);
  const [bucket, setBucket] = useState<TrendBucketSize>('week');
  const trends = useTrends({ weeks, bucket });
  const rubrics = useRubrics();
  const names = trends.data
    ? [...new Set(trends.data.buckets.flatMap((b) => Object.keys(b.rubrics)))].sort()
    : [];
  const targets = new Map((rubrics.data ?? []).map((r) => [r.name, r.target]));
  // Colour by position in the full list, so picking one rubric does not repaint it.
  const series: Series[] = names
    .map((name, i) => ({ name, color: seriesColor(i), target: targets.get(name) ?? null }))
    .filter((s) => rubric === ALL || s.name === rubric);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Trends"
        subtitle={`${bucket === 'week' ? 'Weekly' : 'Daily'} pass rate per rubric. Dashed markers = changes you merged.`}
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Rubric">
              <select
                className={FIELD}
                value={rubric}
                onChange={(e) => {
                  setRubric(e.target.value);
                }}
              >
                <option value={ALL}>All rubrics</option>
                {names.map((n) => (
                  <option key={n} value={n}>
                    {rubricLabel(n)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Range">
              <select
                className={FIELD}
                value={weeks}
                onChange={(e) => {
                  setWeeks(Number(e.target.value));
                }}
              >
                {RANGES.map((w) => (
                  <option key={w} value={w}>
                    Last {w} weeks
                  </option>
                ))}
              </select>
            </Field>
            <div
              role="group"
              aria-label="Group by"
              className="flex flex-col gap-1 text-xs text-muted"
            >
              <span aria-hidden="true">Group by</span>
              <div className="flex h-10 overflow-hidden rounded-lg border border-line bg-surface">
                {(['week', 'day'] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={bucket === b}
                    onClick={() => {
                      setBucket(b);
                    }}
                    className={`cursor-pointer border-0 px-3 font-[inherit] text-sm ${bucket === b ? 'bg-accent-soft font-semibold text-ink' : 'bg-transparent text-ink-soft hover:bg-sunken'}`}
                  >
                    {b === 'week' ? 'Weeks' : 'Days'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        }
      />
      {trends.isPending ? <Loading label="Loading trends" /> : null}
      {trends.isError ? (
        <ErrorState error={trends.error} onRetry={() => void trends.refetch()} />
      ) : null}
      {trends.data && gradedTotal(trends.data) === 0 ? (
        <EmptyState
          title="Not enough graded sessions yet"
          actions={
            <Link to="/" className={BTN.secondary}>
              Back to Sessions
            </Link>
          }
        >
          Trends show the pass rate per rubric over time, with a marker for each change you merge.
          They need graded sessions, so grade a few from the Sessions screen first.
        </EmptyState>
      ) : null}
      {trends.data && gradedTotal(trends.data) > 0 ? (
        <ChartCard
          data={trends.data}
          series={series}
          bucket={bucket}
          single={rubric !== ALL}
          stale={trends.isPlaceholderData}
        />
      ) : null}
      <ReferenceCard />
      <ChangeLog />
    </div>
  );
}

function ChartCard({
  data,
  series,
  bucket,
  single,
  stale,
}: {
  data: TrendData;
  series: Series[];
  bucket: TrendBucketSize;
  single: boolean;
  stale: boolean;
}) {
  const shown = new Set(series.map((s) => s.name));
  const hasFix = data.markers.some((m) => m.kind !== 'rubric_changed');
  const hasReset = data.baselineResets.some((r) => shown.has(r.rubric));
  const hasTarget = series.some((s) => s.target !== null);
  const hollow = data.buckets.length <= 30;
  const overlaps = overlapGroups(
    data.buckets,
    series.map((s) => s.name),
  );
  return (
    <Card
      role="region"
      aria-label="Pass rate chart"
      className={`flex flex-col gap-3 p-5 ${stale ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-[3px] w-4 rounded"
              style={{ background: s.color }}
            />
            {rubricLabel(s.name)}
          </span>
        ))}
        {hasTarget ? (
          <span className="flex items-center gap-1.5 text-muted">
            <span aria-hidden="true" className="w-4 border-t-2 border-dashed border-line-dashed" />
            Target
          </span>
        ) : null}
        {hasFix ? (
          <span className="flex items-center gap-1.5 text-muted">
            <svg aria-hidden="true" width="16" height="10">
              <line
                x1="0"
                x2="16"
                y1="5"
                y2="5"
                stroke="var(--ink)"
                strokeWidth="1.25"
                strokeDasharray="4 4"
              />
              <circle
                cx="8"
                cy="5"
                r="4"
                fill="var(--ink)"
                stroke="var(--surface)"
                strokeWidth="1.5"
              />
            </svg>
            Merged change
          </span>
        ) : null}
        {hasReset ? (
          <span className="flex items-center gap-1.5 text-muted">
            <svg aria-hidden="true" width="16" height="10">
              <rect
                x="4"
                y="1"
                width="8"
                height="8"
                transform="rotate(45 8 5)"
                fill="var(--surface)"
                stroke="var(--ink-muted)"
                strokeWidth="1.5"
              />
            </svg>
            Baseline reset
          </span>
        ) : null}
      </div>
      <Suspense fallback={<Loading label="Loading chart" />}>
        <TrendChart data={data} series={series} bucket={bucket} single={single} />
      </Suspense>
      <p className="m-0 text-xs leading-normal text-muted">
        {hollow ? (
          <>Hollow points have fewer than {LOW_SAMPLE} graded sessions: read them with care. </>
        ) : (
          <>Buckets with fewer than {LOW_SAMPLE} graded sessions are marked in the tooltip. </>
        )}
        {hasReset
          ? 'A baseline reset means the rubric or the judge changed: pass rates before and after it are not like-for-like.'
          : null}
        {overlaps.map((g) => (
          <span key={g.join()}>
            {' '}
            {g.map(rubricLabel).join(', ')} have identical values, so their lines overlap: they
            alternate as stripes.
          </span>
        ))}
      </p>
      <DataTable data={data} series={series} bucket={bucket} />
    </Card>
  );
}

/** The chart's numbers as a table: the keyboard and screen reader view of the same data. */
function DataTable({
  data,
  series,
  bucket,
}: {
  data: TrendData;
  series: Series[];
  bucket: TrendBucketSize;
}) {
  return (
    <details className="text-sm">
      <summary className="w-fit cursor-pointer py-1 text-accent">Show the data as a table</summary>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            Pass rate and graded sessions per {bucket} and rubric
          </caption>
          <thead>
            <tr>
              <th scope="col" className="px-3">
                {bucket === 'week' ? 'Week of' : 'Day'}
              </th>
              {series.map((s) => (
                <th key={s.name} scope="col" className="px-3">
                  {rubricLabel(s.name)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((b) => (
              <tr key={b.start}>
                <th scope="row" className="px-3 font-normal text-ink">
                  {bucketTitle(b.start, bucket).replace('Week of ', '')}
                </th>
                {series.map((s) => {
                  const p = b.rubrics[s.name];
                  return (
                    <td key={s.name} className="px-3 tabular-nums">
                      {p?.graded
                        ? `${pct(p.passRate)} (${String(p.graded)} graded)`
                        : 'none graded'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const VERDICT: Record<
  ChangeVerdict,
  { tone: ChipTone; text: (c: { after: { graded: number } }) => string }
> = {
  improved: { tone: 'pass', text: () => 'Improved' },
  worse: { tone: 'fail', text: () => 'Worse' },
  no_change: { tone: 'na', text: () => 'No change' },
  too_early: { tone: 'warn', text: (c) => `Too early — ${String(c.after.graded)} graded since` },
};

function ChangeLog() {
  const changes = useTrendChanges();
  const regrade = useReferenceRegrade();
  const empty = regrade.error instanceof ApiError && regrade.error.status === 409;
  const busy =
    regrade.pending || regrade.job?.status === 'queued' || regrade.job?.status === 'running';
  return (
    <Card role="region" aria-label="Change log" className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 text-base font-semibold">Did the fix help?</h2>
          <p className="m-0 text-[13px] text-muted">
            Pass rate for the rubrics a change targets, over the{' '}
            {plural(changes.data?.[0]?.before.window ?? 7, 'day')} before and after it landed. Each
            rubric is tested separately (Fisher’s exact test for small samples) at 90 % confidence.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {empty ? (
            <p role="alert" className="m-0 text-[13px] text-fail">
              The reference set is empty. Open a session and choose “Add to reference set” first.
            </p>
          ) : (
            <JobNote job={regrade.job} failed={regrade.failed} />
          )}
          <Button disabled={busy} onClick={regrade.start}>
            Re-grade reference set
          </Button>
        </div>
      </div>
      {changes.isPending ? <Loading label="Loading changes" /> : null}
      {changes.isError ? (
        <div className="p-4">
          <ErrorState error={changes.error} onRetry={() => void changes.refetch()} />
        </div>
      ) : null}
      {changes.data?.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="No changes merged yet"
            actions={
              <Link to="/proposals" className={BTN.secondary}>
                Go to Proposals
              </Link>
            }
          >
            Once you accept a proposal or edit a skill, it shows up here with the pass rate before
            and after.
          </EmptyState>
        </div>
      ) : null}
      {changes.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="px-3">Merged</th>
                <th className="px-3">Change</th>
                <th className="px-3">Source</th>
                <th className="px-3">Rubric watched</th>
                <th className="px-3 xl:whitespace-nowrap">Pass rate before → after</th>
                <th className="px-3">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {changes.data.map((c) => (
                <ChangeRow key={c.id} c={c} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

/** The fixed sessions that are re-graded after every change, so before/after is like-for-like. */
function ReferenceCard() {
  const ref = useReferenceSet();
  if (ref.isPending) return <Loading label="Loading reference set" />;
  if (ref.isError) return <ErrorState error={ref.error} onRetry={() => void ref.refetch()} />;
  const { items, target } = ref.data;
  return (
    <Card role="region" aria-label="Reference set" className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="m-0 text-base font-semibold">
          Reference set: {items.length} of {target}
        </h2>
        <p className="m-0 text-[13px] text-muted">
          Pinned sessions that are re-graded after every change. Add them from a session page.
        </p>
      </div>
      {items.length === 0 ? (
        <p className="m-0 text-sm text-ink-soft">
          No sessions yet. Open a representative session and choose “Add to reference set”.
        </p>
      ) : (
        <details className="text-sm">
          <summary className="w-fit cursor-pointer py-1 text-accent">Show the sessions</summary>
          <ul className="m-0 flex list-none flex-col divide-y divide-line-soft p-0">
            {items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 flex-col">
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: s.id }}
                    className="break-words"
                  >
                    {titleText(s.title)}
                  </Link>
                  <span className="text-xs text-muted">
                    {s.startedAt ? `Started ${formatDayLocal(s.startedAt)}` : 'Start unknown'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {s.grades.length === 0 ? (
                    <span className="text-xs text-muted">Not graded</span>
                  ) : (
                    s.grades.map((g) => (
                      <span key={g.rubric} className="flex items-center gap-1 text-xs text-muted">
                        {rubricLabel(g.rubric)}
                        <VerdictChip passed={g.passed} />
                      </span>
                    ))
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

const pText = (p: number | null) =>
  p === null ? '' : p < 0.01 ? 'p < 0.01' : `p = ${p.toFixed(2)}`;

type RubricResult = TrendChange['perRubric'][number];

const rateText = (r: Pick<RubricResult, 'before' | 'after'>) =>
  `${r.before.passRate === null ? 'no data before' : pct(r.before.passRate)} → ${pct(r.after.passRate)}`;

function ChangeRow({ c }: { c: TrendChange }) {
  const reset = c.kind === 'rubric_changed';
  const v = VERDICT[c.verdict];
  const multi = !reset && c.perRubric.length > 1;
  const p = multi ? null : (c.perRubric[0]?.pValue ?? null);
  return (
    <>
      <tr>
        <td className="px-3">{formatDayLocal(c.at)}</td>
        <td className="min-w-44 px-3 whitespace-normal">{c.title}</td>
        <td className="px-3 whitespace-normal">
          {c.proposalId ? (
            <Link to="/proposals">Proposal</Link>
          ) : reset ? (
            'Rubric change'
          ) : (
            'Manual edit'
          )}
        </td>
        <td className="px-3 whitespace-normal">{c.rubrics.map(rubricLabel).join(', ') || 'All'}</td>
        <td className="px-3">
          {reset ? (
            <span className="text-muted">baseline reset</span>
          ) : (
            <div className="flex flex-col">
              <span className="font-semibold">{rateText(c)}</span>
              <span className="text-xs text-muted">
                {String(c.before.graded)} → {String(c.after.graded)} graded
                {p === null ? '' : ` · ${pText(p)}`}
              </span>
            </div>
          )}
        </td>
        <td className="px-3 whitespace-normal">
          {reset ? (
            <span className="text-muted">–</span>
          ) : (
            <Chip tone={v.tone} className="xl:whitespace-nowrap">
              {v.text(c)}
            </Chip>
          )}
        </td>
      </tr>
      {multi
        ? c.perRubric.map((r) => (
            <tr key={r.rubric} data-subrow>
              <td colSpan={3} />
              <td className="px-3 pl-6 text-[13px] whitespace-normal text-muted">
                {rubricLabel(r.rubric)}
              </td>
              <td className="px-3">
                <div className="flex flex-col">
                  <span className="text-[13px]">{rateText(r)}</span>
                  <span className="text-xs text-muted">
                    {String(r.before.graded)} → {String(r.after.graded)} graded
                    {r.pValue === null ? '' : ` · ${pText(r.pValue)}`}
                  </span>
                </div>
              </td>
              <td className="px-3 whitespace-normal">
                <Chip tone={VERDICT[r.verdict].tone} className="xl:whitespace-nowrap">
                  {VERDICT[r.verdict].text(r)}
                </Chip>
              </td>
            </tr>
          ))
        : null}
    </>
  );
}
