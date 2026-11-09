import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { realApi } from './api/client.js';
import type { MockScenario } from './api/mock.js';
import './index.css';
import { applyThemePref, getThemePref } from './lib/theme.js';

const el = document.getElementById('root');
if (!el) throw new Error('#root element missing from index.html');

applyThemePref(getThemePref());

/** Dev only: `?mock=graded|ungraded|empty|fresh` swaps in the fixture API; remembered for the tab. */
function mockScenario(): MockScenario | null {
  const fromUrl = new URLSearchParams(window.location.search).get('mock');
  if (fromUrl) sessionStorage.setItem('introspect.mock', fromUrl);
  return sessionStorage.getItem('introspect.mock') as MockScenario | null;
}

async function boot(root: HTMLElement) {
  // `import.meta.env.DEV` is false in production builds, so the mock is tree-shaken out.
  const scenario = import.meta.env.DEV ? mockScenario() : null;
  const api = scenario ? (await import('./api/mock.js')).createMockApi(scenario) : realApi;
  createRoot(root).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  );
}

void boot(el);
