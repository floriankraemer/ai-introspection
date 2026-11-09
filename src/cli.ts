#!/usr/bin/env node
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
import { formatReport, hasFailure } from './platform/doctor/index.js';
import { rotateToken } from './platform/http/auth.js';
import { loadConfig } from './platform/config/index.js';

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
} else if (command === 'grade') {
  gradeCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
  console.error(
    'Usage: introspect serve | open | rotate-token | doctor | judge-login | import [--agent <agent> --path <folder>] | grade --session <id> | --since <7d> | --all [--policy] | improve [--now] [--since 24h] | scan',
  );
  process.exit(1);
}
