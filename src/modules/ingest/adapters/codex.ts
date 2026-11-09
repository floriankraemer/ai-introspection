import { basename } from 'node:path';
import type { ParsedItem, RawEvent, SourceAdapter } from '../types.js';

export const CODEX_ADAPTER_VERSION = '2';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Records that carry no conversation content or duplicate a `response_item`. */
const IGNORED_EVENT_MSG = new Set([
  'user_message',
  'agent_message',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'task_started',
  'task_complete',
  'turn_aborted',
  'exec_command_begin',
  'exec_command_end',
  'patch_apply_begin',
  'patch_apply_end',
  'turn_diff',
  'background_event',
]);
/** The first "user" messages Codex injects are context, not something the person typed. */
const CONTEXT_PREFIXES = [
  '<environment_context>',
  '# AGENTS.md instructions',
  '<user_instructions>',
];
const SHELL_TOOLS = new Set(['shell', 'local_shell', 'exec_command', 'container.exec']);
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isObject(b) ? (str(b.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** `function_call_output.output` is plain text, or JSON with `output` and `metadata.exit_code`. */
function parseOutput(raw: unknown): { output: string; isError: boolean } {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  try {
    const j: unknown = JSON.parse(text);
    if (isObject(j) && 'output' in j) {
      const meta = isObject(j.metadata) ? j.metadata : {};
      return {
        output: str(j.output) ?? JSON.stringify(j.output),
        isError: num(meta.exit_code) !== 0,
      };
    }
  } catch {
    // plain text output
  }
  return { output: text, isError: false };
}

function callEvent(payload: Json, ts: string | undefined): RawEvent {
  const name = str(payload.name) ?? (payload.type === 'local_shell_call' ? 'shell' : 'unknown');
  const callId = str(payload.call_id) ?? str(payload.id);
  const args =
    payload.type === 'local_shell_call' ? payload.action : (payload.arguments ?? payload.input);
  const input = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  const base = { ...(ts && { ts }), ...(callId && { callId }), input };
  if (name === 'apply_patch') {
    const files = [...input.matchAll(PATCH_FILE)].map((m) => m[1] ?? '');
    return { kind: 'file_op', name, ...base, input: JSON.stringify({ files, patch: input }) };
  }
  if (name.startsWith('mcp__')) return { kind: 'mcp', name, ...base };
  return { kind: 'tool_call', name: SHELL_TOOLS.has(name) ? 'shell' : name, ...base };
}

/** Rollout files: `{ timestamp, type, payload }` per line (the pre-envelope layout lacks `payload` and is accepted too). */
function parseRecord(d: Json): ParsedItem[] {
  const ts = str(d.timestamp);
  const type = str(d.type) ?? 'missing-type';
  const payload = isObject(d.payload) ? d.payload : d;
  const ptype = str(payload.type);

  if (type === 'session_meta') {
    const gitInfo = isObject(payload.git) ? payload.git : {};
    return [
      {
        type: 'meta',
        ...(str(payload.cwd) && { cwd: str(payload.cwd) }),
        ...(str(gitInfo.branch) && { branch: str(gitInfo.branch) }),
        ...(str(payload.timestamp ?? ts) && { ts: str(payload.timestamp ?? ts) }),
      },
    ];
  }
  if (type === 'turn_context') {
    return [
      {
        type: 'meta',
        ...(str(payload.cwd) && { cwd: str(payload.cwd) }),
        ...(str(payload.model) && { model: str(payload.model) }),
      },
    ];
  }
  if (type === 'event_msg') {
    if (ptype === 'token_count') {
      const info = isObject(payload.info) ? payload.info : undefined;
      const total = info && isObject(info.total_token_usage) ? info.total_token_usage : undefined;
      return total
        ? [
            {
              type: 'meta',
              totalTokens: {
                // Codex reports cached tokens as part of input_tokens.
                tokensIn: Math.max(0, num(total.input_tokens) - num(total.cached_input_tokens)),
                tokensOut: num(total.output_tokens),
                tokensCacheRead: num(total.cached_input_tokens),
                tokensCacheWrite: 0,
              },
            },
          ]
        : [];
    }
    return ptype && IGNORED_EVENT_MSG.has(ptype)
      ? []
      : [{ type: 'unknown', recordType: `event_msg:${ptype ?? '?'}`, ...(ts && { ts }) }];
  }

  const item = type === 'response_item' ? payload : d;
  const itype = type === 'response_item' ? ptype : type;
  switch (itype) {
    case 'message': {
      const role = str(item.role);
      const text = messageText(item.content);
      if (!text || (role !== 'user' && role !== 'assistant')) return [];
      const context = role === 'user' && CONTEXT_PREFIXES.some((p) => text.startsWith(p));
      return [
        {
          type: 'event',
          event: { kind: context ? 'system' : role, ...(ts && { ts }), output: text },
        },
      ];
    }
    case 'function_call':
    case 'local_shell_call':
    case 'custom_tool_call':
      return [{ type: 'event', event: callEvent(item, ts) }];
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = str(item.call_id);
      return callId
        ? [{ type: 'result', callId, ...(ts && { ts }), ...parseOutput(item.output) }]
        : [];
    }
    case 'reasoning':
      return [];
    default:
      return [{ type: 'unknown', recordType: itype ?? type, ...(ts && { ts }) }];
  }
}

export const codexAdapter: SourceAdapter = {
  agent: 'codex',
  version: CODEX_ADAPTER_VERSION,
  matches: (relativePath) => relativePath.endsWith('.jsonl'),
  /** `rollout-2025-01-01T10-00-00-<uuid>.jsonl` or `<uuid>.jsonl`; the id is the trailing UUID. */
  nativeIdFromPath: (path) => {
    const stem = basename(path, '.jsonl');
    return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(stem)?.[0] ?? stem;
  },
  createParser: () => ({
    parseLine(line) {
      let d: unknown;
      try {
        d = JSON.parse(line);
      } catch {
        return [{ type: 'unknown', recordType: 'malformed-json' }];
      }
      return isObject(d) ? parseRecord(d) : [{ type: 'unknown', recordType: 'malformed-json' }];
    },
  }),
};
