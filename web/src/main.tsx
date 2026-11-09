import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { realApi } from './api/client.js';
import type { MockScenario } from './api/mock.js';
import { USE_MOCK_API } from './config.js';
import './index.css';
import { applyThemePref, getThemePref } from './lib/theme.js';

const el = document.getElementById('root');
if (!el) throw new Error('#root element missing from index.html');

applyThemePref(getThemePref());

function mockScenario(): MockScenario {
  const fromUrl = new URLSearchParams(window.location.search).get('mock');
  if (fromUrl) sessionStorage.setItem('introspect.mock', fromUrl);
  return (sessionStorage.getItem('introspect.mock') as MockScenario | null) ?? 'graded';
}

async function boot(root: HTMLElement) {
  // Mock scenario via ?mock=graded|ungraded|empty|fresh (dev only); remembered for the tab.
  const api = USE_MOCK_API
    ? (await import('./api/mock.js')).createMockApi(mockScenario())
    : realApi;
  createRoot(root).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  );
}

void boot(el);
