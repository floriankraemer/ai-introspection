import type { Db } from '../../platform/db/schema.js';
import { asBool } from '../../platform/db/json.js';
import { isFlagged, isSampled, SIGNAL_VERSION, SignalAccumulator } from './signals.js';

const PAGE = 2000;

/** Session end: compute signals, decide flagged and sampled, mark the session ended. Safe to repeat. */
export async function finalizeSession(
  db: Db,
  workspaceId: string,
  sessionId: string,
  now: Date,
): Promise<void> {
  const acc = new SignalAccumulator();
  let after = -1;
  for (;;) {
    const page = await db
      .selectFrom('event')
      .select(['seq', 'kind', 'name', 'input', 'is_error'])
      .where('session_id', '=', sessionId)
      .where('seq', '>', after)
      .orderBy('seq')
      .limit(PAGE)
      .execute();
    for (const e of page) {
      acc.add({ kind: e.kind, name: e.name, input: e.input, isError: asBool(e.is_error) });
    }
    const last = page.at(-1);
    if (!last || page.length < PAGE) break;
    after = last.seq;
  }
  const s = acc.result();
  const values = {
    failed_tool_calls: s.failedToolCalls,
    retries: s.retries,
    repeated_commands: s.repeatedCommands,
    files_touched: s.filesTouched,
    tests_run: s.testsRun,
    signal_version: SIGNAL_VERSION,
    computed_at: now.toISOString(),
  };
  // Already inside a transaction when a forced re-ingest finishes the session.
  const transact = <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
    db.isTransaction ? fn(db) : db.transaction().execute(fn);
  await transact(async (tx) => {
    await tx
      .insertInto('signal')
      .values({ session_id: sessionId, workspace_id: workspaceId, ...values })
      .onConflict((oc) => oc.column('session_id').doUpdateSet(values))
      .execute();
    await tx
      .updateTable('session')
      .set({ status: 'ended', flagged: isFlagged(s), sampled: isSampled(sessionId) })
      .where('id', '=', sessionId)
      .execute();
  });
}
