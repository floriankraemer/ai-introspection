import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useApi } from './context.js';
import type { Api, EventFilter, Job, Settings, SessionQuery } from './types.js';

/** Query options live apart from hooks so route loaders can prefetch with the same keys. */
export const settingsQuery = (api: Api) =>
  queryOptions({ queryKey: ['settings'], queryFn: () => api.getSettings() });

export const useSettings = () => useQuery(settingsQuery(useApi()));

export function usePatchSettings() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<Api['patchSettings']>[0]) => api.patchSettings(patch),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
    },
  });
}

export function useSources() {
  const api = useApi();
  return useQuery({ queryKey: ['sources'], queryFn: () => api.listSources() });
}

export function useSkillRepos() {
  const api = useApi();
  return useQuery({ queryKey: ['skill-repos'], queryFn: () => api.listSkillRepos() });
}

export function useTrendSummary(days = 7) {
  const api = useApi();
  return useQuery({ queryKey: ['trend-summary', days], queryFn: () => api.getTrendSummary(days) });
}

export function useSessions(query: SessionQuery) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ['sessions', query],
    queryFn: ({ pageParam }) => api.listSessions({ ...query, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useSession(id: string) {
  const api = useApi();
  return useQuery({ queryKey: ['session', id], queryFn: () => api.getSession(id) });
}

export function useSessionEvents(id: string, filter: EventFilter) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ['session-events', id, filter],
    queryFn: ({ pageParam }) => api.listEvents(id, { filter, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

const TERMINAL: Job['status'][] = ['succeeded', 'failed', 'dead'];

/** Polls a job once a second until it reaches a terminal status. */
export function useJob(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['job', id],
    queryFn: () => api.getJob(id ?? ''),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 1000),
  });
}

export function useStartImport() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startImport(),
    onSuccess: (job) => {
      qc.setQueryData(['job', job.id], job);
    },
  });
}

export type { Settings };
