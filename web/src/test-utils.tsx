import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { App } from './App.js';
import { createMockApi, type MockScenario } from './api/mock.js';

/** Renders the whole app on the fixture API (no latency) at the given path. */
export function renderApp(path: string, scenario: MockScenario = 'graded') {
  return render(
    <App
      api={createMockApi(scenario, 0)}
      history={createMemoryHistory({ initialEntries: [path] })}
    />,
  );
}
