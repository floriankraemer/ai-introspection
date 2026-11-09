import { Link } from '@tanstack/react-router';
import { BTN, EmptyState, PageHeader } from '../components/ui.js';

const next = (
  <Link to="/" className={BTN.secondary}>
    Back to Sessions
  </Link>
);

export function Trends() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Trends" />
      <EmptyState title="Nothing to chart yet" actions={next}>
        Trends show the weekly pass rate per rubric, with a marker for each accepted fix. They need
        graded sessions, so collect a few days of sessions first.
      </EmptyState>
    </div>
  );
}
