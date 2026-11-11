import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App } from '../App.js';
import { ApiError } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import type { AddSourceBody, Api } from '../api/types.js';
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
    expect(screen.getByLabelText('Accept proposals by')).toHaveValue('merge');
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
    expect(
      screen.getAllByRole('option', { name: 'Use default (Merging locally)' })[0],
    ).toBeInTheDocument();

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

  it('flips an autosave checkbox at once and reverts it with a message when the save fails', async () => {
    const user = userEvent.setup();
    const mock = createMockApi('graded', 0);
    let fail!: (e: Error) => void;
    const api: Api = {
      ...mock,
      patchSettings: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    };
    render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
    const box = await screen.findByRole('checkbox', { name: /Redact secrets at ingest/ });
    const was = (box as HTMLInputElement).checked;
    await user.click(box);
    // The request is still pending, yet the control already shows the click.
    expect(box).toHaveProperty('checked', !was);
    fail(new Error('Server said no'));
    expect(await screen.findByText(/Could not save: Server said no/)).toBeInTheDocument();
    expect(box).toHaveProperty('checked', was);
  });

  it('badges each source by kind and shows the bucket URL for S3', async () => {
    renderApp('/settings');
    const sources = await screen.findByRole('region', { name: 'Sources' });
    expect(await within(sources).findByText('s3://team-logs/claude/')).toBeVisible();
    expect(within(sources).getAllByText('Folder')).toHaveLength(2);
    expect(within(sources).getByText('S3')).toBeVisible();
    expect(within(sources).getByText('Pushed')).toBeVisible();
    expect(within(sources).getByText('Pushed by Ada')).toBeVisible();
    expect(within(sources).queryByText(/intake\/ada/)).toBeNull();
  });

  it('disables and enables folder and S3 sources; pushed sources have no Disable', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const sources = await screen.findByRole('region', { name: 'Sources' });
    await user.click(await within(sources).findByRole('button', { name: /^Disable ~\/\.codex/ }));
    expect(await within(sources).findByText('Disabled')).toBeVisible();
    await user.click(within(sources).getByRole('button', { name: /^Enable ~\/\.codex/ }));
    await waitFor(() => {
      expect(within(sources).queryByText('Disabled')).toBeNull();
    });
    expect(within(sources).getAllByRole('button', { name: /^Disable / })).toHaveLength(3);
    expect(within(sources).getByRole('button', { name: 'Remove pushed by Ada' })).toBeVisible();
  });

  it('confirms before removing a source, and mentions deleted copies for pushed ones', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const sources = await screen.findByRole('region', { name: 'Sources' });
    const remove = await within(sources).findByRole('button', { name: /^Remove ~\/\.codex/ });
    await user.click(remove);
    const ask = within(sources).getByRole('alertdialog');
    expect(ask).toHaveTextContent('Its 1 session stay in Introspect.');
    expect(ask).not.toHaveTextContent('copied log files');
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(within(sources).queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(remove).toHaveFocus();
    });
    await user.click(within(sources).getByRole('button', { name: 'Remove pushed by Ada' }));
    expect(within(sources).getByRole('alertdialog')).toHaveTextContent(
      'The copied log files are deleted.',
    );
    await user.click(within(sources).getByRole('button', { name: 'Cancel' }));
    await user.click(remove);
    await user.click(
      within(within(sources).getByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => {
      expect(within(sources).queryByText('~/.codex/sessions')).toBeNull();
    });
  });

  it('says when session intake is off', async () => {
    const mock = createMockApi('graded', 0);
    const api: Api = {
      ...mock,
      listIntakeTokens: () => Promise.resolve({ intake: { port: null }, tokens: [] }),
    };
    render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
    const card = await screen.findByRole('region', { name: 'People who push' });
    expect(await within(card).findByText(/Session intake is off/)).toBeVisible();
  });

  it('creates a token, shows it once and hides it after Done', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const card = await screen.findByRole('region', { name: 'People who push' });
    expect(await within(card).findByText('Ada')).toBeVisible();
    expect(within(card).getByText('Active')).toBeVisible();
    await user.click(within(card).getByRole('button', { name: '+ Add person' }));
    await user.type(within(card).getByLabelText('Name'), 'bob');
    expect(within(card).getByLabelText('Expires')).toHaveValue('90');
    await user.click(within(card).getByRole('button', { name: 'Create token' }));
    const token = await within(card).findByDisplayValue('intk_mock_0123456789abcdef');
    expect(token).toHaveAttribute('readonly');
    expect(within(card).getByText(/It is not shown again/)).toBeVisible();
    expect(
      within(card).getByText(/introspect push --server https:\/\/<your-server>:7318/),
    ).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue('intk_mock_0123456789abcdef')).toBeNull();
    expect(screen.queryByText(/intk_mock/)).toBeNull();
    expect(await within(card).findByText('bob')).toBeVisible();
  });

  it('offers another token for the same person when the name is taken', async () => {
    const user = userEvent.setup();
    const mock = createMockApi('graded', 0);
    const createIntakeToken = vi.fn((b: Parameters<Api['createIntakeToken']>[0]) =>
      mock.createIntakeToken(b),
    );
    render(
      <App
        api={{ ...mock, createIntakeToken }}
        history={createMemoryHistory({ initialEntries: ['/settings'] })}
      />,
    );
    const card = await screen.findByRole('region', { name: 'People who push' });
    await user.click(await within(card).findByRole('button', { name: '+ Add person' }));
    await user.type(within(card).getByLabelText('Name'), 'ada');
    await user.selectOptions(within(card).getByLabelText('Expires'), 'Never');
    await user.click(within(card).getByRole('button', { name: 'Create token' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('already has a token');
    await user.click(within(card).getByRole('button', { name: 'Create another token for ada' }));
    expect(await within(card).findByDisplayValue(/intk_mock/)).toBeVisible();
    expect(createIntakeToken).toHaveBeenLastCalledWith({ name: 'ada', samePerson: true });
  });

  it('revokes a token after confirming', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const card = await screen.findByRole('region', { name: 'People who push' });
    await user.click(await within(card).findByRole('button', { name: 'Revoke token ada' }));
    const ask = within(card).getByRole('alertdialog');
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByRole('alertdialog')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Revoke token ada' }));
    await user.click(
      within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Revoke' }),
    );
    expect(await within(card).findByText('Revoked')).toBeVisible();
    expect(within(card).queryByRole('button', { name: /^Revoke token/ })).toBeNull();
    // The Revoke button is gone; focus lands on the card, not on the page body.
    await waitFor(() => {
      expect(within(card).getByRole('heading', { name: 'People who push' })).toHaveFocus();
    });
  });

  it('adds an S3 bucket; the path-style box only appears with an endpoint', async () => {
    const user = userEvent.setup();
    const mock = createMockApi('graded', 0);
    const addSource = vi.fn((b: AddSourceBody) => mock.addSource(b));
    render(
      <App
        api={{ ...mock, addSource }}
        history={createMemoryHistory({ initialEntries: ['/settings'] })}
      />,
    );
    await user.click(await screen.findByRole('button', { name: '+ Add S3 bucket' }));
    expect(screen.getByText(/AWS_ACCESS_KEY_ID/)).toBeVisible();
    expect(screen.queryByLabelText('Use path-style addressing')).toBeNull();
    await user.type(screen.getByLabelText('Bucket'), 'new-logs');
    await user.type(screen.getByLabelText('Endpoint (optional)'), 'https://minio.local');
    await user.click(screen.getByLabelText('Use path-style addressing'));
    await user.click(screen.getByRole('button', { name: 'Add bucket' }));
    await waitFor(() => {
      expect(addSource).toHaveBeenCalledWith({
        agent: 'claude_code',
        s3: {
          bucket: 'new-logs',
          prefix: '',
          endpoint: 'https://minio.local',
          forcePathStyle: true,
        },
      });
    });
    expect(await screen.findByText('s3://new-logs/')).toBeVisible();
  });

  it('shows the 422 detail inline, linked to the bucket field', async () => {
    const user = userEvent.setup();
    const mock = createMockApi('graded', 0);
    const detail = 'Cannot read s3://nope/: The specified bucket does not exist';
    const api: Api = {
      ...mock,
      addSource: () => Promise.reject(new ApiError(422, 'Unprocessable', detail)),
    };
    render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
    await user.click(await screen.findByRole('button', { name: '+ Add S3 bucket' }));
    await user.type(screen.getByLabelText('Bucket'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Add bucket' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(detail);
    expect(screen.getByLabelText('Bucket')).toHaveAccessibleDescription(detail);
  });
});
