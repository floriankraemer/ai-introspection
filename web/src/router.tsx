import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { ApiError } from './api/client.js';
import { settingsQuery } from './api/queries.js';
import type { Agent, Api, SessionResultFilter } from './api/types.js';
import { Shell } from './components/Shell.js';
import { ErrorState } from './components/ui.js';
import { AuthExchange, AuthRequired } from './screens/AuthRequired.js';
import { Proposals, Trends } from './screens/Placeholders.js';
import { SessionDetail } from './screens/SessionDetail.js';
import { Sessions, type SessionsSearch } from './screens/Sessions.js';
import { Settings } from './screens/Settings.js';
import { Setup } from './screens/Setup.js';

export interface RouterContext {
  api: Api;
  queryClient: QueryClient;
}

const root = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: ({ error, reset }) =>
    error instanceof ApiError && error.status === 401 ? (
      <AuthRequired />
    ) : (
      <div className="p-8">
        <ErrorState error={error} onRetry={reset} />
      </div>
    ),
});

// Layout route: everything with the nav lives here, and it bounces to the wizard until configured.
const shell = createRoute({
  getParentRoute: () => root,
  id: 'shell',
  beforeLoad: async ({ context }) => {
    const s = await context.queryClient.query({
      ...settingsQuery(context.api),
      staleTime: 'static',
    });
    // TanStack Router redirects are thrown by design, and are not Error instances.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (!s['setup.completed']) throw redirect({ to: '/setup' });
  },
  component: Shell,
});

const AGENTS: Agent[] = ['claude_code', 'codex'];
const RESULTS: SessionResultFilter[] = ['failed_any', 'all', 'not_graded'];

const sessions = createRoute({
  getParentRoute: () => shell,
  path: '/',
  validateSearch: (s: Record<string, unknown>): SessionsSearch => ({
    q: typeof s.q === 'string' && s.q ? s.q : undefined,
    agent: AGENTS.find((a) => a === s.agent),
    result: RESULTS.find((r) => r === s.result),
  }),
  component: function SessionsRoute() {
    const search = sessions.useSearch();
    const navigate = sessions.useNavigate();
    return (
      <Sessions
        search={search}
        onSearch={(patch) => {
          void navigate({
            search: (prev) => (patch ? { ...prev, ...patch } : {}),
            replace: true,
          });
        }}
      />
    );
  },
});

const sessionDetail = createRoute({
  getParentRoute: () => shell,
  path: '/sessions/$sessionId',
  component: function SessionRoute() {
    return <SessionDetail id={sessionDetail.useParams().sessionId} />;
  },
});

const rubrics = createRoute({
  getParentRoute: () => shell,
  path: '/rubrics',
  // Lazy: the screen pulls in the CodeMirror editor, which the other screens never need.
  component: lazyRouteComponent(() => import('./screens/Rubrics.js'), 'Rubrics'),
});
const proposals = createRoute({
  getParentRoute: () => shell,
  path: '/proposals',
  component: Proposals,
});
const trends = createRoute({ getParentRoute: () => shell, path: '/trends', component: Trends });
const settings = createRoute({
  getParentRoute: () => shell,
  path: '/settings',
  component: Settings,
});
const setup = createRoute({ getParentRoute: () => root, path: '/setup', component: Setup });
const auth = createRoute({ getParentRoute: () => root, path: '/auth', component: AuthExchange });

const routeTree = root.addChildren([
  shell.addChildren([sessions, sessionDetail, rubrics, proposals, trends, settings]),
  setup,
  auth,
]);

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
