import type { Job } from '../api/types.js';

/** One status line for a grade job. Deferred means the budget ran out; it is shown, not hidden. */
export function jobNote(
  job: Job | null,
  failed: boolean,
): { tone: 'busy' | 'warn' | 'ok' | 'fail'; text: string } | null {
  if (failed) return { tone: 'fail', text: 'Grading could not start. Try again in a moment.' };
  if (!job) return null;
  const p = job.progress;
  switch (job.status) {
    case 'queued':
    case 'running':
      return {
        tone: 'busy',
        text: `Grading…${p ? ` ${String(p.done)} / ${String(p.total)}` : ''}`,
      };
    case 'deferred':
      return {
        tone: 'warn',
        text:
          job.error ??
          'Deferred: the judge budget is used up. Grading resumes when the budget resets.',
      };
    case 'succeeded':
      return { tone: 'ok', text: 'Graded.' };
    default:
      return { tone: 'fail', text: `Grading failed: ${job.error ?? 'unknown error'}` };
  }
}

const TONE = { busy: 'text-muted', ok: 'text-pass', warn: 'text-warn', fail: 'text-fail' } as const;

export function JobNote({
  job,
  failed,
  className = '',
}: {
  job: Job | null;
  failed: boolean;
  className?: string;
}) {
  const n = jobNote(job, failed);
  return (
    <p
      role="status"
      className={`m-0 text-[13px] empty:hidden ${n ? TONE[n.tone] : ''} ${className}`}
    >
      {n?.text}
    </p>
  );
}
