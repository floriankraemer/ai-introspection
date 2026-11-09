import {
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
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
      // The budget changes with the limits; the doctor's judge check with the transport.
      void invalidateKeys(qc, ['budget', 'doctor']);
    },
  });
}

/** Marks the given query families stale; the ones on screen refetch right away. */
export function invalidateKeys(qc: QueryClient, keys: string[]) {
  return Promise.all(keys.map((key) => qc.invalidateQueries({ queryKey: [key] })));
}

/** Everything that shows a grade, a rubric's trusted flag or its agreement. */
export const GRADE_KEYS = [
  'rubric',
  'rubrics',
  'session',
  'sessions',
  'session-events',
  'trend-summary',
  'budget',
];

/** Health checks are cheap but must be re-run on demand, so they are never served stale. */
export function useDoctor() {
  const api = useApi();
  return useQuery({ queryKey: ['doctor'], queryFn: () => api.getDoctor(), staleTime: 0 });
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

// A deferred job waits for the budget window to reset; polling it every second would be noise.
const TERMINAL: Job['status'][] = ['succeeded', 'failed', 'dead', 'deferred'];

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

/** Starts an import and follows it; once it succeeds every query is refetched (new sessions, sources). */
export function useImport() {
  const qc = useQueryClient();
  const start = useStartImport();
  const job = useJob(start.data?.id ?? null);
  const status = job.data?.status;
  useEffect(() => {
    if (status === 'succeeded') void qc.invalidateQueries();
  }, [status, qc]);
  return { start, job };
}

export function useBudget() {
  const api = useApi();
  return useQuery({ queryKey: ['budget'], queryFn: () => api.getBudget(), staleTime: 0 });
}

export function useRubrics() {
  const api = useApi();
  return useQuery({ queryKey: ['rubrics'], queryFn: () => api.listRubrics() });
}

export function useRubric(name: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['rubric', name],
    queryFn: () => api.getRubric(name ?? ''),
    enabled: name !== null,
  });
}

/** Starts a grade job (re-grade or batch) and follows it; when it succeeds, grades are refetched. */
export function useGradeJob(start: (api: Api, ids: string[]) => Promise<Job>) {
  const api = useApi();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: (ids: string[]) => start(api, ids),
    onSuccess: (job) => {
      qc.setQueryData(['job', job.id], job);
    },
  });
  const job = useJob(run.data?.id ?? null);
  const status = job.data?.status;
  useEffect(() => {
    // Any terminal status: a failed or deferred job may still have graded some sessions.
    if (status && TERMINAL.includes(status)) void invalidateKeys(qc, GRADE_KEYS);
  }, [status, qc]);
  return { run, job: job.data ?? run.data ?? null };
}

export type { Settings };
