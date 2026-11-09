#!/usr/bin/env node
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runImportCommand, startServer } from './platform/bootstrap.js';
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

const [command] = process.argv.slice(2);
if (command === 'serve') {
  serveCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (command === 'open') {
  openCommand();
} else if (command === 'import') {
  importCommand().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
  console.error('Usage: introspect serve | open | import [--agent <agent> --path <folder>]');
  process.exit(1);
}
