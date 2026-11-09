import {
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { useApi } from './context.js';
import type {
  Api,
  EventFilter,
  Job,
  Proposal,
  ProposalStatus,
  Settings,
  SessionQuery,
} from './types.js';

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

/** Everything an accepted, rejected or newly drafted proposal changes. */
export const PROPOSAL_KEYS = [
  'proposals',
  'proposal',
  'improver-runs',
  'improver-schedule',
  'trend-summary',
  'budget',
];

export function useProposals(status: ProposalStatus) {
  const api = useApi();
  return useQuery({
    queryKey: ['proposals', status],
    queryFn: () => api.listProposals(status),
  });
}

/** Open count for the nav badge; shares the cache with the Open tab. */
export function useOpenProposalCount() {
  return useProposals('open').data?.counts.open ?? null;
}

/** Several statuses as one list, newest first (a tab can cover more than one status). */
export function useProposalTab(statuses: ProposalStatus[]) {
  const api = useApi();
  return useQueries({
    queries: statuses.map((status) => ({
      queryKey: ['proposals', status],
      queryFn: () => api.listProposals(status),
    })),
    combine: (rs) => ({
      items: rs
        .flatMap((r) => r.data?.items ?? [])
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      pending: rs.some((r) => r.isPending),
      error: rs.find((r) => r.isError)?.error ?? null,
      loaded: rs.every((r) => r.data),
    }),
  });
}

export function useImproverSchedule() {
  const api = useApi();
  return useQuery({ queryKey: ['improver-schedule'], queryFn: () => api.getImproverSchedule() });
}

export function usePatchSkillRepo() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Parameters<Api['patchSkillRepo']>[1]) =>
      api.patchSkillRepo(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skill-repos'] }),
  });
}

export function useAddProjectRepo() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.addProjectRepo(path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skill-repos'] }),
  });
}

export function useProposal(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['proposal', id],
    queryFn: () => api.getProposal(id ?? ''),
    enabled: id !== null,
  });
}

export function useImproverRuns() {
  const api = useApi();
  return useQuery({ queryKey: ['improver-runs'], queryFn: () => api.listImproverRuns() });
}

/** Accept, reject or edit one proposal. Accept and reject move it between tabs, so lists are refetched. */
export function useProposalAction<V>(
  id: string,
  call: (api: Api, v: V) => Promise<Proposal>,
  { refreshAll }: { refreshAll: boolean },
) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => call(api, v),
    onSuccess: (p) => {
      qc.setQueryData(['proposal', id], p);
      void invalidateKeys(qc, refreshAll ? PROPOSAL_KEYS : ['proposals']);
    },
  });
}

/** Starts an improver run and follows its job; any terminal status refetches proposals, runs, trends and budget. */
export function useImproverRun() {
  const api = useApi();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.startImprover(),
    onSuccess: (job) => {
      qc.setQueryData(['job', job.id], job);
    },
  });
  const job = useJob(run.data?.id ?? null);
  const status = job.data?.status;
  useEffect(() => {
    if (status && TERMINAL.includes(status)) void invalidateKeys(qc, PROPOSAL_KEYS);
  }, [status, qc]);
  return { run, job: job.data ?? run.data ?? null };
}

export type { Settings };
