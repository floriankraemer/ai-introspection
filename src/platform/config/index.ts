import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

const envSchema = z.object({
  INTROSPECT_DATA_DIR: z.string().min(1).optional(),
  INTROSPECT_PORT: z.coerce.number().int().min(1).max(65535).default(7317),
  INTROSPECT_HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().min(1).optional(),
});

export interface Config {
  /** Holds the SQLite file, the local API token and (later) run folders. */
  dataDir: string;
  port: number;
  host: string;
  /** `postgres://…` or `postgresql://…` for Postgres; anything else is a SQLite file path. */
  databaseUrl: string;
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
  const dataDir = INTROSPECT_DATA_DIR ?? join(homedir(), '.introspect');

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
  };
}
