// Writes the deterministic fixture sessions the suite imports.
// Run inside the Playwright container: `node seed/seed.ts /work/sources`.
//
// "Now" is INTROSPECT_NOW, the instant the app clock starts at (compose.e2e.yaml). Every timestamp is
// a fixed offset from it, so the data, the counts and the relative times are the same on every run.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  claudeSessionLines,
  CLAUDE_SESSION_ID,
  CODEX_SESSION_ID,
  codexSessionLines,
} from '../vendor/agent-fixtures.ts';

const root = process.argv[2];
if (!root) throw new Error('Usage: node seed/seed.ts <sources folder>');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse(process.env.INTROSPECT_NOW ?? '');
if (Number.isNaN(NOW)) throw new Error('INTROSPECT_NOW is not set');
const iso = (ms: number): string => new Date(ms).toISOString();

const claudeDir = join(root, 'claude', 'projects');
const codexDir = join(root, 'codex', 'sessions');

function write(path: string, lines: string[], endMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
  // The file went quiet when the session ended, so the session counts as ended.
  utimesSync(path, new Date(endMs), new Date(endMs));
}

/** Moves every ISO timestamp of a fixture so that its session starts at `startMs`. */
function shifted(lines: string[], fixtureStartMs: number, startMs: number): string[] {
  const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
  return lines.map((l) => l.replace(ISO, (t) => iso(Date.parse(t) - fixtureStartMs + startMs)));
}

// ---- Planted-secret Claude session and the Codex session: the shared ingest fixtures. ----
const FIXTURE_START = Date.parse('2026-10-01T10:00:00.000Z');
const secretStart = NOW - 2 * DAY - 5 * HOUR;
write(
  join(claudeDir, '-work-demo', `${CLAUDE_SESSION_ID}.jsonl`),
  shifted(claudeSessionLines(), FIXTURE_START, secretStart),
  secretStart + HOUR,
);
const codexStart = NOW - 3 * DAY - 7 * HOUR;
write(
  join(codexDir, '2026', '01', '01', `rollout-2026-01-01T00-00-00-${CODEX_SESSION_ID}.jsonl`),
  shifted(codexSessionLines(), FIXTURE_START, codexStart),
  codexStart + HOUR,
);

// ---- 34 generated Claude Code sessions over 12 weeks. ----
const VERBS = ['Fix', 'Add', 'Refactor', 'Document', 'Speed up', 'Test', 'Rename', 'Remove'];
const NOUNS = [
  'login form',
  'orders endpoint',
  'billing job',
  'search index',
  'upload handler',
  'settings page',
  'audit log',
];
const REPOS = ['alpha', 'beta', 'gamma'];
const COUNT = 34;

const uuid = (i: number): string => `e2e00000-0000-4000-8000-${String(i).padStart(12, '0')}`;

interface Spec {
  index: number;
  title: string;
  repo: string;
  startMs: number;
  failedCalls: number;
}

// Older sessions fail more often, so Trends shows a pass rate that improves over the 12 weeks.
const specs: Spec[] = Array.from({ length: COUNT }, (_, index) => {
  const failing = (index * 7 + 3) % 10 < 2 + Math.floor(index / 5);
  const daysAgo = 1 + Math.floor(index * 2.35);
  return {
    index,
    title: `${VERBS[index % VERBS.length] ?? ''} the ${NOUNS[index % NOUNS.length] ?? ''}`,
    repo: REPOS[index % REPOS.length] ?? 'alpha',
    startMs: NOW - daysAgo * DAY - (3 + ((index * 5) % 17)) * HOUR,
    // Three or more failed calls: the fake judge fails every rubric.
    failedCalls: failing ? 3 + (index % 4) : index % 3,
  };
});

const usage = {
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 40,
  output_tokens: 20,
};

function claudeLines(s: Spec): string[] {
  const id = uuid(s.index);
  const at = (sec: number): string => iso(s.startMs + sec * 1000);
  const base = (sec: number) => ({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: `/work/${s.repo}`,
    sessionId: id,
    version: '2.1.302',
    gitBranch: 'main',
    timestamp: at(sec),
  });
  const assistant = (sec: number, mid: string, content: unknown[]) => ({
    ...base(sec),
    type: 'assistant',
    message: { model: 'claude-opus-5-5', id: mid, role: 'assistant', content, usage },
  });
  const records: object[] = [
    { ...base(1), type: 'user', message: { role: 'user', content: s.title } },
    assistant(3, 'msg_a', [{ type: 'text', text: `Looking at the ${s.repo} repo.` }]),
  ];
  const calls = s.failedCalls + 2;
  for (let n = 0; n < calls; n += 1) {
    const failed = n < s.failedCalls;
    const sec = 10 + n * 10;
    records.push(
      assistant(sec, `msg_${String(n)}`, [
        {
          type: 'tool_use',
          id: `toolu_${String(n)}`,
          name: 'Bash',
          input: { command: failed ? 'pnpm test' : `ls src/${String(n)}` },
        },
      ]),
      {
        ...base(sec + 5),
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `toolu_${String(n)}`,
              content: failed ? `FAIL ${String(n + 1)} test failed` : 'ok',
              is_error: failed,
            },
          ],
        },
      },
    );
  }
  records.push(
    assistant(20 + calls * 10, 'msg_z', [{ type: 'text', text: 'Done. The change is in place.' }]),
  );
  return records.map((r) => JSON.stringify(r));
}

for (const s of specs) {
  write(
    join(claudeDir, `-work-${s.repo}`, `${uuid(s.index)}.jsonl`),
    claudeLines(s),
    s.startMs + HOUR,
  );
}

// ---- Sessions that do not come from the local folders: pushed with curl and `introspect push`, and
// read from the MinIO bucket (spec 7). Outside `sources`, so specs 1-6 never see them. ----
const extraRoot = join(root, '..', 'extra');
function extra(index: number, title: string, repo: string, dir: string): void {
  const s: Spec = {
    index,
    title,
    repo,
    startMs: NOW - DAY - 4 * HOUR - index * 60_000,
    failedCalls: 0,
  };
  write(
    join(extraRoot, dir, `-work-${repo}`, `${uuid(index)}.jsonl`),
    claudeLines(s),
    s.startMs + HOUR,
  );
}
extra(100, 'Pushed with curl', 'alpha', 'curl');
extra(104, 'Pushed by a new person', 'alpha', 'curl');
extra(101, 'Pushed with the CLI', 'beta', 'push/claude');
extra(102, 'Read from the bucket', 'gamma', 's3/claude');
extra(103, 'Second bucket session', 'gamma', 's3/claude');

console.log(`Seeded ${String(COUNT + 2)} sessions under ${root}`);
