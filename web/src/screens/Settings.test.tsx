import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test-utils.js';

describe('Settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('confirms inline before allowing executable files, and turns it off without asking', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const toggle = await screen.findByRole('checkbox', {
      name: /Allow hooks, settings and scripts for ~\/dev\/agent-skills/,
    });
    expect(toggle).not.toBeChecked();
    expect(screen.getAllByText(/Claude Code executes these files/)).not.toHaveLength(0);
    await user.click(toggle);
    const ask = await screen.findByRole('alertdialog');
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Allow' }),
    );
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });
  });

  it('autosaves the trends window and explains the per-rubric test', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const days = await screen.findByLabelText('Compare windows of (days)');
    expect(days).toHaveValue(7);
    expect(screen.getByLabelText('Minimum graded sessions per side')).toHaveValue(10);
    expect(screen.getByText(/Fisher’s exact test for small samples/)).toBeVisible();
    await user.clear(days);
    await user.type(days, '99');
    await user.tab();
    expect(screen.getByText('Enter a number from 1 to 60.')).toBeVisible();
    await user.clear(days);
    await user.type(days, '14');
    await user.tab();
    expect(await screen.findByText('All changes saved.')).toBeVisible();
  });

  it('shows defaults, autosaves a change and keeps team mode disabled', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    expect(await screen.findByLabelText('Keep event payloads for (days)')).toHaveValue(90);
    expect(screen.getByLabelText('Daily token budget')).toHaveValue(1_000_000);
    expect(screen.getByLabelText('Accept a proposal by')).toHaveValue('merge');
    expect(screen.getByLabelText('Server URL')).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Budget'), 'usd_month');
    expect(await screen.findByLabelText('Monthly ceiling (USD)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Daily token budget')).not.toBeInTheDocument();
    expect(await screen.findByText('All changes saved.')).toBeInTheDocument();
  });

  it('shows the container login state and command when the judge runs via the CLI', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    await user.selectOptions(await screen.findByLabelText('Runs via'), 'cli');
    const login = await screen.findByRole('group', { name: 'Claude login' });
    expect(await within(login).findByText('Logged in')).toBeInTheDocument();
    expect(login).toHaveTextContent('Logged in to Claude inside the container.');
    expect(login).not.toHaveTextContent('credentials');
  });

  it('tells you to run make claude-login when the container is not logged in', async () => {
    const user = userEvent.setup();
    renderApp('/settings', 'ungraded');
    await user.selectOptions(await screen.findByLabelText('Runs via'), 'cli');
    const login = await screen.findByRole('group', { name: 'Claude login' });
    expect(await within(login).findByText('Not logged in')).toBeInTheDocument();
    expect(within(login).getByText('make claude-login')).toBeInTheDocument();
  });

  it('rejects a retention below the minimum', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const input = await screen.findByLabelText('Keep event payloads for (days)');
    await user.clear(input);
    await user.type(input, '3');
    expect(await screen.findByText('Enter a number of at least 7.')).toBeInTheDocument();
  });

  it('shows the health check and runs it again', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    expect(await screen.findByText('Everything works.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run again' }));
    expect(await screen.findByText('Everything works.')).toBeInTheDocument();
  });

  it('saves custom redaction patterns and rejects an invalid regex', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const box = await screen.findByLabelText('Extra redaction patterns');
    await user.type(box, 'acme_[[a-z]+(');
    await user.tab();
    expect(await screen.findByText(/Not a valid regular expression/)).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'acme_[[a-z]+');
    await user.tab();
    expect(await screen.findByText('All changes saved.')).toBeInTheDocument();
  });

  it('shows how much of the token budget is used, and flags an exhausted one', async () => {
    renderApp('/settings');
    expect(await screen.findByText('Used 120k of 1M tokens today.')).toBeInTheDocument();
  });

  it('says grading is deferred when the daily budget is used up', async () => {
    renderApp('/settings', 'overbudget');
    expect(
      await screen.findByText(/Used 1M of 1M tokens today\. Grading is deferred/),
    ).toBeInTheDocument();
  });

  it('overrides the accept mode per repo and adds a project repo', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const mode = await screen.findByLabelText('Accept mode for ~/dev/agent-skills');
    await user.selectOptions(mode, 'pr');
    expect(await screen.findByLabelText('Accept mode for ~/dev/agent-skills')).toHaveValue('pr');
    expect(screen.getByText(/^Next run /)).toBeVisible();

    const add = screen.getByRole('button', { name: 'Add project repo' });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('Project repo path'), 'nope');
    await user.click(add);
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an absolute path');
    await user.clear(screen.getByLabelText('Project repo path'));
    await user.type(screen.getByLabelText('Project repo path'), '~/projects/api');
    await user.click(add);
    expect(await screen.findByLabelText('Accept mode for ~/projects/api')).toHaveValue('');
  });

  it('shows what the improver used inside the budget line', async () => {
    renderApp('/settings');
    expect(await screen.findByText(/The improver used 48k tokens today/)).toBeVisible();
  });
});
