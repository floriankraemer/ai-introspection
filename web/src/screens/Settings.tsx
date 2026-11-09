import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useApi } from '../api/context.js';
import { usePatchSettings, useSettings, useSkillRepos, useSources } from '../api/queries.js';
import type { Agent, Settings as SettingsData, SourceStatus } from '../api/types.js';
import { HealthCheck } from '../components/HealthCheck.js';
import { JudgeTest } from '../components/JudgeTest.js';
import {
  BTN,
  Button,
  Chip,
  ErrorState,
  Field,
  FIELD,
  Loading,
  PageHeader,
  type ChipTone,
} from '../components/ui.js';

type Writable = Omit<SettingsData, 'judge.api_key_set'>;
type Patch = Partial<Writable>;

const SECTION = 'flex flex-col gap-3 rounded-xl border border-line bg-surface p-[18px]';
const H2 = 'm-0 text-base font-semibold';

const STATUS: Record<SourceStatus, [string, ChipTone]> = {
  watching: ['Watching', 'pass'],
  polling: ['Polling', 'pass'],
  disabled: ['Disabled', 'na'],
  missing: ['Not found', 'fail'],
};

function Select<K extends keyof Writable>({
  label,
  name,
  settings,
  save,
  options,
}: {
  label: string;
  name: K;
  settings: SettingsData;
  save: (p: Patch) => void;
  options: [Writable[K] & string, string][];
}) {
  return (
    <Field label={label}>
      <select
        className={FIELD}
        value={String(settings[name])}
        onChange={(e) => {
          save({ [name]: e.target.value });
        }}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Number input that commits on blur (autosave per field, no Save button in the mockup). */
function NumberSetting({
  label,
  hint,
  value,
  min,
  onCommit,
  placeholder,
}: {
  label: string;
  hint?: ReactNode;
  value: number | null;
  min: number;
  onCommit: (n: number | null) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const parsed = draft.trim() === '' ? null : Number(draft);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < min);
  return (
    <Field
      label={label}
      hint={invalid ? <span className="text-fail">Enter a number of at least {min}.</span> : hint}
    >
      <input
        type="number"
        inputMode="numeric"
        min={min}
        className={FIELD}
        value={draft}
        placeholder={placeholder}
        aria-invalid={invalid}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={() => {
          if (!invalid && parsed !== value) onCommit(parsed);
        }}
      />
    </Field>
  );
}

/** One regular expression per line; applied at ingest on top of the built-in secret patterns. */
function PatternsSetting({
  value,
  onCommit,
}: {
  value: string[];
  onCommit: (v: string[]) => void;
}) {
  const [text, setText] = useState(value.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const bad = lines.find((l) => {
      try {
        new RegExp(l, 'u');
        return false;
      } catch {
        return true;
      }
    });
    if (bad !== undefined) {
      setError(`Not a valid regular expression: ${bad}`);
      return;
    }
    setError(null);
    if (lines.join('\n') !== value.join('\n')) onCommit(lines);
  };
  return (
    <Field
      label="Extra redaction patterns"
      hint={
        error ? (
          <span role="alert" className="text-fail">
            {error}
          </span>
        ) : (
          'One regular expression per line (up to 50). Matches are replaced before anything is stored.'
        )
      }
    >
      <textarea
        rows={3}
        spellCheck={false}
        placeholder="acme_[a-z0-9]{32}"
        className={`${FIELD} h-auto py-2 font-mono`}
        value={text}
        aria-invalid={error !== null}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onBlur={commit}
      />
    </Field>
  );
}

function SourcesCard({ settings, save }: { settings: SettingsData; save: (p: Patch) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const sources = useSources();
  const [adding, setAdding] = useState(false);
  const [agent, setAgent] = useState<Agent>('claude_code');
  const [path, setPath] = useState('');
  const add = useMutation({
    mutationFn: () => api.addSource({ agent, path: path.trim() }),
    onSuccess: async () => {
      setAdding(false);
      setPath('');
      await qc.invalidateQueries({ queryKey: ['sources'] });
    },
  });
  return (
    <section aria-label="Sources" className={SECTION}>
      <h2 className={H2}>Sources</h2>
      {sources.isPending ? <Loading /> : null}
      {sources.isError ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : null}
      {sources.data?.length === 0 ? (
        <p className="m-0 text-sm text-ink-soft">
          No source folders yet. Add the folder where your agent writes its session logs, for
          example <code>~/.claude/projects</code>.
        </p>
      ) : null}
      {sources.data?.map((s) => {
        const [text, tone] = STATUS[s.status];
        return (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 border-b border-line-soft py-2.5"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-sm">{s.agent === 'codex' ? 'Codex' : 'Claude Code'}</strong>
              <code className="break-all text-muted">{s.path}</code>
            </div>
            <Chip tone={tone}>{text}</Chip>
          </div>
        );
      })}
      {adding ? (
        <form
          className="flex flex-col gap-3 rounded-lg border border-line-soft p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) add.mutate();
          }}
        >
          <Field label="Agent">
            <select
              className={FIELD}
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value as Agent);
              }}
            >
              <option value="claude_code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </Field>
          <Field label="Folder path">
            <input
              className={FIELD}
              value={path}
              placeholder="~/.claude/projects"
              onChange={(e) => {
                setPath(e.target.value);
              }}
            />
          </Field>
          {add.isError ? <p className="m-0 text-sm text-fail">{add.error.message}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={add.isPending || !path.trim()}>
              Add folder
            </Button>
            <Button
              onClick={() => {
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="dashed"
          className="self-start"
          onClick={() => {
            setAdding(true);
          }}
        >
          + Add source folder
        </Button>
      )}
      <label className="flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          className="size-[18px]"
          checked={settings['redaction.enabled']}
          onChange={(e) => {
            save({ 'redaction.enabled': e.target.checked });
          }}
        />
        Redact secrets at ingest (tokens, keys, .env values)
      </label>
      <PatternsSetting
        value={settings['redaction.custom_patterns']}
        onCommit={(v) => {
          save({ 'redaction.custom_patterns': v });
        }}
      />
      <NumberSetting
        label="Keep event payloads for (days)"
        hint="Minimum 7. Sessions, signals and grades are kept; pinned sessions are never purged."
        value={settings['retention.days']}
        min={7}
        onCommit={(n) => {
          if (n !== null) save({ 'retention.days': n });
        }}
      />
    </section>
  );
}

function JudgeCard({ settings, save }: { settings: SettingsData; save: (p: Patch) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const saveKey = useMutation({
    mutationFn: () => api.putJudgeKey(key.trim()),
    onSuccess: async () => {
      setKey('');
      await qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const mode = settings['budget.mode'];
  return (
    <section aria-label="Judge" className={SECTION}>
      <h2 className={H2}>Judge and sampling</h2>
      <Select
        label="Runs via"
        name="judge.transport"
        settings={settings}
        save={save}
        options={[
          ['api', 'Anthropic API key'],
          ['cli', 'Local claude CLI (headless)'],
        ]}
      />
      {settings['judge.transport'] === 'api' ? (
        <Field
          label="Anthropic API key"
          hint={
            settings['judge.api_key_set']
              ? 'A key is saved on this machine. Paste a new one to replace it.'
              : 'No key saved yet. It stays on this machine.'
          }
        >
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD} min-w-0 flex-1`}
              placeholder="sk-ant-…"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
              }}
            />
            <Button
              disabled={!key.trim() || saveKey.isPending}
              onClick={() => {
                saveKey.mutate();
              }}
              className="h-10"
            >
              Save key
            </Button>
          </div>
          {saveKey.isError ? <span className="text-fail">{saveKey.error.message}</span> : null}
        </Field>
      ) : null}
      <JudgeTest transport={settings['judge.transport']} apiKey={key.trim()} />
      <Select
        label="Grade"
        name="judge.sampling"
        settings={settings}
        save={save}
        options={[
          ['flagged_sample', 'Flagged sessions + 20% random sample'],
          ['every', 'Every session'],
        ]}
      />
      <Select
        label="Budget"
        name="budget.mode"
        settings={settings}
        save={save}
        options={[
          ['tokens_day', 'Tokens per day'],
          ['tokens_day_and_usd_month', 'Tokens per day + monthly dollar ceiling'],
          ['usd_month', 'Monthly dollar ceiling only'],
        ]}
      />
      {mode !== 'usd_month' ? (
        <NumberSetting
          key="tokens"
          label="Daily token budget"
          value={settings['budget.tokens_per_day']}
          min={1}
          onCommit={(n) => {
            save({ 'budget.tokens_per_day': n });
          }}
        />
      ) : null}
      {mode !== 'tokens_day' ? (
        <NumberSetting
          key="usd"
          label="Monthly ceiling (USD)"
          value={settings['budget.usd_per_month']}
          min={1}
          onCommit={(n) => {
            save({ 'budget.usd_per_month': n });
          }}
        />
      ) : null}
    </section>
  );
}

function ScheduleCard({ settings, save }: { settings: SettingsData; save: (p: Patch) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const repos = useSkillRepos();
  const global = repos.data?.find((r) => r.kind === 'global');
  const [path, setPath] = useState<string | null>(null);
  const shown = path ?? global?.path ?? '';
  const put = useMutation({
    mutationFn: (p: string) => api.putGlobalSkillRepo(p),
    onSuccess: async () => {
      setPath(null);
      await qc.invalidateQueries({ queryKey: ['skill-repos'] });
    },
  });
  const projects = repos.data?.filter((r) => r.kind === 'project') ?? [];
  return (
    <section aria-label="Schedule" className={SECTION}>
      <h2 className={H2}>Schedule</h2>
      <Select
        label="Grade sessions"
        name="schedule.grade"
        settings={settings}
        save={save}
        options={[
          ['session_end', 'When a session ends'],
          ['pr_merge', 'When its PR merges'],
        ]}
      />
      <Select
        label="Run improver"
        name="schedule.improver"
        settings={settings}
        save={save}
        options={[
          ['daily', 'Daily at 06:00'],
          ['weekly', 'Weekly, Monday 06:00'],
          ['manual', 'Manually'],
        ]}
      />
      <Field
        label="Skills repo for patches"
        hint={
          put.isError ? (
            <span className="text-fail">{put.error.message}</span>
          ) : global && !global.hasRubrics ? (
            'This folder has no rubrics/ folder yet. Run the setup wizard to copy the starter rubrics.'
          ) : null
        }
      >
        <input
          className={FIELD}
          value={shown}
          placeholder="~/dev/agent-skills"
          onChange={(e) => {
            setPath(e.target.value);
          }}
          onBlur={() => {
            if (path?.trim() && path !== global?.path) put.mutate(path.trim());
          }}
        />
      </Field>
      <Select
        label="Accept a proposal by"
        name="proposals.accept_mode"
        settings={settings}
        save={save}
        options={[
          ['merge', 'Merging locally'],
          ['pr', 'Opening a pull request'],
        ]}
      />
      {projects.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {projects.map((r) => (
            <li key={r.id} className="flex justify-between gap-3">
              <code className="break-all">{r.path}</code>
              <Chip>{r.enabled ? 'Enabled' : 'Disabled'}</Chip>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function TeamCard() {
  return (
    <section
      aria-label="Team mode"
      className="flex flex-col gap-3 rounded-xl border border-dashed border-line-dashed bg-surface-alt p-[18px]"
    >
      <div className="flex items-center justify-between">
        <h2 className={H2}>Team mode</h2>
        <Chip>Phase 5</Chip>
      </div>
      <p className="m-0 text-sm leading-normal text-ink-soft">
        Ship redacted traces to a shared server. Grades, proposals and trends then cover the whole
        team; proposals open as PRs.
      </p>
      <Field label="Server URL">
        <input type="url" className={FIELD} placeholder="https://loop.your-company.dev" disabled />
      </Field>
      <label className="flex items-center gap-2.5 text-sm text-muted">
        <input type="checkbox" className="size-[18px]" disabled />
        Share my sessions with the workspace
      </label>
      <Button disabled className="self-start bg-sunken text-muted">
        Connect with SSO
      </Button>
    </section>
  );
}

export function Settings() {
  const q = useSettings();
  const patch = usePatchSettings();
  if (q.isPending) return <Loading label="Loading settings" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const save = (p: Patch) => {
    patch.mutate(p);
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Settings"
        actions={
          <Link to="/setup" className={BTN.secondary}>
            Run setup wizard
          </Link>
        }
      />
      <p role="status" className="m-0 -mt-3 text-sm text-muted empty:hidden">
        {patch.isPending ? (
          'Saving…'
        ) : patch.isError ? (
          <span className="text-fail">Could not save: {patch.error.message}</span>
        ) : patch.isSuccess ? (
          'All changes saved.'
        ) : (
          ''
        )}
      </p>
      <HealthCheck />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SourcesCard settings={q.data} save={save} />
        <JudgeCard settings={q.data} save={save} />
        <ScheduleCard settings={q.data} save={save} />
        <TeamCard />
      </div>
    </div>
  );
}
