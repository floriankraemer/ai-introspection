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
});
