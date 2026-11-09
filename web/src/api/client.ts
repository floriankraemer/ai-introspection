import type { Api } from './types.js';

/** RFC 9457 problem+json, as returned by every `/v1` error (ADR-0008). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string | null,
    /** Extension members of the problem: `problems` on a 422, `fix` on a 409. */
    readonly problems: string[] = [],
    readonly fix: string | null = null,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const res = await fetch(`/v1${path}`, init);
  if (!res.ok) {
    const p = (await res.json().catch(() => ({}))) as {
      title?: string;
      detail?: string;
      problems?: string[];
      fix?: string;
    };
    throw new ApiError(
      res.status,
      p.title ?? res.statusText,
      p.detail ?? null,
      p.problems ?? [],
      p.fix ?? null,
    );
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

const id = encodeURIComponent;

export const realApi: Api = {
  getSettings: () => request('GET', '/settings'),
  patchSettings: (patch) => request('PATCH', '/settings', patch),
  putJudgeKey: (apiKey) => request('PUT', '/settings/judge-key', { apiKey }),
  testJudge: (body) => request('POST', '/judge/test', body),
  listSources: () => request('GET', '/sources'),
  detectSources: () => request('GET', '/sources/detected'),
  addSource: (body) => request('POST', '/sources', body),
  listSkillRepos: () => request('GET', '/skill-repos'),
  detectSkillRepos: () => request('GET', '/skill-repos/detected'),
  putGlobalSkillRepo: (path) => request('PUT', '/skill-repos/global', { path }),
  initGlobalSkillRepo: (path) => request('POST', '/skill-repos/global/init', { path }),
  copyStarterRubrics: () => request('POST', '/skill-repos/global/starter-rubrics'),
  patchSkillRepo: (rid, body) => request('PATCH', `/skill-repos/${id(rid)}`, body),
  startImport: () => request('POST', '/imports'),
  getJob: (jid) => request('GET', `/jobs/${id(jid)}`),
  getTrendSummary: (days) => request('GET', `/trends/summary${qs({ days })}`),
  getTrends: (q) => request('GET', `/trends${qs({ ...q })}`),
  listTrendChanges: () => request('GET', '/trends/changes'),
  startReferenceRegrade: () => request('POST', '/trends/reference-regrade'),
  listSessions: (q) => request('GET', `/sessions${qs({ ...q })}`),
  getSession: (sid) => request('GET', `/sessions/${id(sid)}`),
  listEvents: (sid, q) => request('GET', `/sessions/${id(sid)}/events${qs({ ...q })}`),
  getDoctor: () => request('GET', '/doctor'),
  regradeSession: (sid) => request('POST', `/sessions/${id(sid)}/grade`),
  gradeBatch: (sessionIds) => request('POST', '/grades/batch', { sessionIds }),
  listRubrics: () => request('GET', '/rubrics'),
  getRubric: (name) => request('GET', `/rubrics/${id(name)}`),
  putRubric: (name, body) => request('PUT', `/rubrics/${id(name)}`, body),
  dryRunRubric: (name, body) => request('POST', `/rubrics/${id(name)}/dry-run`, body),
  addLabel: (name, label) => request('POST', `/rubrics/${id(name)}/labels`, label),
  getBudget: () => request('GET', '/budget'),
  listProposals: (status) => request('GET', `/proposals${qs({ status })}`),
  getProposal: (pid) => request('GET', `/proposals/${id(pid)}`),
  patchProposal: (pid, diff) => request('PATCH', `/proposals/${id(pid)}`, { diff }),
  acceptProposal: (pid) => request('POST', `/proposals/${id(pid)}/accept`),
  rejectProposal: (pid, reason) => request('POST', `/proposals/${id(pid)}/reject`, { reason }),
  startImprover: (since) => request('POST', '/improver/runs', since ? { since } : {}),
  getImproverSchedule: () => request('GET', '/improver/schedule'),
  addProjectRepo: (path) => request('POST', '/skill-repos/projects', { path }),
  listImproverRuns: () => request('GET', '/improver/runs'),
  exchangeToken: (token) => request('POST', '/auth/session', { token }),
};
