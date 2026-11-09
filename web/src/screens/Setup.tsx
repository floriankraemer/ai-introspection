import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../api/context.js';
import { invalidateKeys, useImport, usePatchSettings } from '../api/queries.js';
import type { DetectedSource, JudgeTransport, SkillRepo } from '../api/types.js';
import { FailingChecks } from '../components/HealthCheck.js';
import { JudgeTest } from '../components/JudgeTest.js';
import { Button, Card, ErrorState, Field, FIELD, Loading } from '../components/ui.js';
import { AGENT_LABEL } from '../lib/format.js';

const STEPS = ['Sources', 'Judge', 'Skills repo', 'Done'] as const;
const DEFAULT_BUDGET = 1_000_000;

function SourcesStep({
  unticked,
  toggle,
}: {
  unticked: ReadonlySet<string>;
  toggle: (path: string) => void;
}) {
  const api = useApi();
  const detected = useQuery({ queryKey: ['sources-detected'], queryFn: () => api.detectSources() });
  if (detected.isPending) return <Loading label="Looking for session folders" />;
  if (detected.isError)
    return <ErrorState error={detected.error} onRetry={() => void detected.refetch()} />;
  if (detected.data.length === 0)
    return (
      <p className="m-0 text-sm leading-normal text-ink-soft">
        No Claude Code or Codex session folders were found. If you run Introspect in Docker, check
        that <code>~/.claude/projects</code> or <code>~/.codex/sessions</code> is mounted. You can
        skip this step and add folders later in Settings.
      </p>
    );
  return (
    <fieldset className="m-0 flex flex-col border-0 p-0">
      <legend className="mb-2 p-0 text-sm text-ink-soft">
        These folders hold the session logs Introspect can read. Untick any you do not want.
      </legend>
      {detected.data.map((d: DetectedSource) => (
        <label
          key={d.path}
          className="flex items-center gap-3 border-b border-line-soft py-3 text-sm"
        >
          <input
            type="checkbox"
            className="size-[18px]"
            checked={!unticked.has(d.path)}
            onChange={() => {
              toggle(d.path);
            }}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong>{AGENT_LABEL[d.agent]}</strong>
            <code className="break-all text-muted">{d.path}</code>
          </span>
          <span className="text-muted">{d.sessionCount} sessions</span>
        </label>
      ))}
    </fieldset>
  );
}

interface JudgeDraft {
  transport: JudgeTransport;
  apiKey: string;
  tokens: string;
}

function JudgeStep({ draft, set }: { draft: JudgeDraft; set: (d: JudgeDraft) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-sm text-ink-soft">
          The judge is the model that grades your sessions. How should it run?
        </legend>
        {(
          [
            ['api', 'Anthropic API key', 'Pay per token. Works everywhere, including Docker.'],
            [
              'cli',
              'Local claude CLI',
              'Uses your Claude login. Needs the claude CLI in this environment.',
            ],
          ] as const
        ).map(([value, title, hint]) => (
          <label
            key={value}
            className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm"
          >
            <input
              type="radio"
              name="transport"
              className="mt-0.5 size-[18px]"
              checked={draft.transport === value}
              onChange={() => {
                set({ ...draft, transport: value });
              }}
            />
            <span className="flex flex-col gap-0.5">
              <strong>{title}</strong>
              <span className="text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {draft.transport === 'api' ? (
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <Field
            label="Anthropic API key"
            hint="Stored on this machine only, never in your skills repo."
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={FIELD}
              placeholder="sk-ant-…"
              value={draft.apiKey}
              onChange={(e) => {
                set({ ...draft, apiKey: e.target.value });
              }}
            />
          </Field>
        </form>
      ) : null}
      <JudgeTest transport={draft.transport} apiKey={draft.apiKey.trim()} />
      <Field
        label="Daily token budget"
        hint="Grading stops for the day when this is used up. You can change it in Settings."
      >
        <input
          type="number"
          min={1}
          className={FIELD}
          value={draft.tokens}
          onChange={(e) => {
            set({ ...draft, tokens: e.target.value });
          }}
        />
      </Field>
    </div>
  );
}

function SkillsStep({
  path,
  setPath,
  repo,
  copied,
  onCopy,
  copying,
  error,
  canInit,
  onInit,
  initing,
}: {
  path: string;
  setPath: (p: string) => void;
  repo: SkillRepo | null;
  copied: string[] | null;
  onCopy: () => void;
  copying: boolean;
  error: string | null;
  canInit: boolean;
  onInit: () => void;
  initing: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm leading-normal text-ink-soft">
        Introspect proposes fixes as changes to the skills and instructions in this git repo, and
        keeps your rubrics in its <code>rubrics/</code> folder.
      </p>
      <Field label="Path to your skills repo">
        <input
          className={FIELD}
          value={path}
          placeholder="~/dev/agent-skills"
          onChange={(e) => {
            setPath(e.target.value);
          }}
        />
      </Field>
      {error ? (
        <p role="alert" className="m-0 text-sm text-fail">
          {error}
        </p>
      ) : null}
      {canInit && !repo ? (
        <Card className="flex flex-col items-start gap-2 border-dashed border-line-dashed bg-surface-alt p-4 text-sm">
          <strong>This folder is empty or not a git repo yet.</strong>
          <span className="text-ink-soft">
            Create a new skills repo here: Introspect runs <code>git init</code>, adds the starter
            rubrics and makes the first commit. Or point to a repo you already have.
          </span>
          <Button variant="primary" onClick={onInit} disabled={initing}>
            {initing ? 'Creating…' : 'Create a new skills repo here'}
          </Button>
        </Card>
      ) : null}
      {repo && !repo.hasRubrics ? (
        <Card className="flex flex-col items-start gap-2 border-dashed border-line-dashed bg-surface-alt p-4 text-sm">
          <strong>No rubrics/ folder in this repo yet.</strong>
          <span className="text-ink-soft">
            Copy the 4 starter rubrics (Efficiency, Redundant tests, Verbosity, Silent workaround)
            to get going, or continue without.
          </span>
          <Button variant="primary" onClick={onCopy} disabled={copying}>
            {copying ? 'Copying…' : 'Copy 4 starter rubrics'}
          </Button>
        </Card>
      ) : null}
      {copied ? (
        <p role="status" className="m-0 text-sm text-pass">
          ✓ Copied {copied.length} starter rubrics to {repo?.path}/rubrics/.
        </p>
      ) : repo?.hasRubrics ? (
        <p role="status" className="m-0 text-sm text-pass">
          ✓ Found rubrics/ in this repo.
        </p>
      ) : null}
    </div>
  );
}

function DoneStep() {
  const patch = usePatchSettings();
  const { start, job } = useImport();
  const navigate = useNavigate();
  const started = useRef(false);
  const { mutateAsync: markDone } = patch;
  const { mutate: startImport } = start;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void markDone({ 'setup.completed': true }).then(() => {
      startImport();
    });
  }, [markDone, startImport]);

  const status = job.data?.status;
  useEffect(() => {
    if (status !== 'succeeded') return;
    const t = setTimeout(() => void navigate({ to: '/' }), 1200);
    return () => {
      clearTimeout(t);
    };
  }, [status, navigate]);

  const p = job.data?.progress;
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const failed = patch.isError || start.isError || status === 'failed' || status === 'dead';
  return (
    <div className="flex flex-col gap-3">
      {failed ? (
        <ErrorState
          error={patch.error ?? start.error ?? new Error(job.data?.error ?? 'The import failed.')}
        />
      ) : status === 'succeeded' ? (
        <p role="status" className="m-0 text-sm text-pass">
          ✓ Import finished. Opening Sessions…
        </p>
      ) : (
        <>
          <p role="status" className="m-0 text-sm text-ink-soft">
            Importing your sessions{p ? `: ${String(p.done)} of ${String(p.total)}` : '…'}
          </p>
          <progress
            className="h-2 w-full accent-accent"
            max={100}
            value={pct}
            aria-label="Import progress"
          />
        </>
      )}
      <FailingChecks />
      <p className="m-0 text-sm text-muted">
        Everything is set up. You can open Sessions now; the import keeps running in the background.
      </p>
      <div className="flex justify-end pt-2">
        <Button
          variant="primary"
          disabled={!patch.isSuccess}
          onClick={() => void navigate({ to: '/' })}
        >
          Go to Sessions
        </Button>
      </div>
    </div>
  );
}

export function Setup() {
  const api = useApi();
  const patch = usePatchSettings();
  const [step, setStep] = useState(0);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [judge, setJudge] = useState<JudgeDraft>({
    transport: 'api',
    apiKey: '',
    tokens: String(DEFAULT_BUDGET),
  });
  const [edited, setPath] = useState<string | null>(null);
  const [repo, setRepo] = useState<SkillRepo | null>(null);
  const [copied, setCopied] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const detected = useQuery({ queryKey: ['sources-detected'], queryFn: () => api.detectSources() });
  // Prefill with the first skills repo the server found, until the user types their own.
  const repos = useQuery({
    queryKey: ['skill-repos-detected'],
    queryFn: () => api.detectSkillRepos(),
  });
  const path = edited ?? repos.data?.[0]?.path ?? '';
  const entry = repos.data?.find((r) => r.path === path);
  const canInit = Boolean(entry && (!entry.isGitRepo || entry.isEmpty));
  const qc = useQueryClient();
  const init = useMutation({
    mutationFn: () => api.initGlobalSkillRepo(path.trim()),
    onSuccess: (r) => {
      void invalidateKeys(qc, ['skill-repos', 'rubrics', 'doctor']);
      setError(null);
      setRepo(r);
    },
    onError: (e) => {
      setError(e.message);
    },
  });
  const copy = useMutation({
    mutationFn: () => api.copyStarterRubrics(),
    onSuccess: (r) => {
      void invalidateKeys(qc, ['skill-repos', 'rubrics', 'doctor']);
      setCopied(r.copied);
      setRepo((x) => (x ? { ...x, hasRubrics: true } : x));
    },
    onError: (e) => {
      setError(e.message);
    },
  });

  const next = () => {
    setError(null);
    setStep((s) => s + 1);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (step === 0) {
        for (const d of detected.data ?? [])
          if (!unticked.has(d.path)) await api.addSource({ agent: d.agent, path: d.path });
      } else if (step === 1) {
        if (judge.transport === 'api' && judge.apiKey.trim())
          await api.putJudgeKey(judge.apiKey.trim());
        const tokens = Number(judge.tokens);
        await patch.mutateAsync({
          'judge.transport': judge.transport,
          'budget.mode': 'tokens_day',
          'budget.tokens_per_day': Number.isFinite(tokens) && tokens > 0 ? tokens : DEFAULT_BUDGET,
        });
      } else if (step === 2 && path.trim() && !repo) {
        const r = await api.putGlobalSkillRepo(path.trim());
        setRepo(r);
        return r;
      }
      return null;
    },
    onSuccess: (r) => {
      void invalidateKeys(qc, ['sources', 'settings', 'skill-repos', 'doctor']);
      // After applying a repo without rubrics, stay so the user sees the starter-rubrics offer.
      if (step === 2 && r && !r.hasRubrics) return;
      next();
    },
    onError: (e) => {
      setError(e.message);
    },
  });

  const body = [
    <SourcesStep
      key="s"
      unticked={unticked}
      toggle={(p) => {
        const n = new Set(unticked);
        if (!n.delete(p)) n.add(p);
        setUnticked(n);
      }}
    />,
    <JudgeStep key="j" draft={judge} set={setJudge} />,
    <SkillsStep
      key="k"
      path={path}
      setPath={(p) => {
        setPath(p);
        setRepo(null);
        setCopied(null);
      }}
      repo={repo}
      copied={copied}
      onCopy={() => {
        copy.mutate();
      }}
      copying={copy.isPending}
      error={error}
      canInit={canInit}
      onInit={() => {
        init.mutate();
      }}
      initing={init.isPending}
    />,
    <DoneStep key="d" />,
  ][step];

  return (
    <div className="flex min-h-screen items-start justify-center bg-page px-4 py-12 text-ink">
      <div className="flex w-full max-w-[640px] flex-col gap-6">
        <div className="flex flex-col gap-1">
          <div className="text-base font-bold">Introspect · local</div>
          <p className="m-0 text-sm text-muted">
            Four quick steps. Every step has a default, and you can skip any of them.
          </p>
        </div>
        <ol aria-label="Setup progress" className="m-0 flex list-none gap-2 p-0 text-[13px]">
          {STEPS.map((name, i) => (
            <li
              key={name}
              aria-current={i === step ? 'step' : undefined}
              className={`flex-1 rounded-full border px-3 py-1.5 text-center ${i === step ? 'border-accent bg-accent-soft font-semibold text-ink' : i < step ? 'border-pass-line bg-pass-bg text-pass' : 'border-line bg-surface text-muted'}`}
            >
              {i + 1}. {name}
            </li>
          ))}
        </ol>
        <Card className="flex flex-col gap-4 p-6">
          <h1 ref={heading} tabIndex={-1} className="m-0 text-[22px] font-bold outline-none">
            {
              [
                'Where are your sessions?',
                'How should sessions be graded?',
                'Where do your skills live?',
                'Importing your history',
              ][step]
            }
          </h1>
          {body}
          {error && step !== 2 ? (
            <p role="alert" className="m-0 text-sm text-fail">
              {error}
            </p>
          ) : null}
          {step < 3 ? (
            <div className="flex items-center justify-between gap-2 pt-2">
              <Button
                disabled={step === 0}
                onClick={() => {
                  setError(null);
                  setStep(step - 1);
                }}
              >
                Back
              </Button>
              <div className="flex gap-2">
                <Button onClick={next}>Skip</Button>
                <Button
                  variant="primary"
                  disabled={save.isPending}
                  onClick={() => {
                    save.mutate();
                  }}
                >
                  {save.isPending
                    ? 'Saving…'
                    : step === 2 && path.trim() && !repo
                      ? canInit
                        ? 'Use an existing repo'
                        : 'Use this folder'
                      : 'Continue'}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
