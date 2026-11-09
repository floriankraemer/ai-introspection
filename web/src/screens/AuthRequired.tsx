import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useApi } from '../api/context.js';
import { Card } from '../components/ui.js';

/** `/auth#<token>`: trades the one-time token from `introspect open` for the session cookie (ADR-0008). */
export function AuthExchange() {
  const api = useApi();
  const navigate = useNavigate();
  // Read once at first render: StrictMode runs the effect twice, and the first run clears the hash.
  // A second run without the token would navigate before the cookie is set and land on sign-in.
  const [token] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    // Drop the token from the address bar and history before anything else.
    window.history.replaceState(null, '', window.location.pathname);
    void (token ? api.exchangeToken(token) : Promise.resolve())
      .catch(() => undefined)
      .then(() => navigate({ to: '/', replace: true }));
  }, [api, navigate, token]);
  return (
    <p role="status" className="p-8 text-sm text-muted">
      Signing in…
    </p>
  );
}

const OPEN_CMD = 'make open';

export function AuthRequired() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4 text-ink">
      <Card className="flex w-full max-w-lg flex-col gap-3 p-6">
        <h1 className="m-0 text-[22px] font-bold">Open Introspect with its link</h1>
        <p className="m-0 text-sm leading-normal text-ink-soft">
          This browser is not signed in yet. Run this in a terminal in the project folder, then open
          the link it prints:
        </p>
        <pre className="m-0 rounded-lg border border-line bg-sunken p-3 font-mono text-[13px] break-all whitespace-pre-wrap">
          {OPEN_CMD}
        </pre>
        <p className="m-0 text-sm leading-normal text-muted">
          Not using Make? Run <code>docker compose exec introspect introspect open</code>, or{' '}
          <code>introspect open</code> outside Docker. The link signs this browser in and is only
          valid for you.
        </p>
      </Card>
    </div>
  );
}
