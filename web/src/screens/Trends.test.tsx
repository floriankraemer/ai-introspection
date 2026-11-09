import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test-utils.js';

const log = () => screen.findByRole('region', { name: 'Change log' });

describe('Trends', () => {
  // happy-dom has no layout: give the chart container a size, as a browser would.
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe(target: Element) {
          this.cb(
            [{ target, contentRect: { width: 800, height: 320 } } as ResizeObserverEntry],
            this,
          );
        }
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  it('shows the verdict of each change, with before and after', async () => {
    renderApp('/trends');
    const l = within(await log());
    const tooEarly = await l.findByRole('row', { name: /CLAUDE\.md/ });
    const reset = l.getByRole('row', { name: /silent-workaround v2/ });
    const improved = l.getByRole('row', { name: /find dev-server port/ });
    expect(tooEarly).toHaveTextContent('CLAUDE.md: prefer e2e over unit tests for auth');
    expect(within(tooEarly).getByText('Too early — 3 graded since')).toBeVisible();
    expect(tooEarly).toHaveTextContent('64% → 66%');
    expect(reset).toHaveTextContent('baseline reset');
    expect(reset).not.toHaveTextContent('null');
    expect(improved).toHaveTextContent('58% → 72%');
    expect(improved).toHaveTextContent('14 → 18 graded');
    expect(within(improved).getByText('Improved')).toBeVisible();
    expect(within(improved).getByRole('link', { name: 'Proposal' })).toHaveAttribute(
      'href',
      '/proposals',
    );
  });

  it('scopes the chart data to the chosen rubric, range and bucket', async () => {
    const user = userEvent.setup();
    renderApp('/trends');
    const chart = await screen.findByRole('region', { name: 'Pass rate chart' });
    await user.click(within(chart).getByText('Show the data as a table'));
    const table = await within(chart).findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(13); // header + 12 weeks
    expect(within(table).getAllByRole('columnheader')).toHaveLength(5);

    await user.selectOptions(screen.getByLabelText('Rubric'), 'verbosity');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
    expect(within(table).getByRole('columnheader', { name: 'Verbosity' })).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Range'), '4');
    expect(await within(table).findAllByRole('row')).toHaveLength(5);

    await user.click(screen.getByRole('button', { name: 'Days' }));
    expect(screen.getByRole('button', { name: 'Days' })).toHaveAttribute('aria-pressed', 'true');
    expect(await within(table).findAllByRole('row')).toHaveLength(29);
  });

  it('draws a focusable marker for each merged change and each baseline reset', async () => {
    renderApp('/trends');
    const fix = await screen.findByRole('button', {
      name: /^e2e-testing: find dev-server port first/,
    });
    fix.focus();
    expect(await screen.findByRole('group', { name: /e2e-testing/ })).toHaveTextContent(
      'skills/e2e-testing/SKILL.md',
    );
    expect(screen.getByRole('link', { name: 'Open in Proposals' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: /^Baseline reset: Silent workaround/ }),
    ).toBeVisible();
  });

  it('explains empty states and names the next step', async () => {
    renderApp('/trends', 'ungraded');
    expect(await screen.findByText('Not enough graded sessions yet')).toBeVisible();
    expect(await screen.findByText('No changes merged yet')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Proposals' })).toHaveAttribute(
      'href',
      '/proposals',
    );
  });

  it('re-grades the reference set and follows the job', async () => {
    const user = userEvent.setup();
    renderApp('/trends');
    const button = await screen.findByRole('button', { name: 'Re-grade reference set' });
    await user.click(button);
    expect(await screen.findByText(/^Grading…/)).toBeVisible();
    expect(await screen.findByText('Graded.', {}, { timeout: 3000 })).toBeVisible();
    expect(button).toBeEnabled();
  });

  it('shows the reference set count and its sessions', async () => {
    const user = userEvent.setup();
    renderApp('/trends');
    const card = await screen.findByRole('region', { name: 'Reference set' });
    expect(await within(card).findByText('Reference set: 6 of 20')).toBeVisible();
    await user.click(within(card).getByText('Show the sessions'));
    expect(within(card).getAllByRole('link')).toHaveLength(6);
  });

  it('points to adding sessions when the reference set is empty', async () => {
    const user = userEvent.setup();
    renderApp('/trends', 'ungraded');
    await user.click(await screen.findByRole('button', { name: 'Re-grade reference set' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('reference set is empty');
  });

  it('says so when the judge budget defers the re-grade', async () => {
    const user = userEvent.setup();
    renderApp('/trends', 'overbudget');
    await user.click(await screen.findByRole('button', { name: 'Re-grade reference set' }));
    expect(await screen.findByText(/Deferred: the daily token budget/)).toBeVisible();
  });
});
