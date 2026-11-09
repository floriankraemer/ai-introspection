import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { applyThemePref, getThemePref, type ThemePref } from '../lib/theme.js';

const NAV = [
  { to: '/', label: 'Sessions', match: (p: string) => p === '/' || p.startsWith('/sessions') },
  { to: '/proposals', label: 'Proposals', match: (p: string) => p.startsWith('/proposals') },
  { to: '/trends', label: 'Trends', match: (p: string) => p.startsWith('/trends') },
  { to: '/rubrics', label: 'Rubrics', match: (p: string) => p.startsWith('/rubrics') },
  { to: '/settings', label: 'Settings', match: (p: string) => p.startsWith('/settings') },
] as const;

function ThemeSelect() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  return (
    <label className="mt-auto flex flex-col gap-1 px-3 pt-6 text-xs text-muted">
      Theme
      <select
        className="h-10 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
        value={pref}
        onChange={(e) => {
          const next = e.target.value as ThemePref;
          setPref(next);
          applyThemePref(next);
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
  return (
    <div className="flex min-h-screen flex-wrap bg-page text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-10 focus:rounded-lg focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <nav
        aria-label="Main"
        className="box-border flex flex-[1_1_220px] flex-col gap-1 border-r border-line bg-surface px-4 py-6"
      >
        <div className="px-3 pb-5 text-base font-bold">Introspect · local</div>
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
            </Link>
          );
        })}
        <ThemeSelect />
      </nav>
      <main
        id="main"
        tabIndex={-1}
        className="box-border flex min-w-0 flex-[999_1_560px] flex-col p-8 outline-none"
      >
        <Outlet />
      </main>
    </div>
  );
}
