import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';

describe('Session detail', () => {
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
});
