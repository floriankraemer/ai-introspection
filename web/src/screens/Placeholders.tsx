import { Link } from '@tanstack/react-router';
import { BTN, EmptyState, PageHeader } from '../components/ui.js';

const next = (
  <Link to="/" className={BTN.secondary}>
    Back to Sessions
  </Link>
);

export function Rubrics() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Rubrics" />
      <EmptyState title="Rubrics arrive with grading" actions={next}>
        A rubric is a short Markdown file that says what a good session looks like, for example "no
        silent workarounds". They will live in the <code>rubrics/</code> folder of your skills repo,
        and you will edit and calibrate them here. Until then, browse your sessions and their
        traces.
      </EmptyState>
    </div>
  );
}

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
