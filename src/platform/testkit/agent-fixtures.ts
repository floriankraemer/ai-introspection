import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Every secret here is fake. They are assembled from parts so this repository holds no complete token literal.
export const SECRETS = {
  anthropic: ['sk-ant-', 'api03-FAKEFAKEFAKEFAKEFAKEFAKE0123456789abcd'].join(''),
  github: ['ghp', '_', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234'].join(''),
  aws: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  npm: ['npm', '_', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE5678'].join(''),
  dbPassword: 'hunter2-planted-password',
  genericToken: 'INTERNAL_API_TOKEN=Zx9Kq2Lm8Vb4Nc7Rt1Yh5Gw3Pd6Sf0Ja',
  genericTokenValue: 'Zx9Kq2Lm8Vb4Nc7Rt1Yh5Gw3Pd6Sf0Ja',
  privateKeyBody: 'MIIEFAKEFAKEFAKEKEYBODYLINE1234567890',
  envFileValue: 'harmless-but-private-value-123',
} as const;

const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\n${SECRETS.privateKeyBody}\nabcdefFAKEKEYBODYLINE2\n-----END RSA PRIVATE KEY-----`;

/** Every planted string that must never reach a database column. */
export const PLANTED: readonly string[] = [
  SECRETS.anthropic,
  SECRETS.github,
  SECRETS.aws,
  SECRETS.npm,
  SECRETS.dbPassword,
  SECRETS.genericTokenValue,
  SECRETS.privateKeyBody,
  SECRETS.envFileValue,
];

export const CLAUDE_SESSION_ID = '6f1d2c3a-1111-4222-8333-444455556666';
export const CODEX_SESSION_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const ts = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

const base = (seconds: number) => ({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: '/work/demo',
  sessionId: CLAUDE_SESSION_ID,
  version: '2.1.302',
  gitBranch: 'feature/x',
  timestamp: ts(seconds),
});

const toolUse = (seconds: number, messageId: string, id: string, name: string, input: unknown) => ({
  ...base(seconds),
  type: 'assistant',
  message: {
    model: 'claude-opus-5-5',
    id: messageId,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 100,
      output_tokens: 20,
    },
  },
});

const toolResult = (seconds: number, id: string, content: unknown, isError = false) => ({
  ...base(seconds),
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});

/** A Claude Code session in the real log layout, with a secret planted in every place a secret can hide. */
export function claudeSessionLines(): string[] {
  const npmTest = (n: number) => [
    toolUse(20 + n * 10, `msg_t${String(n)}`, `toolu_t${String(n)}`, 'Bash', {
      command: 'pnpm test',
    }),
    toolResult(25 + n * 10, `toolu_t${String(n)}`, `FAIL 1 test failed (run ${String(n)})`, true),
  ];
  return [
    { type: 'permission-mode', permissionMode: 'default', sessionId: CLAUDE_SESSION_ID },
    { ...base(0), type: 'attachment', attachment: { type: 'hook_success', content: 'ignored' } },
    {
      ...base(1),
      type: 'user',
      message: { role: 'user', content: `Fix the failing build, my AWS key is ${SECRETS.aws}` },
    },
    {
      type: 'api-request-blob',
      sessionId: CLAUDE_SESSION_ID,
      message: { content: [{ type: 'text', text: SECRETS.anthropic }] },
    },
    {
      ...base(2),
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'AAAA' }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 100,
          output_tokens: 5,
        },
      },
    },
    {
      ...base(3),
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        id: 'msg_1',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Looking at it now. Found token ${SECRETS.github} in the environment.`,
          },
        ],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 100,
          output_tokens: 30,
        },
      },
    },
    toolUse(10, 'msg_2', 'toolu_env', 'Bash', {
      command: `export GITHUB_TOKEN=${SECRETS.github} && cat .npmrc`,
    }),
    toolResult(
      11,
      'toolu_env',
      `//registry.npmjs.org/:_authToken=${SECRETS.npm}\n${SECRETS.genericToken}`,
    ),
    toolUse(12, 'msg_3', 'toolu_dotenv', 'Read', { file_path: '/work/demo/.env' }),
    toolResult(13, 'toolu_dotenv', `PLAIN_PRIVATE=${SECRETS.envFileValue}`),
    toolUse(14, 'msg_4', 'toolu_db', 'Bash', { command: 'psql $DATABASE_URL' }),
    toolResult(15, 'toolu_db', [
      {
        type: 'text',
        text: `connecting to postgres://app:${SECRETS.dbPassword}@db.internal:5432/app`,
      },
      { type: 'text', text: PRIVATE_KEY },
    ]),
    ...npmTest(1),
    ...npmTest(2),
    ...npmTest(3),
    toolUse(60, 'msg_5', 'toolu_skill', 'Skill', { skill: 'e2e-testing' }),
    toolResult(61, 'toolu_skill', 'Launching skill'),
    toolUse(62, 'msg_6', 'toolu_mcp', 'mcp__github__list_issues', { repo: 'demo' }),
    toolResult(63, 'toolu_mcp', '[]'),
    toolUse(64, 'msg_7', 'toolu_edit', 'Edit', {
      file_path: '/work/demo/src/a.ts',
      old_string: 'a',
      new_string: 'b',
    }),
    toolResult(65, 'toolu_edit', 'The file has been updated'),
    { type: 'future-record-type', sessionId: CLAUDE_SESSION_ID, timestamp: ts(70) },
    {
      type: 'pr-link',
      sessionId: CLAUDE_SESSION_ID,
      prNumber: 7,
      prUrl: 'https://github.com/example/demo/pull/7',
      timestamp: ts(71),
    },
    {
      ...base(80),
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        id: 'msg_8',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done. The build passes.' }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 50,
          output_tokens: 8,
        },
      },
    },
  ].map((r) => JSON.stringify(r));
}

/**
 * Expected totals of `claudeSessionLines`. msg_1 spans two log lines and counts once with its latest usage:
 * in 10 + 9 x 10 + 2, cache read 100 + 9 x 100 + 50, cache write 5 + 9 x 5, out 30 + 9 x 20 + 8.
 */
export const CLAUDE_TOKENS = { in: 102, out: 218, cacheRead: 1050, cacheWrite: 50 };

const codexLine = (seconds: number, type: string, payload: unknown) =>
  JSON.stringify({ timestamp: ts(seconds), type, payload });

/** A Codex rollout file; format reconstructed from the public rollout layout (no real file was available). */
export function codexSessionLines(): string[] {
  return [
    codexLine(0, 'session_meta', {
      id: CODEX_SESSION_ID,
      timestamp: ts(0),
      cwd: '/work/codex-demo',
      git: { branch: 'main' },
    }),
    codexLine(1, 'turn_context', { cwd: '/work/codex-demo', model: 'gpt-5-codex' }),
    codexLine(2, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/codex-demo' }],
    }),
    codexLine(3, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `Run the tests; the token is ${SECRETS.github}` }],
    }),
    codexLine(4, 'response_item', { type: 'reasoning', summary: [] }),
    codexLine(5, 'response_item', {
      type: 'function_call',
      name: 'shell',
      call_id: 'call_1',
      arguments: JSON.stringify({
        command: ['bash', '-lc', `pnpm test --token ${SECRETS.anthropic}`],
      }),
    }),
    codexLine(7, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_1',
      output: JSON.stringify({
        output: `1 failed\n${SECRETS.genericToken}`,
        metadata: { exit_code: 1, duration_seconds: 1.5 },
      }),
    }),
    codexLine(8, 'response_item', {
      type: 'function_call',
      name: 'apply_patch',
      call_id: 'call_2',
      arguments: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch',
    }),
    codexLine(9, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_2',
      output: 'Success',
    }),
    codexLine(10, 'event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 60 },
      },
    }),
    codexLine(11, 'event_msg', { type: 'task_complete' }),
    codexLine(12, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Fixed.' }],
    }),
    codexLine(13, 'something_new', { type: 'x' }),
  ];
}

/** Writes both sessions under `root` using the agents' folder layouts; returns the source roots. */
export function writeFixtureSources(root: string): {
  claude: string;
  codex: string;
  claudeFile: string;
} {
  const claude = join(root, 'claude', 'projects');
  const codex = join(root, 'codex', 'sessions');
  const claudeFile = join(claude, '-work-demo', `${CLAUDE_SESSION_ID}.jsonl`);
  const files: [string, string[]][] = [
    [claudeFile, claudeSessionLines()],
    // Sidechain transcript of a subagent: must be skipped.
    [
      join(claude, '-work-demo', CLAUDE_SESSION_ID, 'subagents', 'agent-1.jsonl'),
      claudeSessionLines().slice(0, 3),
    ],
    [
      join(codex, '2026', '10', '01', `rollout-2026-10-01T10-00-00-${CODEX_SESSION_ID}.jsonl`),
      codexSessionLines(),
    ],
  ];
  for (const [path, lines] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join('\n')}\n`);
    // Quiet for an hour: the session counts as ended, as in a real history import.
    const quiet = new Date(T0 + 3600 * 1000);
    utimesSync(path, quiet, quiet);
  }
  return { claude, codex, claudeFile };
}
