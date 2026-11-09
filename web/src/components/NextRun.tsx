import { useImproverSchedule } from '../api/queries.js';

/** "Next run Tue 06:00", or why there is none. Renders nothing until the schedule has loaded. */
export function NextRun({ className = '' }: { className?: string }) {
  const q = useImproverSchedule();
  if (!q.data) return null;
  const { mode, nextRunAt } = q.data;
  const text =
    mode === 'manual' || !nextRunAt
      ? 'Next run: none scheduled. The improver only runs when you start it.'
      : `Next run ${new Date(nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`;
  return <p className={`m-0 text-[13px] text-muted ${className}`}>{text}</p>;
}
