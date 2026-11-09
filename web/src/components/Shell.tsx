import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useOpenProposalCount } from '../api/queries.js';
import { Chip } from './ui.js';
import { applyThemePref, getThemePref, THEME_KEY, type ThemePref } from '../lib/theme.js';

const NAV = [
  { to: '/', label: 'Sessions', match: (p: string) => p === '/' || p.startsWith('/sessions') },
  { to: '/proposals', label: 'Proposals', match: (p: string) => p.startsWith('/proposals') },
  { to: '/trends', label: 'Trends', match: (p: string) => p.startsWith('/trends') },
  { to: '/rubrics', label: 'Rubrics', match: (p: string) => p.startsWith('/rubrics') },
  { to: '/settings', label: 'Settings', match: (p: string) => p.startsWith('/settings') },
] as const;

function ThemeSelect() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  // The select and the page theme come from one value, so they cannot disagree; another tab's
  // change arrives as a storage event.
  useEffect(() => {
    applyThemePref(pref);
  }, [pref]);
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === null || e.key === THEME_KEY) setPref(getThemePref());
    };
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('storage', sync);
    };
  }, []);
  return (
    <label className="ml-auto flex flex-col gap-1 px-3 text-xs lg:mt-auto lg:ml-0 lg:pt-6 text-muted">
      Theme
      <select
        className="h-10 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
        value={pref}
        onChange={(e) => {
          setPref(e.target.value as ThemePref);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

export function Shell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const openProposals = useOpenProposalCount();
  return (
    <div className="flex min-h-screen flex-col bg-page text-ink lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-10 focus:rounded-lg focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <nav
        aria-label="Main"
        className="box-border flex flex-row flex-wrap items-center gap-1 border-b border-line bg-surface px-4 py-3 lg:flex-col lg:items-stretch lg:border-r lg:border-b-0 lg:py-6"
      >
        <div className="w-full px-3 pb-2 text-base font-bold lg:pb-5">Introspect · local</div>
        {NAV.map((item) => {
          const active = item.match(path);
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={`rounded-lg px-3 py-2.5 text-ink no-underline hover:bg-sunken hover:text-ink ${active ? 'bg-accent-soft font-semibold' : ''}`}
            >
              {item.label}
              {item.to === '/proposals' && openProposals ? (
                <Chip className="ml-1.5">
                  {openProposals}
                  <span className="sr-only"> open</span>
                </Chip>
              ) : null}
            </Link>
          );
        })}
        <ThemeSelect />
      </nav>
      <main
        id="main"
        tabIndex={-1}
        className="box-border flex min-w-0 flex-col p-4 sm:p-8 outline-none"
      >
        <Outlet />
      </main>
    </div>
  );
}
