import { basename } from 'node:path';
import type { MetaItem, ParsedItem, RawEvent, SourceAdapter } from '../types.js';

export const CLAUDE_CODE_ADAPTER_VERSION = '2';

/** Bookkeeping records that carry no conversation content; skipped without a warning. */
const IGNORED_TYPES = [
  'attachment',
  'queue-operation',
  'last-prompt',
  'mode',
  'atis-latch',
  'permission-mode',
  'ai-title',
  'agent-name',
  'custom-title',
  'bridge-session',
  'session-owner',
  'file-history-snapshot',
  'file-history-delta',
  'tools-used',
  'cost-state',
  'relocated',
  'worktree-state',
  'frame-link',
  'continued-in',
  'summary',
  'system',
  'progress',
];
const IGNORED_PREFIXES = ['api-request', 'artifact-'];
const FILE_TOOLS = new Set(['read', 'edit', 'write', 'multiedit', 'notebookedit']);
const SKILL_FILE = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function isIgnored(type: string): boolean {
  return IGNORED_TYPES.includes(type) || IGNORED_PREFIXES.some((p) => type.startsWith(p));
}

/** Text of a tool_result `content`, which is a string or a list of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isObject(b) && b.type === 'text' ? (str(b.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

function toolEvent(block: Json, ts: string | undefined): RawEvent {
  const rawName = str(block.name) ?? 'unknown';
  const name = rawName.toLowerCase();
  const input = isObject(block.input) ? block.input : {};
  const base = { name, ...(ts && { ts }), ...(str(block.id) && { callId: str(block.id) }) };
  const inputJson = JSON.stringify(input);
  if (rawName === 'Skill') {
    return { kind: 'skill', ...base, name: str(input.skill) ?? 'skill', input: inputJson };
  }
  if (rawName.startsWith('mcp__')) return { kind: 'mcp', ...base, name: rawName, input: inputJson };
  if (FILE_TOOLS.has(name)) {
    const skill = SKILL_FILE.exec(str(input.file_path) ?? '');
    return skill?.[1]
      ? { kind: 'skill', ...base, name: skill[1], input: inputJson }
      : { kind: 'file_op', ...base, input: inputJson };
  }
  return { kind: 'tool_call', ...base, input: inputJson };
}

function parseMessage(d: Json, type: 'user' | 'assistant'): ParsedItem[] {
  const out: ParsedItem[] = [];
  const ts = str(d.timestamp);
  const message = isObject(d.message) ? d.message : {};
  const meta: MetaItem = {
    type: 'meta',
    ...(str(d.cwd) && { cwd: str(d.cwd) }),
    ...(str(d.gitBranch) && { branch: str(d.gitBranch) }),
    ...(ts && { ts }),
  };
  if (type === 'assistant') {
    const model = str(message.model);
    if (model && model !== '<synthetic>') meta.model = model;
    const usage = isObject(message.usage) ? message.usage : undefined;
    const id = str(message.id);
    if (usage && id) {
      meta.usage = {
        messageId: id,
        tokensIn: num(usage.input_tokens),
        tokensOut: num(usage.output_tokens),
        tokensCacheRead: num(usage.cache_read_input_tokens),
        tokensCacheWrite: num(usage.cache_creation_input_tokens),
      };
    }
  }
  out.push(meta);

  const system = d.isMeta === true || d.isCompactSummary === true;
  const apiError = d.isApiErrorMessage === true;
  const kind = system || apiError ? 'system' : type;
  const content = message.content;
  if (typeof content === 'string') {
    out.push({
      type: 'event',
      event: { kind, ...(ts && { ts }), output: content, isError: apiError },
    });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!isObject(block)) continue;
    switch (block.type) {
      case 'text': {
        const text = str(block.text);
        if (text)
          out.push({
            type: 'event',
            event: { kind, ...(ts && { ts }), output: text, isError: apiError },
          });
        break;
      }
      case 'tool_use':
        out.push({ type: 'event', event: toolEvent(block, ts) });
        break;
      case 'tool_result': {
        const callId = str(block.tool_use_id);
        if (callId)
          out.push({
            type: 'result',
            callId,
            ...(ts && { ts }),
            output: resultText(block.content),
            isError: block.is_error === true,
          });
        break;
      }
      default:
        // thinking blocks hold only a signature in current logs; images and the rest are not trace content.
        break;
    }
  }
  return out;
}

export const claudeCodeAdapter: SourceAdapter = {
  agent: 'claude_code',
  version: CLAUDE_CODE_ADAPTER_VERSION,
  /** Top-level `<project>/<session>.jsonl` only; `<session>/subagents/*.jsonl` are sidechains of a session already logged. */
  matches: (relativePath) => /^[^/]+\/[^/]+\.jsonl$/.test(relativePath),
  nativeIdFromPath: (path) => basename(path, '.jsonl'),
  createParser: () => ({
    parseLine(line) {
      // Skip the bulky request snapshots without parsing them: they are the largest records and hold no new content.
      if (line.startsWith('{"type":"api-request')) return [];
      let d: unknown;
      try {
        d = JSON.parse(line);
      } catch {
        return [{ type: 'unknown', recordType: 'malformed-json' }];
      }
      if (!isObject(d)) return [{ type: 'unknown', recordType: 'malformed-json' }];
      const type = str(d.type) ?? 'missing-type';
      if (type === 'user' || type === 'assistant') return parseMessage(d, type);
      if (type === 'pr-link') {
        const url = str(d.prUrl);
        return url ? [{ type: 'meta', outcome: { kind: 'pr_open', ref: url } }] : [];
      }
      if (isIgnored(type)) return [];
      return [
        { type: 'unknown', recordType: type, ...(str(d.timestamp) && { ts: str(d.timestamp) }) },
      ];
    },
  }),
};
