import { Link } from '@tanstack/react-router';
import { BTN, EmptyState, PageHeader } from '../components/ui.js';

const next = (
  <Link to="/" className={BTN.secondary}>
    Back to Sessions
  </Link>
);

export function Proposals() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Proposals" />
      <EmptyState title="No proposals yet" actions={next}>
        Once sessions are graded, Introspect drafts fixes for the patterns that keep failing and
        lists them here for you to accept, edit or reject.
      </EmptyState>
    </div>
  );
}

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
