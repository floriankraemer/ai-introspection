import { readFileSync } from 'node:fs';
import { expect, test as base, type APIRequestContext } from '@playwright/test';

/** The sign-in token, as `introspect open` prints it: read from the data volume (mounted read-only). */
export const token = (): string => readFileSync('/data/token', 'utf8').trim();

/** State-changing API calls need an Origin (or a bearer token); a browser sends one, a bare request context does not. */
const SAME_ORIGIN = { Origin: 'http://127.0.0.1:7317' };

/** The app clock's start, the same instant the seed uses (INTROSPECT_NOW). */
export const NOW = Date.parse(process.env.INTROSPECT_NOW ?? '');

/**
 * `test` with a browser that is already signed in (specs 2 and later; spec 1 signs in through the UI)
 * and whose clock reads NOW, so relative times ("2 days ago") and the Sessions period match the app.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.clock.setFixedTime(NOW);
    const res = await context.request.post('/v1/auth/session', {
      data: { token: token() },
      headers: SAME_ORIGIN,
    });
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
  const res = await api[method](
    path,
    data === undefined ? { headers: SAME_ORIGIN } : { data, headers: SAME_ORIGIN },
  );
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

/** Runs the trends scan now (manual edits, rubric versions, judge changes); returns the app clock when it finished. */
export async function scanNow(api: APIRequestContext): Promise<number> {
  const job = await send(api, 'post', '/v1/trends/scan');
  await jobDone(api, job.id);
  return Date.parse((await get(api, `/v1/jobs/${job.id}`)).finishedAt);
}
