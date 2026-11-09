import { Link } from '@tanstack/react-router';
import { useBudget } from '../api/queries.js';
import { exhaustedUntil } from '../lib/budget.js';

/** Shown on Sessions and Proposals while the budget is used up: grading and the improver wait. */
export function BudgetBanner() {
  const b = useBudget().data;
  const until = b ? exhaustedUntil(b) : null;
  if (!b || !until) return null;
  const which =
    b.tokensPerDay !== null && b.tokensToday >= b.tokensPerDay
      ? 'Daily token budget'
      : 'Monthly dollar budget';
  return (
    <p
      role="status"
      className="m-0 rounded-lg border border-warn-line bg-warn-bg px-3 py-2.5 leading-normal text-warn"
    >
      {which} used up — grading and the improver resume at {new Date(until).toLocaleString()} or
      raise it in <Link to="/settings">Settings › Judge and budget</Link>.
    </p>
  );
}
