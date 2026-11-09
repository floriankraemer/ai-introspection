import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useApi } from '../api/context.js';
import { Card } from '../components/ui.js';

/** `/auth#<token>`: trades the one-time token from `introspect open` for the session cookie (ADR-0008). */
export function AuthExchange() {
  const api = useApi();
  const navigate = useNavigate();
  useEffect(() => {
    const token = window.location.hash.slice(1);
    // Drop the token from the address bar and history before anything else.
    window.history.replaceState(null, '', window.location.pathname);
    void (token ? api.exchangeToken(token) : Promise.resolve())
      .catch(() => undefined)
      .then(() => navigate({ to: '/', replace: true }));
  }, [api, navigate]);
  return (
    <p role="status" className="p-8 text-sm text-muted">
      Signing in…
    </p>
  );
}

export function AuthRequired() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4 text-ink">
      <Card className="flex max-w-md flex-col gap-3 p-6">
        <h1 className="m-0 text-[22px] font-bold">Open Introspect with its link</h1>
        <p className="m-0 text-sm leading-normal text-ink-soft">
          This page needs the local access token. Run <code>introspect open</code> in a terminal; it
          opens this page with the token attached. With Docker, run{' '}
          <code>docker compose exec introspect node dist/cli.js open</code>.
        </p>
      </Card>
    </div>
  );
}
