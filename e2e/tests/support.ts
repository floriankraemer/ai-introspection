import { readFileSync } from 'node:fs';
import { expect, test as base, type APIRequestContext } from '@playwright/test';

/** The sign-in token, as `introspect open` prints it: read from the data volume (mounted read-only). */
export const token = (): string => readFileSync('/data/token', 'utf8').trim();

/** `test` with a browser that is already signed in (specs 2 and later; spec 1 signs in through the UI). */
export const test = base.extend({
  context: async ({ context }, use) => {
    const res = await context.request.post('/v1/auth/session', { data: { token: token() } });
    expect(res.ok()).toBeTruthy();
    await use(context);
  },
});
export { expect };

export interface SessionRow {
  id: string;
  title: string;
  agent: string;
  repo: string | null;
  startedAt: string;
  grades: { rubric: string; passed: boolean | null }[];
  toolErrors: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export async function get(api: APIRequestContext, path: string): Promise<Json> {
  const res = await api.get(path);
  expect(res.ok(), `GET ${path}: ${String(res.status())}`).toBeTruthy();
  return res.json();
}

export async function send(
  api: APIRequestContext,
  method: 'post' | 'put' | 'patch',
  path: string,
  data?: unknown,
): Promise<Json> {
  const res = await api[method](path, data === undefined ? {} : { data });
  expect(
    res.ok(),
    `${method.toUpperCase()} ${path}: ${String(res.status())} ${await res.text()}`,
  ).toBeTruthy();
  return res.status() === 204 ? null : res.json();
}

export async function allSessions(api: APIRequestContext): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: SessionRow[]; nextCursor: string | null } = await get(
      api,
      `/v1/sessions?result=all&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

/** Waits until a background job (import, grading, improver run) has finished successfully. */
export async function jobDone(api: APIRequestContext, id: string): Promise<void> {
  await expect
    .poll(async () => (await get(api, `/v1/jobs/${id}`)).status, { timeout: 60_000 })
    .toBe('succeeded');
}

/** Grades the sessions with every rubric and waits for the result. */
export async function gradeNow(api: APIRequestContext, sessionIds: string[]): Promise<void> {
  const job = await send(api, 'post', '/v1/grades/batch', { sessionIds, force: true });
  await jobDone(api, job.id);
}
