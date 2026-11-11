#!/usr/bin/env node
import { ConflictError } from './platform/errors.js';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  judgeLogin,
  runDoctorCommand,
  runGradeCommand,
  runImportCommand,
  runImproveCommand,
  runScanCommand,
  startServer,
} from './platform/bootstrap.js';
import { runPush } from './modules/ingest/index.js';
import { formatReport, hasFailure } from './platform/doctor/index.js';
import { rotateToken } from './platform/http/auth.js';
import { loadConfig } from './platform/config/index.js';
import { openDatabase } from './platform/db/connection.js';
import { migrateToLatest } from './platform/db/migrate.js';
import { ensureLocalIdentity } from './platform/identity/index.js';
import {
  createIntakeToken,
  listIntakeTokens,
  revokeIntakeToken,
} from './platform/identity/intake-tokens.js';

async function serveCommand(): Promise<void> {
  const server = await startServer(loadConfig());
  // Node as PID 1 ignores SIGTERM unless handled; `docker stop` would wait 10 s otherwise.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server
        .stop()
        .then(() => {
          process.exit(0);
        })
        .catch((e: unknown) => {
          console.error('shutdown failed', e);
          process.exit(1);
        });
    });
  }
}

/** Prints the URL that signs this browser in: the token travels in the fragment, never in a request. */
function openCommand(): void {
  const { dataDir, port } = loadConfig();
  const token = readFileSync(join(dataDir, 'token'), 'utf8').trim();
  console.log(`http://127.0.0.1:${String(port)}/auth#${token}`);
}

/** New token; every browser session and script that used the old one is signed out. */
function rotateTokenCommand(): void {
  const { dataDir, port } = loadConfig();
  const token = rotateToken(dataDir);
  console.log(`Token rotated. Sign in again: http://127.0.0.1:${String(port)}/auth#${token}`);
}

async function intakeTokenCommand(): Promise<void> {
  const [sub, arg] = process.argv.slice(3);
  const handle = openDatabase(loadConfig().databaseUrl);
  try {
    await migrateToLatest(handle);
    await ensureLocalIdentity(handle.db);
    if (sub === 'create' && arg) {
      const samePerson = process.argv.includes('--same-person');
      const { token } = await createIntakeToken(handle.db, arg, {
        expires: option('expires'),
        samePerson,
      }).catch((e: unknown) => {
        // The message is shared with the Settings screen; here the way out is a flag.
        if (e instanceof ConflictError && !samePerson && e.message.includes('already has a token'))
          throw new Error(`${e.message} Add --same-person to give them another one.`);
        throw e;
      });
      console.log(token);
      console.error(
        'Shown once; it cannot be displayed again. Revoke and create a new one if lost.',
      );
    } else if (sub === 'list') {
      for (const r of await listIntakeTokens(handle.db)) {
        console.log(
          [
            r.name,
            r.person,
            `created ${r.createdAt}`,
            `expires ${r.expiresAt ?? 'never'}`,
            `revoked ${r.revokedAt ?? 'no'}`,
          ].join('\t'),
        );
      }
    } else if (sub === 'revoke' && arg) {
      const n = await revokeIntakeToken(handle.db, arg);
      if (n === 0) throw new Error(`No active intake token named or with id "${arg}".`);
      console.log(`Revoked ${String(n)} token(s).`);
    } else {
      throw new Error(
        'Usage: introspect intake-token create <name> [--expires 90d] [--same-person] | list | revoke <name|id>',
      );
    }
  } finally {
    await handle.close();
  }
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function importCommand(): Promise<void> {
  const agent = option('agent');
  const path = option('path');
  let folder: { agent: 'claude_code' | 'codex'; path: string } | undefined;
  if (agent !== undefined || path !== undefined) {
    if ((agent !== 'claude_code' && agent !== 'codex') || !path) {
      throw new Error('Usage: introspect import [--agent claude_code|codex --path <folder>]');
    }
    folder = { agent, path };
  }
  const { files, events } = await runImportCommand(loadConfig(), folder);
  console.log(
    `Imported ${String(files)} files (${String(events)} events in the touched sessions).`,
  );
}

/** `7d`, `48h` or `2w` as a point in time that long ago. */
function parseSince(text: string, now = new Date()): Date {
  const m = /^(\d+)([hdw])$/.exec(text);
  if (!m) throw new Error('--since takes a number and a unit: 12h, 7d or 2w');
  const unit = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2] as 'h' | 'd' | 'w'];
  return new Date(now.getTime() - Number(m[1]) * unit);
}

const GRADE_USAGE =
  'Usage: introspect grade --session <id> | --since <12h|7d|2w> | --all [--policy]';

async function gradeCommand(): Promise<void> {
  const sessionId = option('session');
  const since = option('since');
  const all = process.argv.includes('--all');
  if ([sessionId !== undefined, since !== undefined, all].filter(Boolean).length !== 1)
    throw new Error(GRADE_USAGE);
  const summary = await runGradeCommand(loadConfig(), {
    sessionId,
    since: since === undefined ? undefined : parseSince(since),
    all,
    policy: process.argv.includes('--policy'),
  });
  console.log(
    `Graded ${String(summary.graded)}, skipped ${String(summary.skipped)}, deferred for budget ${String(summary.deferred)}, failed ${String(summary.failed)} (${String(summary.sessions)} sessions).`,
  );
  for (const [reason, n] of Object.entries(summary.skippedReasons))
    console.log(`  skipped ${String(n)}: ${reason}`);
  for (const e of summary.errors) console.error(e);
  if (summary.failed > 0) process.exit(1);
}

async function scanCommand(): Promise<void> {
  const { queued } = await runScanCommand(loadConfig());
  console.log(`Queued change scan ${queued}. The running server picks it up.`);
}

async function improveCommand(): Promise<void> {
  const now = process.argv.includes('--now');
  const out = await runImproveCommand(loadConfig(), { since: option('since') ?? '24h', now });
  if ('queued' in out) {
    console.log(
      `Queued improver job ${out.queued}. The running server picks it up; use --now to run here instead.`,
    );
    return;
  }
  const s = out.summary;
  console.log(
    `Improver run ${out.status}: ${String(out.proposalsCreated)} proposals from ${String(s.clusters.length)} clusters (${String(s.failedGrades)} failing grades).`,
  );
  for (const u of s.untrustedExcluded)
    console.log(`  excluded ${String(u.failures)} failures of "${u.rubric}": not calibrated yet`);
  for (const k of s.skippedSessions) console.log(`  skipped session ${k.sessionId}: ${k.reason}`);
  for (const c of s.clusters) console.log(`  ${c.outcome}: ${c.summary} (${c.detail})`);
  if (out.deferUntil)
    console.log(
      `Stopped by the budget: ${out.deferReason ?? ''}; resumes ${out.deferUntil.toISOString()}.`,
    );
  if (out.status === 'failed') process.exit(1);
}

/** Signs the judge in to Claude, in its own private home, never with the host's login. */
async function judgeLoginCommand(): Promise<void> {
  const { claudeHome } = loadConfig();
  console.log(
    `Signing the judge in to Claude. Its login is kept in ${claudeHome}, apart from yours.`,
  );
  const code = await judgeLogin(claudeHome);
  if (code !== 0) process.exit(code ?? 1);
}

async function doctorCommand(): Promise<void> {
  const report = await runDoctorCommand(loadConfig());
  console.log(formatReport(report));
  if (hasFailure(report)) process.exit(1);
}

const PUSH_USAGE =
  'Usage: introspect push --server <url> [--token <t>] [--redact] [--since <7d|12h>] [--dir <claude_code|codex>=<folder>]... [--dry-run] [--insecure]\n  The token is better passed as INTROSPECT_PUSH_TOKEN; the server as INTROSPECT_PUSH_URL.';

async function pushCommand(): Promise<void> {
  const args = process.argv.slice(3);
  const dirs = args
    .flatMap((a, i) => (a === '--dir' ? [args[i + 1] ?? ''] : []))
    .map((d) => {
      const [agent, ...rest] = d.split('=');
      if ((agent !== 'claude_code' && agent !== 'codex') || rest.length === 0)
        throw new Error(PUSH_USAGE);
      return { agent, path: rest.join('=') } as const;
    });
  const server = option('server') ?? process.env.INTROSPECT_PUSH_URL;
  const token = option('token') ?? process.env.INTROSPECT_PUSH_TOKEN;
  if (!server || !token) throw new Error(PUSH_USAGE);
  if (option('token') !== undefined)
    console.error(
      'Warning: --token lands in your shell history and process list; prefer INTROSPECT_PUSH_TOKEN.',
    );
  const since = option('since');
  const dryRun = process.argv.includes('--dry-run');
  const s = await runPush({
    server,
    token,
    redact: process.argv.includes('--redact'),
    since: since === undefined ? undefined : parseSince(since),
    dirs,
    dryRun,
    insecure: process.argv.includes('--insecure'),
    dataDir: loadConfig().dataDir,
    databaseUrl: loadConfig().databaseUrl,
    log: console.log,
  });
  console.log(
    `${dryRun ? 'would push' : 'pushed'} ${String(s.pushed)}, unchanged ${String(s.unchanged)}, failed ${String(s.failed)}`,
  );
  for (const e of s.errors) console.error(e);
  if (s.failed > 0) process.exit(1);
}

const [command] = process.argv.slice(2);
if (command === 'serve') {
  serveCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'open') {
  openCommand();
} else if (command === 'rotate-token') {
  rotateTokenCommand();
} else if (command === 'intake-token') {
  intakeTokenCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'doctor') {
  doctorCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'import') {
  importCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'judge-login') {
  judgeLoginCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'improve') {
  improveCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'scan') {
  scanCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'push') {
  pushCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'grade') {
  gradeCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
  console.error(
    'Usage: introspect serve | open | rotate-token | intake-token create|list|revoke | doctor | judge-login | import [--agent <agent> --path <folder>] | grade --session <id> | --since <7d> | --all [--policy] | improve [--now] [--since 24h] | scan | push --server <url> [--redact] [--since 7d] [--dir <agent>=<folder>] [--dry-run]',
  );
  process.exit(1);
}
