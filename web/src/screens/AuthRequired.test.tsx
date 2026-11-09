import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App.js';
import { ApiError } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import type { Api } from '../api/types.js';

/** A server that answers 401 until the token exchange has completed, which takes a moment. */
function slowSignInApi(calls: string[]): Api {
  const api = createMockApi('graded', 0);
  let signedIn = false;
  return {
    ...api,
    getSettings: () => {
      calls.push(signedIn ? 'settings' : 'settings before sign-in');
      return signedIn
        ? api.getSettings()
        : Promise.reject(new ApiError(401, 'Unauthorized', 'A valid Introspect token is required'));
    },
    exchangeToken: () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          signedIn = true;
          resolve();
        }, 50),
      ),
  };
}

describe('AuthExchange', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('signs in from /auth#<token> in the browser history under StrictMode, whose effects run twice', async () => {
    window.history.replaceState(null, '', '/auth#t0k3n');
    const calls: string[] = [];
    render(
      <StrictMode>
        <App api={slowSignInApi(calls)} />
      </StrictMode>,
    );
    expect(await screen.findByRole('link', { name: /Sessions/ })).toBeVisible();
    expect(screen.queryByText('Open Introspect with its link')).toBeNull();
    expect(window.location.hash).toBe('');
    // The app waits for the cookie: a request before it would land on the sign-in screen.
    expect(calls).not.toContain('settings before sign-in');
  });
});
