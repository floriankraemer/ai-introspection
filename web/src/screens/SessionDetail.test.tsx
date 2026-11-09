import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';

describe('Session detail', () => {
  it('marks a stale grade and names the model that answered when it differs', async () => {
    renderApp('/sessions/sess-1');
    const grades = await screen.findByRole('complementary', { name: 'Grades' });
    expect(await within(grades).findByText('stale — re-grading')).toBeInTheDocument();
    expect(within(grades).getByText('answered by claude-haiku-4-5')).toBeInTheDocument();
    expect(within(grades).getAllByText(/answered by/)).toHaveLength(1);
  });

  it('renders the header and a trace with collapsed failure runs and collapsible payloads', async () => {
    const user = userEvent.setup();
    renderApp('/sessions/sess-1');
    expect(
      await screen.findByRole('heading', { name: 'Add OAuth to API service' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/PR #128 merged/)).toBeInTheDocument();

    const trace = await screen.findByRole('region', { name: 'Trace' });
    expect(
      await within(trace).findByRole('button', { name: /9 more failed bash calls/ }),
    ).toBeInTheDocument();
    expect(within(trace).getAllByText('bash ✕').length).toBe(2 + 3);

    await user.click(within(trace).getByRole('button', { name: /9 more failed bash calls/ }));
    expect(within(trace).getAllByText('bash ✕').length).toBe(14);

    // Payloads sit in native <details>, closed by default.
    const firstDetails = trace.querySelector('details');
    expect(firstDetails).not.toHaveAttribute('open');
    await user.click(within(firstDetails as HTMLElement).getByText('Payload'));
    expect(firstDetails).toHaveAttribute('open');
  });

  it('filters to errors', async () => {
    const user = userEvent.setup();
    renderApp('/sessions/sess-1');
    await user.click(await screen.findByRole('button', { name: 'Errors (14)' }));
    const trace = screen.getByRole('region', { name: 'Trace' });
    expect(await within(trace).findAllByText('bash ✕')).not.toHaveLength(0);
    expect(within(trace).queryByText('user')).not.toBeInTheDocument();
  });

  it('shows a not-found state with the way back', async () => {
    renderApp('/sessions/nope');
    expect(await screen.findByText('Session not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Sessions' })).toBeInTheDocument();
  });

  it('shows each grade with score, reason, judge model and the untrusted marker', async () => {
    renderApp('/sessions/sess-1');
    const grades = await screen.findByRole('complementary', { name: 'Grades' });
    expect(
      await within(grades).findByRole('heading', { name: 'Grades · judge: claude-sonnet-5-5' }),
    ).toBeInTheDocument();
    expect(within(grades).getAllByText('0.2 · Fail')).toHaveLength(2);
    expect(within(grades).getByText(/Spent ~7 min probing ports/)).toBeInTheDocument();
    expect(within(grades).getAllByText(/claude-sonnet-5-5 · API/).length).toBeGreaterThan(0);
    // Efficiency (7 / 10) and Silent workaround (6 / 10) have not passed the gate; they carry the marker.
    expect(within(grades).getAllByText('untrusted')).toHaveLength(2);
    expect(within(grades).getByText('0.8 · Pass')).toBeInTheDocument();
  });

  it('highlights the evidence events of a grade in the trace', async () => {
    const user = userEvent.setup();
    renderApp('/sessions/sess-1');
    const trace = await screen.findByRole('region', { name: 'Trace' });
    expect(screen.getByRole('button', { name: 'Evidence only' })).toBeEnabled();
    await user.click(await screen.findByRole('button', { name: 'Show 2 evidence events' }));
    expect(screen.getByRole('button', { name: 'Evidence only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => {
      expect(trace.querySelectorAll('[data-evidence]')).toHaveLength(2);
    });
    // 12 evidence events of Efficiency are listed; the 11 failed probes fold into a run first.
    expect(screen.getByText(/Highlighted: evidence for Silent workaround/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 12 evidence events' }));
    await waitFor(() => {
      expect(trace.querySelectorAll('[data-evidence]')).toHaveLength(12);
    });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(trace.querySelectorAll('[data-evidence]')).toHaveLength(0);
  });

  it('records "Judge was wrong" as a calibration label', async () => {
    const user = userEvent.setup();
    renderApp('/sessions/sess-1');
    const grades = await screen.findByRole('complementary', { name: 'Grades' });
    const wrong = await within(grades).findAllByRole('button', { name: 'Judge was wrong…' });
    await user.click(wrong[0] ?? grades);
    // The judge failed it, so the verdict starts on Pass.
    expect(within(grades).getByLabelText('Pass')).toBeChecked();
    await user.type(within(grades).getByLabelText('Note'), 'Probing was needed');
    await user.click(within(grades).getByRole('button', { name: 'Save label' }));
    expect(await within(grades).findByText(/Label saved/)).toBeInTheDocument();
  });

  it('refreshes the trusted flag after a label tips the rubric over the gate', async () => {
    const user = userEvent.setup();
    renderApp('/sessions/sess-1');
    const grades = await screen.findByRole('complementary', { name: 'Grades' });
    const before = (await within(grades).findAllByText('untrusted')).length;
    const wrong = await within(grades).findAllByRole('button', { name: 'Judge was wrong…' });
    await user.click(wrong[0] ?? grades);
    // Efficiency is at 7 / 10; agreeing with the judge's Fail makes 8 / 10.
    await user.click(within(grades).getByLabelText('Fail'));
    await user.click(within(grades).getByRole('button', { name: 'Save label' }));
    await waitFor(() => {
      expect(within(grades).getAllByText('untrusted')).toHaveLength(before - 1);
    });
  });

  it('re-grades and reports the job until it finishes', async () => {
    const user = userEvent.setup();
    renderApp('/sessions/sess-1');
    await user.click(await screen.findByRole('button', { name: 'Re-grade' }));
    expect(await screen.findByText('Graded.', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('shows a deferred re-grade as over budget', async () => {
    const user = userEvent.setup();
    renderApp('/sessions/sess-1', 'overbudget');
    await user.click(await screen.findByRole('button', { name: 'Re-grade' }));
    expect(await screen.findByText(/Deferred: the daily token budget/)).toBeInTheDocument();
  });

  it('keeps Evidence only disabled and explains the empty grades of an ungraded session', async () => {
    renderApp('/sessions/sess-1', 'ungraded');
    expect(await screen.findByText('Not graded yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Evidence only' })).toBeDisabled();
  });
});
