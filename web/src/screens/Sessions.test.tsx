import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';

describe('Sessions', () => {
  it('shows pass-rate cards, tool errors and rubric chips; defaults to failed sessions', async () => {
    renderApp('/');
    expect(await screen.findByText('Efficiency · pass rate')).toBeInTheDocument();
    expect(screen.getByText('below 70% target')).toBeInTheDocument();
    const row = (await screen.findByRole('link', { name: 'Add OAuth to API service' })).closest(
      'tr',
    );
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('14')).toBeInTheDocument();
    expect(within(row as HTMLElement).getAllByText('Fail')).toHaveLength(3);
    expect(screen.queryByRole('link', { name: 'Bump dependencies' })).not.toBeInTheDocument();
  });

  it('shows the not-graded state before anything is graded', async () => {
    renderApp('/', 'ungraded');
    expect(await screen.findByText('Not graded yet')).toBeInTheDocument();
    // Result defaults to All when nothing is graded, so rows are visible.
    const row = (await screen.findByRole('link', { name: 'Bump dependencies' })).closest('tr');
    const cell = within(row as HTMLElement).getByText('Not graded');
    expect(cell).toHaveAttribute('title', expect.stringMatching(/Not graded · not flagged/));
  });

  it('filters by search text and offers a way out of an empty result', async () => {
    const user = userEvent.setup();
    renderApp('/', 'ungraded');
    await user.type(await screen.findByLabelText('Search'), 'zzz');
    expect(await screen.findByText('No sessions match these filters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('link', { name: 'Bump dependencies' })).toBeInTheDocument();
  });

  it('explains the next step when nothing is collected', async () => {
    renderApp('/', 'empty');
    expect(await screen.findByText('No sessions collected yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check source folders' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('grades the selected sessions as one batch', async () => {
    const user = userEvent.setup();
    renderApp('/');
    const grade = await screen.findByRole('button', { name: 'Grade selected' });
    expect(grade).toBeDisabled();
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select Add OAuth to API service' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select Fix flaky e2e login test' }));
    expect(screen.getByRole('checkbox', { name: 'Select all loaded sessions' })).toHaveProperty(
      'indeterminate',
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Grade selected (2)' }));
    expect(await screen.findByText('Graded.', {}, { timeout: 3000 })).toBeInTheDocument();
    // The selection is cleared once the batch is queued.
    expect(screen.getByRole('button', { name: 'Grade selected' })).toBeDisabled();
  });

  it('selects every loaded session from the header checkbox', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('link', { name: 'Add OAuth to API service' });
    await user.click(screen.getByRole('checkbox', { name: 'Select all loaded sessions' }));
    const n = screen.getAllByRole('checkbox', { name: /^Select (?!all)/ }).length;
    expect(screen.getByRole('button', { name: `Grade selected (${String(n)})` })).toBeEnabled();
  });

  it('shows a deferred batch as over budget', async () => {
    const user = userEvent.setup();
    renderApp('/', 'overbudget');
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select Add OAuth to API service' }),
    );
    await user.click(screen.getByRole('button', { name: 'Grade selected (1)' }));
    expect(await screen.findByText(/Deferred: the daily token budget/)).toBeInTheDocument();
  });
});
