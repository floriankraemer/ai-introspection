import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';

describe('Settings', () => {
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

  it('rejects a retention below the minimum', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    const input = await screen.findByLabelText('Keep event payloads for (days)');
    await user.clear(input);
    await user.type(input, '3');
    expect(await screen.findByText('Enter a number of at least 7.')).toBeInTheDocument();
  });
});
