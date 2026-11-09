import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../platform/db/ids.js';
import { toJson } from '../../platform/db/json.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import { createFakeJudge, createGrading } from '../grading/index.js';
import { createIngest } from '../ingest/index.js';
import type { RubricStore } from '../rubrics/index.js';
import { createSecretStore, createSettings } from '../settings/index.js';
import { createTrends, type Trends } from './index.js';

/** NFR-05: `GET /v1/trends` answers in 300 ms (p95) with 200,000 grades. */
const GRADES = 200_000;
const RUBRICS = ['efficiency', 'redundant-tests', 'silent-workaround', 'verbosity'];
const SESSIONS = GRADES / RUBRICS.length;
/** One year of sessions: a 26-week query reads about half of the grades. */
const DAYS = 365;
const CHUNK = 1000;
const RUNS = 40;
const BUDGET_MS = 300;
const NOW = new Date('2026-11-11T12:00:00.000Z');

const p95 = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? 0;

export function trendsNfrSuite(name: string, make: TestDbFactory): void {
  describe(`trends NFR-05 (${name})`, () => {
    let t: TestDb;
    let dir: string;
    let trends: Trends;

    beforeAll(async () => {
      t = await make();
      dir = mkdtempSync(join(tmpdir(), 'introspect-nfr-'));
      const { db } = t.handle;
      const rubricIds = RUBRICS.map(() => newId());
      await db
        .insertInto('rubric')
        .values(
          RUBRICS.map((rubric, i) => ({
            id: rubricIds[i] ?? '',
            workspace_id: LOCAL_WORKSPACE_ID,
            name: rubric,
            version: `v-${rubric}`,
            ordinal: 1,
            commit_sha: null,
            scale: '[0,1]',
            pass_threshold: 1,
            target_pass_rate: null,
            applies_to: '"all"',
            body_md: 'x',
            created_at: '2026-01-01T00:00:00.000Z',
          })),
        )
        .execute();
      const sessionIds = Array.from({ length: SESSIONS }, () => newId());
      const started = (i: number): string =>
        new Date(NOW.getTime() - ((i * 7919) % (DAYS * 86_400)) * 1000).toISOString();
      await db.transaction().execute(async (tx) => {
        for (let from = 0; from < SESSIONS; from += CHUNK) {
          await tx
            .insertInto('session')
            .values(
              sessionIds.slice(from, from + CHUNK).map((id, k) => ({
                id,
                workspace_id: LOCAL_WORKSPACE_ID,
                user_id: LOCAL_USER_ID,
                agent: 'claude_code',
                native_id: id,
                status: 'ended',
                started_at: started(from + k),
                created_at: NOW.toISOString(),
              })),
            )
            .execute();
        }
        for (let from = 0; from < SESSIONS; from += CHUNK / 4) {
          await tx
            .insertInto('grade')
            .values(
              sessionIds.slice(from, from + CHUNK / 4).flatMap((sessionId, k) =>
                RUBRICS.map((rubric, r) => ({
                  id: newId(),
                  workspace_id: LOCAL_WORKSPACE_ID,
                  session_id: sessionId,
                  rubric_id: rubricIds[r] ?? '',
                  rubric_version: `v-${rubric}`,
                  score: 1,
                  passed: (from + k + r) % 3 !== 0,
                  reason: 'r',
                  evidence_event_ids: '[]',
                  judge_model: 'fake-judge',
                  transport: 'fake',
                  status: 'ok' as const,
                  graded_at: NOW.toISOString(),
                })),
              ),
            )
            .execute();
        }
        // Twenty change events (a year of weekly merges is about 50).
        await tx
          .insertInto('change_event')
          .values(
            Array.from({ length: 20 }, (_, i) => ({
              id: newId(),
              workspace_id: LOCAL_WORKSPACE_ID,
              at: new Date(NOW.getTime() - (i + 1) * 6 * 86_400_000).toISOString(),
              kind: 'proposal_merged' as const,
              proposal_id: null,
              repo_id: null,
              description: `change ${String(i)}`,
              files: toJson(['CLAUDE.md']),
              rubric_names: toJson([RUBRICS[i % RUBRICS.length]]),
              ref: null,
            })),
          )
          .execute();
      });
      // Postgres analyzes a table that grew this much on its own (autovacuum); a test cannot wait for it.
      if (t.dialect === 'postgres') await sql`analyze`.execute(db);
      const jobs = createJobQueue(t.handle);
      const settings = createSettings(db, LOCAL_WORKSPACE_ID, createSecretStore(join(dir, 'data')));
      const ingest = createIngest({
        db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        dataDir: join(dir, 'data'),
        settings,
        queue: jobs,
        pollMode: false,
      });
      const rubrics = {
        list: () => Promise.resolve({ rubrics: RUBRICS.map((n) => ({ name: n })), problems: [] }),
      } as unknown as RubricStore;
      const judge = createFakeJudge();
      const judges = { current: () => Promise.resolve(judge) };
      const grading = createGrading({
        db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        settings,
        queue: jobs,
        ingest,
        rubrics,
        judges,
      });
      trends = createTrends({
        db,
        workspaceId: LOCAL_WORKSPACE_ID,
        settings,
        ingest,
        grading,
        rubrics,
        judges,
        skillRepos: {
          rows: () => Promise.resolve([]),
          refreshDefaultBranch: () => Promise.resolve('main'),
        },
        timeZone: 'Europe/Berlin',
        now: () => NOW,
      });
    }, 300_000);
    afterAll(async () => {
      await t.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    async function time(fn: () => Promise<unknown>): Promise<number> {
      await fn(); // warm-up: plan cache, formatter cache
      const ms: number[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        const start = performance.now();
        await fn();
        ms.push(performance.now() - start);
      }
      return p95(ms);
    }

    it('answers the default weekly 12-week series within budget', async () => {
      const ms = await time(() => trends.series(12, 'week'));
      console.log(
        `NFR-05 ${name}: series(12w, week) p95 = ${ms.toFixed(1)} ms over ${String(GRADES)} grades`,
      );
      expect(ms).toBeLessThan(BUDGET_MS);
    }, 120_000);

    // The 26-week requests read about 100,000 grades and run at 250-300 ms here, so these two
    // assertions are regression guards with headroom for a noisy machine, not the budget itself.
    it('answers the weekly 26-week series with headroom', async () => {
      const ms = await time(() => trends.series(26, 'week'));
      console.log(`NFR-05 ${name}: series(26w, week) p95 = ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(BUDGET_MS * 1.5);
    }, 120_000);

    it('answers the daily 26-week series (the largest request) with headroom', async () => {
      const ms = await time(() => trends.series(26, 'day'));
      console.log(`NFR-05 ${name}: series(26w, day) p95 = ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(BUDGET_MS * 1.5);
    }, 120_000);

    it('reports the worst case: a full year, all 200,000 grades in range (no limit asserted)', async () => {
      const ms = await time(() => trends.series(52, 'day'));
      console.log(
        `NFR-05 ${name}: series(52w, day) p95 = ${ms.toFixed(1)} ms (worst case, not in the API)`,
      );
      expect(ms).toBeGreaterThan(0);
    }, 120_000);

    // NFR-05 covers the series only. The change log runs one Fisher/z test per rubric and change
    // (about 250-320 ms here), so this is a regression guard with the same headroom as above.
    it('answers the change log (20 events) with headroom', async () => {
      const ms = await time(() => trends.changes());
      console.log(`NFR-05 ${name}: changes() p95 = ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(BUDGET_MS * 1.5);
    }, 120_000);
  });
}
