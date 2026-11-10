import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App.js';
import { createMockApi } from '../api/mock.js';
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

  it('shows a Person column and filter when more than one person has sessions', async () => {
    const user = userEvent.setup();
    renderApp('/?result=all');
    const row = (await screen.findByRole('link', { name: 'Bump dependencies' })).closest('tr');
    expect(await screen.findByRole('columnheader', { name: 'Person' })).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Ada')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Person'), 'Ada');
    expect(await screen.findByRole('link', { name: 'Bump dependencies' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Fix flaky e2e login test' })).toBeNull();
    });
  });

  it('shows no Person column or filter when only one person has sessions', async () => {
    const api = createMockApi('graded', 0);
    const listPeople: typeof api.listPeople = async () => (await api.listPeople()).slice(0, 1);
    render(
      <App
        api={{ ...api, listPeople }}
        history={createMemoryHistory({ initialEntries: ['/?result=all'] })}
      />,
    );
    await screen.findByRole('link', { name: 'Bump dependencies' });
    expect(screen.queryByRole('columnheader', { name: 'Person' })).toBeNull();
    expect(screen.queryByLabelText('Person')).toBeNull();
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
    expect(await screen.findByText(/Daily token budget used up/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Grade selected (1)' }));
    expect(screen.getByText(/uses about .* tokens; 0 left today/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Grade all anyway/ }));
    expect(await screen.findByText(/Deferred: the daily token budget/)).toBeInTheDocument();
  });

  it('asks before a batch that does not fit the budget, and can grade only what fits', async () => {
    const user = userEvent.setup();
    renderApp('/', 'graded');
    await screen.findByRole('link', { name: 'Add OAuth to API service' });
    await user.click(screen.getByRole('checkbox', { name: 'Select all loaded sessions' }));
    await user.click(screen.getByRole('button', { name: /^Grade selected/ }));
    // Mock: 4 rubrics x 60k = 240k per session, 880k left.
    expect(screen.getByText(/About 3 sessions fit\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Grade 3 that fit' }));
    expect(await screen.findByText('Graded.', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('shows short display names for rubric slugs in the table headers', async () => {
    renderApp('/');
    const table = await screen.findByRole('table', { name: 'Sessions' });
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads.slice(-4)).toEqual(['Efficiency', 'Tests', 'Verbosity', 'Workaround']);
    expect(within(table).getByRole('columnheader', { name: 'Tests' })).toHaveAttribute(
      'title',
      'Redundant tests',
    );
    expect(screen.getByText('Silent workaround · pass rate')).toBeInTheDocument();
  });

  it('drives the summary and the table from one period, 7 days by default', async () => {
    const user = userEvent.setup();
    renderApp('/?result=all');
    expect(await screen.findByText(/^Last 7 days · \d+ sessions collected/)).toBeInTheDocument();
    const week = (await screen.findAllByRole('checkbox', { name: /^Select (?!all)/ })).length;
    expect(screen.getByLabelText('Period')).toHaveValue('7');
    await user.selectOptions(screen.getByLabelText('Period'), 'all');
    expect(await screen.findByText(/^All time · \d+ sessions collected/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox', { name: /^Select (?!all)/ }).length).toBeGreaterThan(
        week,
      );
    });
    // The summary counts what the table lists.
    const all = screen.getAllByRole('checkbox', { name: /^Select (?!all)/ }).length;
    expect(screen.getByText(new RegExp(`· ${String(all)} sessions collected`))).toBeInTheDocument();
  });
});
