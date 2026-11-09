import { useDoctor } from '../api/queries.js';
import { Button, Chip } from './ui.js';

/** CLI transport: the login lives in the container, so show what the doctor found and how to log in. */
export function CliLogin() {
  const doctor = useDoctor();
  const check = doctor.data?.checks.find((c) => c.id === 'judge');
  const ok = check?.status === 'ok';
  return (
    <div
      aria-label="Claude login"
      role="group"
      className="flex flex-col gap-1.5 rounded-lg border border-line-soft bg-surface-alt p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>Claude login in the container</strong>
        {doctor.isPending ? (
          <span className="text-muted">Checking…</span>
        ) : doctor.isError || !check ? (
          <Chip>Unknown</Chip>
        ) : (
          <Chip tone={ok ? 'pass' : check.status === 'fail' ? 'fail' : 'warn'}>
            {ok ? 'Logged in' : 'Not logged in'}
          </Chip>
        )}
        <Button
          className="ml-auto h-10"
          disabled={doctor.isFetching}
          onClick={() => void doctor.refetch()}
        >
          {doctor.isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      {check ? <p className="m-0 text-muted">{check.detail}</p> : null}
      {ok ? null : (
        <p className="m-0 text-ink-soft">
          To log in, run <code>make claude-login</code> in your project folder, then press Check
          again.
        </p>
      )}
    </div>
  );
}
