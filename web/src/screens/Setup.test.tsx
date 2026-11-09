import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';

describe('setup wizard', () => {
  it('redirects to the wizard while unconfigured and walks all four steps', async () => {
    const user = userEvent.setup();
    renderApp('/', 'fresh');

    // Step 1: detected folders are pre-ticked with their session counts.
    expect(
      await screen.findByRole('heading', { name: 'Where are your sessions?' }),
    ).toBeInTheDocument();
    const claude = await screen.findByRole('checkbox', { name: /Claude Code/ });
    expect(claude).toBeChecked();
    expect(screen.getByText('212 sessions')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('1. Sources');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 2: API key + test connection; budget defaults to 1M tokens/day.
    expect(
      await screen.findByRole('heading', { name: 'How should sessions be graded?' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Daily token budget')).toHaveValue(1_000_000);
    await user.type(screen.getByLabelText('Anthropic API key'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/rejected this key/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Anthropic API key'));
    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-abc');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/API accepted the key/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 3: a folder without rubrics/ offers the 4 starter rubrics.
    expect(
      await screen.findByRole('heading', { name: 'Where do your skills live?' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Path to your skills repo'), '~/dev/skills');
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await user.click(await screen.findByRole('button', { name: 'Copy 4 starter rubrics' }));
    expect(await screen.findByText(/Copied 4 starter rubrics/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 4: import progress, then Sessions.
    expect(
      await screen.findByRole('heading', { name: 'Importing your history' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Import finished/, undefined, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Sessions' }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it('lets every step be skipped', async () => {
    const user = userEvent.setup();
    renderApp('/setup', 'fresh');
    for (const heading of [
      'Where are your sessions?',
      'How should sessions be graded?',
      'Where do your skills live?',
    ]) {
      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Skip' }));
    }
    expect(
      await screen.findByRole('heading', { name: 'Importing your history' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go to Sessions' })).toBeEnabled();
    });
  });
});
