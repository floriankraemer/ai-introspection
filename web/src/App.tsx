import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from './api/client.js';
import { ApiContext } from './api/context.js';
import type { Api } from './api/types.js';
import { createAppRouter } from './router.js';

export function App({ api, history }: { api: Api; history?: RouterHistory }) {
  const [{ queryClient, router }] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          // Client errors (401, 404, 422) will not fix themselves; do not retry them.
          retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
          staleTime: 5_000,
        },
      },
    });
    return { queryClient, router: createAppRouter({ api, queryClient }, history) };
  });
  return (
    <ApiContext value={api}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiContext>
  );
}
