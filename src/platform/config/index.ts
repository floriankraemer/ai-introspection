import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

const envSchema = z.object({
  INTROSPECT_DATA_DIR: z.string().min(1).optional(),
  INTROSPECT_PORT: z.coerce.number().int().min(1).max(65535).default(7317),
  INTROSPECT_HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().min(1).optional(),
  INTROSPECT_WATCH_POLL: z.enum(['0', '1']).optional(),
  CHOKIDAR_USEPOLLING: z.enum(['0', '1', 'true', 'false']).optional(),
  INTROSPECT_CLAUDE_HOME: z.string().min(1).optional(),
  INTROSPECT_CLAUDE_CREDENTIALS: z.string().min(1).optional(),
  /** Test-only: `fake` swaps the judge for a deterministic one. Never reachable from the UI. */
  INTROSPECT_JUDGE: z.enum(['fake']).optional(),
  /** Test-only: `fake` swaps the improver for a deterministic one. Environment only, never the UI. */
  INTROSPECT_IMPROVER: z.enum(['fake']).optional(),
  /** Test/E2E-only: an ISO timestamp the app clock starts at (it then advances in real time). Environment only, never the UI. */
  INTROSPECT_NOW: z
    .string()
    .min(1)
    .refine(
      (v) => !Number.isNaN(Date.parse(v)),
      'must be an ISO timestamp such as 2026-11-09T08:00:00Z',
    )
    .optional(),
  TZ: z
    .string()
    .min(1)
    .refine(isTimeZone, 'must be an IANA time zone such as Europe/Berlin')
    .default('UTC'),
});

export interface Config {
  /** Holds the SQLite file, the local API token and (later) run folders. */
  dataDir: string;
  port: number;
  host: string;
  /** `postgres://…` or `postgresql://…` for Postgres; anything else is a SQLite file path. */
  databaseUrl: string;
  /** Poll for file changes instead of using inotify (containers, network mounts). */
  watchPoll: boolean;
  /** Private HOME of the `claude -p` judge runs; never a folder an agent-log source reads. */
  claudeHome: string;
  /**
   * Opt-in, native runs only: a login file copied into `claudeHome` once. Unset by default (the
   * judge logs in on its own with `introspect judge-login`); the copy shares your refresh token.
   */
  claudeSeedCredentials: string | undefined;
  /** IANA time zone of the budget windows (env `TZ`, default UTC). */
  timeZone: string;
  judgeOverride: 'fake' | undefined;
  improverOverride: 'fake' | undefined;
  /** `INTROSPECT_NOW`: where the app clock starts; undefined means the real time. */
  fixedNow: string | undefined;
}

/** Inside a container the process must bind 0.0.0.0; the published port stays on 127.0.0.1 (compose.yaml). */
function inContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/** Bootstrap configuration from the environment (ADR-0003, overview section 7). Runtime settings live in the database. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  const { INTROSPECT_DATA_DIR, INTROSPECT_PORT, INTROSPECT_HOST, DATABASE_URL } = parsed.data;
  const { INTROSPECT_WATCH_POLL, CHOKIDAR_USEPOLLING } = parsed.data;
  const dataDir = INTROSPECT_DATA_DIR ?? join(homedir(), '.introspect');
  const { INTROSPECT_CLAUDE_HOME, INTROSPECT_CLAUDE_CREDENTIALS, INTROSPECT_JUDGE } = parsed.data;

  const loopback = LOOPBACK_HOSTS.includes(INTROSPECT_HOST);
  if (!loopback && !(INTROSPECT_HOST === '0.0.0.0' && inContainer())) {
    throw new Error(
      `Local mode binds to loopback only; INTROSPECT_HOST must be 127.0.0.1, localhost or ::1, got "${INTROSPECT_HOST}"`,
    );
  }

  return {
    dataDir,
    port: INTROSPECT_PORT,
    host: INTROSPECT_HOST,
    databaseUrl: DATABASE_URL ?? join(dataDir, 'introspect.db'),
    claudeHome: INTROSPECT_CLAUDE_HOME ?? join(dataDir, 'claude-home'),
    claudeSeedCredentials: INTROSPECT_CLAUDE_CREDENTIALS,
    timeZone: parsed.data.TZ,
    judgeOverride: INTROSPECT_JUDGE,
    improverOverride: parsed.data.INTROSPECT_IMPROVER,
    fixedNow: parsed.data.INTROSPECT_NOW,
    watchPoll:
      INTROSPECT_WATCH_POLL === '1' ||
      CHOKIDAR_USEPOLLING === '1' ||
      CHOKIDAR_USEPOLLING === 'true' ||
      (INTROSPECT_WATCH_POLL === undefined && inContainer()),
  };
}
