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
    expect(within(row as HTMLElement).getByText(/Not graded · not flagged/)).toBeInTheDocument();
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
});
