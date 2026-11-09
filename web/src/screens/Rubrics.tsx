import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { useApi } from '../api/context.js';
import {
  GRADE_KEYS,
  invalidateKeys,
  useRubric,
  useRubrics,
  useSessions,
  useSkillRepos,
} from '../api/queries.js';
import type { CalibrationRow, DryRunResult, RubricDetail, RubricSummary } from '../api/types.js';
import { LabelForm } from '../components/LabelForm.js';
import {
  BTN,
  Button,
  EmptyState,
  ErrorState,
  Field,
  FIELD,
  Loading,
  PageHeader,
  VerdictChip,
} from '../components/ui.js';
import { formatTokens, formatWhen, plural, titleText } from '../lib/format.js';
import { rubricLabel } from '../lib/trends.js';
import {
  composeRubricFile,
  NEW_RUBRIC_BODY,
  readThreshold,
  writeThreshold,
} from '../lib/rubric.js';

// CodeMirror is ~150 KB gzip; it loads only when this screen shows an editor.
const MarkdownEditor = lazy(() => import('../components/MarkdownEditor.js'));

const GATE = 8;
const NEEDED = 10;

function gateLabel(r: Pick<RubricSummary, 'trusted' | 'agreement'>) {
  return r.trusted
    ? 'Trusted'
    : `Needs calibration: ${String(r.agreement.agree)} of ${String(r.agreement.total)} agree`;
}

function RubricList({
  rubrics,
  selected,
  onSelect,
}: {
  rubrics: RubricSummary[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(name) && !rubrics.some((r) => r.name === name);
  const create = useMutation({
    mutationFn: () =>
      api.putRubric(name, {
        body: NEW_RUBRIC_BODY(name),
        passThreshold: 0.6,
        message: `Add ${name} rubric`,
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['rubrics'] });
      setNaming(false);
      setName('');
      onSelect(r.name);
    },
  });
  return (
    <nav aria-label="Rubrics" className="flex min-w-0 flex-[1_1_200px] flex-col gap-2">
      {rubrics.map((r) => {
        const on = r.name === selected;
        return (
          <button
            key={r.name}
            type="button"
            aria-current={on ? 'true' : undefined}
            onClick={() => {
              onSelect(r.name);
            }}
            className={`flex min-h-11 flex-col gap-0.5 rounded-[10px] border p-3 text-left font-[inherit] text-ink ${on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-sunken'}`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className={on ? 'font-semibold' : ''}>{rubricLabel(r.name)}</span>
              <span className="text-xs text-muted">v{r.version}</span>
            </span>
            <span className="truncate font-mono text-xs text-muted" title={r.name}>
              {r.name}
            </span>
            <span
              className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted"
              title={gateLabel(r)}
            >
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${r.trusted ? 'bg-pass' : 'bg-warn'}`}
              />
              {r.agreement.agree}/{r.agreement.total} agree ·{' '}
              <span className={r.trusted ? 'text-pass' : 'text-warn'}>
                {r.trusted ? 'trusted' : 'uncalibrated'}
              </span>
            </span>
          </button>
        );
      })}
      {naming ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <Field
            label="Rubric name"
            hint={
              name && !valid
                ? 'Lowercase letters, digits and dashes; the name must be new.'
                : 'Becomes rubrics/<name>.md in your skills repo.'
            }
          >
            <input
              className={FIELD}
              value={name}
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </Field>
          {create.isError ? (
            <p role="alert" className="m-0 text-xs text-fail">
              {create.error.message}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={!valid || create.isPending}>
              Create
            </Button>
            <Button
              onClick={() => {
                setNaming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="dashed"
          onClick={() => {
            setNaming(true);
          }}
        >
          + New rubric
        </Button>
      )}
    </nav>
  );
}

/** Draft edits of one rubric version; remounted (via `key`) when a new version is saved. */
function RubricEditor({
  detail,
  titles,
  onDryRunIds,
  notice,
  onSaved,
}: {
  detail: RubricDetail;
  titles: Map<string, string>;
  notice: string | null;
  onSaved: (version: number) => void;
  onDryRunIds: () => { calibration: string[]; recent: string[] };
}) {
  const api = useApi();
  const qc = useQueryClient();
  // The API returns the body without its frontmatter; the editor works on the whole file.
  const file = composeRubricFile(detail);
  const [body, setBody] = useState(file);
  const [threshold, setThreshold] = useState(String(detail.passThreshold));
  const [message, setMessage] = useState(`Update ${detail.name} rubric`);
  const [target, setTarget] = useState<'calibration' | 'recent'>('calibration');
  const ids = onDryRunIds();
  const dryIds = target === 'calibration' && ids.calibration.length ? ids.calibration : ids.recent;
  const value = Number(threshold);
  const thresholdOk = threshold.trim() !== '' && value >= 0 && value <= 1;
  const dirty = body !== file || (thresholdOk && value !== detail.passThreshold);

  const save = useMutation({
    mutationFn: () =>
      api.putRubric(detail.name, { body, passThreshold: value, message: message.trim() }),
    onSuccess: async (next) => {
      qc.setQueryData(['rubric', detail.name], next);
      onSaved(next.version);
      // A new version changes which grades are current, the trusted flag and the pass rates.
      await invalidateKeys(
        qc,
        GRADE_KEYS.filter((k) => k !== 'rubric'),
      );
    },
  });
  const dry = useMutation({
    mutationFn: () =>
      api.dryRunRubric(detail.name, { sessionIds: dryIds, body, passThreshold: value }),
  });

  return (
    <section
      aria-label="Editor"
      className="flex min-w-0 flex-[3_1_420px] flex-col gap-3.5 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap gap-3">
        <Field
          label="Pass threshold"
          hint={
            thresholdOk ? undefined : <span className="text-fail">Use a number from 0 to 1.</span>
          }
        >
          <input
            type="number"
            min={0}
            max={1}
            step={0.1}
            className={`${FIELD} w-24`}
            value={threshold}
            onChange={(e) => {
              setThreshold(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value.trim() !== '' && n >= 0 && n <= 1)
                setBody(writeThreshold(body, n));
            }}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted">
        <span>Rubric body (markdown)</span>
        <Suspense
          fallback={
            <div className="flex h-[19rem] items-start rounded-lg border border-line p-3 text-sm">
              Loading editor…
            </div>
          }
        >
          <MarkdownEditor
            label="Rubric body (markdown)"
            value={body}
            onChange={(v) => {
              setBody(v);
              const t = readThreshold(v);
              if (t !== null) setThreshold(String(t));
            }}
          />
        </Suspense>
      </div>
      <Field label="Commit message">
        <input
          className={FIELD}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!dirty || !thresholdOk || !message.trim() || save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          Save as v{detail.version + 1} (commit)
        </Button>
        <Button
          disabled={dry.isPending || dryIds.length === 0}
          onClick={() => {
            dry.mutate();
          }}
        >
          {dry.isPending ? 'Running…' : `Dry-run on ${plural(dryIds.length, 'session')}`}
        </Button>
        {ids.calibration.length ? (
          <label className="flex items-center gap-2 text-[13px] text-muted">
            Sessions
            <select
              className={`${FIELD} h-11`}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value as 'calibration' | 'recent');
              }}
            >
              <option value="calibration">Calibration sessions</option>
              <option value="recent">Most recent sessions</option>
            </select>
          </label>
        ) : null}
      </div>
      {save.isError ? (
        <p role="alert" className="m-0 text-[13px] text-fail">
          Could not save: {save.error.message}
        </p>
      ) : notice ? (
        <p role="status" className="m-0 text-[13px] text-pass">
          {notice}
        </p>
      ) : null}
      {dry.isError ? (
        <p role="alert" className="m-0 text-[13px] text-fail">
          Dry-run failed: {dry.error.message}
        </p>
      ) : null}
      {dry.data ? <DryRunResults result={dry.data} titles={titles} /> : null}
      <details className="text-[13px]">
        <summary className="w-fit cursor-pointer text-accent">
          History ({plural(detail.versions.length, 'version')})
        </summary>
        <ol className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-muted">
          {[...detail.versions]
            .sort((x, y) => y.version - x.version)
            .map((v) => (
              <li key={v.sha}>
                <code>{v.sha.slice(0, 7)}</code> · v{v.version} · {v.message} · {formatWhen(v.at)}
              </li>
            ))}
        </ol>
      </details>
    </section>
  );
}

function DryRunResults({ result, titles }: { result: DryRunResult; titles: Map<string, string> }) {
  const passes = result.verdicts.filter((v) => v.passed).length;
  return (
    <div className="flex flex-col gap-2 border-t border-line-soft pt-3.5">
      <h3 className="m-0 text-sm font-semibold">
        Dry-run results · {passes} of {result.verdicts.length} pass
      </h3>
      <p className="m-0 text-xs text-muted">
        Used {formatTokens(result.usage.tokens)} tokens. Nothing is saved as a grade.
        {result.skipped.length > 0
          ? ` ${plural(result.skipped.length, 'session')} skipped: ${result.skipped[0]?.reason ?? ''}`
          : ''}
      </p>
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">Dry-run results</caption>
        <colgroup>
          <col />
          <col className="w-[5.75rem]" />
          <col className="w-[4.25rem]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Session and reason</th>
            <th scope="col">Judge</th>
            <th scope="col">You</th>
          </tr>
        </thead>
        <tbody>
          {result.verdicts.map((v) => {
            const mine = v.humanPassed;
            return (
              <tr key={v.sessionId} className={v.agrees === false ? 'row-disagree' : ''}>
                <td className="whitespace-normal">
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: v.sessionId }}
                    className="block truncate"
                  >
                    {titleText(titles.get(v.sessionId) ?? v.sessionId)}
                  </Link>
                  <span className="text-xs leading-snug text-muted">
                    {v.status === 'ok'
                      ? v.reason
                      : `The judge ${v.status === 'refused' ? 'refused to grade this session' : 'returned an invalid verdict'}.`}
                  </span>
                </td>
                <td className="align-top">
                  <VerdictChip passed={v.passed} score={v.score} />
                </td>
                <td className="align-top">
                  {mine === null ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <VerdictChip passed={mine} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const SHOWN = 4;

function Calibration({ detail }: { detail: RubricDetail }) {
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const rows: CalibrationRow[] = all ? detail.calibration : detail.calibration.slice(0, SHOWN);
  const hidden = detail.calibration.length - rows.length;
  const { agree, total } = detail.agreement;
  return (
    <aside
      aria-label="Calibration"
      className="flex min-w-0 flex-[2_1_300px] flex-col gap-3 rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="m-0 text-base font-semibold">Calibration</h2>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[28px] leading-tight font-bold whitespace-nowrap">
          {agree} / {total < NEEDED ? NEEDED : total}
        </span>
        <span className="text-[13px] text-muted">judge agrees with your labels</span>
      </div>
      <p
        className={`m-0 rounded-lg border px-3 py-2.5 text-[13px] ${detail.trusted ? 'border-pass-line bg-pass-bg text-pass' : 'border-warn-line bg-warn-bg text-warn'}`}
      >
        <strong>{gateLabel(detail)}.</strong>{' '}
        {detail.trusted
          ? 'The improver may use this rubric.'
          : total < NEEDED
            ? `Gate: label ${plural(NEEDED - total, 'more session')}, then ${String(GATE)} / ${String(NEEDED)} must agree before the improver may use this rubric.`
            : `Gate: needs ${String(GATE)} / ${String(NEEDED)} before the improver may use this rubric.`}
      </p>
      <p className="m-0 text-xs text-muted">
        Only labels on sessions graded with the current rubric version (v{detail.version}) count.
      </p>
      {detail.calibration.length ? (
        <table className="w-full table-fixed border-collapse">
          <caption className="sr-only">Calibration labels</caption>
          <colgroup>
            <col />
            <col className="w-16" />
            <col className="w-16" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">You</th>
              <th scope="col">Judge</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.sessionId} className={c.agrees === false ? 'row-disagree' : ''}>
                <td className="whitespace-normal" title={titleText(c.title)}>
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: c.sessionId }}
                    className="line-clamp-2 text-ink no-underline hover:underline"
                  >
                    {titleText(c.title)}
                  </Link>
                </td>
                <td>
                  <VerdictChip passed={c.human.passed} />
                </td>
                <td>
                  {c.judge ? (
                    <VerdictChip passed={c.judge.passed} />
                  ) : (
                    <span className="text-muted" title="Not judged with this version yet">
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {hidden > 0 ? (
              <tr>
                <td colSpan={3}>
                  <button
                    type="button"
                    onClick={() => {
                      setAll(true);
                    }}
                    className="cursor-pointer border-0 bg-transparent p-0 text-[13px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
                  >
                    + {hidden} more
                  </button>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : (
        <p className="m-0 text-sm text-muted">
          No labels yet. Label sessions to calibrate the judge.
        </p>
      )}
      {adding ? (
        <LabelForm
          rubric={detail.name}
          skip={detail.calibration.map((c) => c.sessionId)}
          onDone={() => {
            setAdding(false);
          }}
          onCancel={() => {
            setAdding(false);
          }}
        />
      ) : (
        <Button
          className="self-start"
          onClick={() => {
            setAdding(true);
          }}
        >
          Add label…
        </Button>
      )}
    </aside>
  );
}

function Workspace({ name }: { name: string }) {
  const detail = useRubric(name);
  const recent = useSessions({ result: 'all', limit: 10 });
  const [notice, setNotice] = useState<string | null>(null);
  if (detail.isPending) return <Loading label="Loading rubric" />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const d = detail.data;
  const recentItems = recent.data?.pages.flatMap((p) => p.items) ?? [];
  const titles = new Map([
    ...recentItems.map((s): [string, string] => [s.id, s.title]),
    ...d.calibration.map((c): [string, string] => [c.sessionId, c.title]),
  ]);
  return (
    <>
      <RubricEditor
        key={`${d.name}@${String(d.version)}`}
        detail={d}
        titles={titles}
        notice={notice}
        onSaved={(v) => {
          setNotice(`Saved as v${String(v)} and committed to your skills repo.`);
        }}
        onDryRunIds={() => ({
          calibration: d.calibration.slice(0, 10).map((c) => c.sessionId),
          recent: recentItems.map((s) => s.id),
        })}
      />
      <Calibration detail={d} />
    </>
  );
}

export function Rubrics() {
  const rubrics = useRubrics();
  const repos = useSkillRepos();
  const [picked, setPicked] = useState<string | null>(null);

  if (rubrics.isPending || repos.isPending) return <Loading label="Loading rubrics" />;
  if (rubrics.isError)
    return <ErrorState error={rubrics.error} onRetry={() => void rubrics.refetch()} />;

  const list = rubrics.data;
  const hasRepo = repos.data?.some((r) => r.kind === 'global') ?? false;
  const selected = list.find((r) => r.name === picked)?.name ?? list[0]?.name;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Rubrics"
        subtitle={
          <>
            Markdown files in <code>rubrics/</code>, versioned in git. The improver only uses
            calibrated rubrics.
          </>
        }
      />
      {selected === undefined ? (
        <EmptyState
          title={hasRepo ? 'No rubrics in your skills repo yet' : 'No skills repo set up yet'}
          actions={
            <>
              <Link to="/settings" className={BTN.primary}>
                {hasRepo ? 'Copy starter rubrics in Settings' : 'Set up a skills repo in Settings'}
              </Link>
            </>
          }
        >
          A rubric is a short Markdown file in the <code>rubrics/</code> folder of your skills repo.
          It tells the judge what a good session looks like.{' '}
          {hasRepo
            ? 'Settings can copy four starter rubrics into your repo.'
            : 'Pick or create the repo first; Introspect commits rubric edits there.'}
        </EmptyState>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <RubricList rubrics={list} selected={selected} onSelect={setPicked} />
          <Workspace key={selected} name={selected} />
        </div>
      )}
    </div>
  );
}
