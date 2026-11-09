/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { describe, expect, it } from 'vitest';
import { claudeSessionLines, codexSessionLines } from '../../../platform/testkit/agent-fixtures.js';
import type { ParsedItem } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';

const parseAll = (adapter: typeof claudeCodeAdapter, lines: string[]): ParsedItem[] => {
  const parser = adapter.createParser();
  return lines.flatMap((l) => parser.parseLine(l));
};
const events = (items: ParsedItem[]) => items.flatMap((i) => (i.type === 'event' ? [i.event] : []));

describe('claude code adapter', () => {
  const items = parseAll(claudeCodeAdapter, claudeSessionLines());

  it('maps messages and tool use onto the normalized kinds', () => {
    const e = events(items);
    expect(e.map((x) => x.kind)).toEqual(
      expect.arrayContaining(['user', 'assistant', 'tool_call', 'file_op', 'mcp', 'skill']),
    );
    expect(e.find((x) => x.callId === 'toolu_skill')).toMatchObject({
      kind: 'skill',
      name: 'e2e-testing',
    });
    expect(e.find((x) => x.callId === 'toolu_edit')).toMatchObject({
      kind: 'file_op',
      name: 'edit',
    });
    expect(e.find((x) => x.callId === 'toolu_mcp')).toMatchObject({
      kind: 'mcp',
      name: 'mcp__github__list_issues',
    });
  });

  it('emits results separately so a later chunk can complete the call', () => {
    const result = items.find((i) => i.type === 'result' && i.callId === 'toolu_t1');
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('FAIL') });
  });

  it('skips bookkeeping and snapshot records, and reports unknown record types', () => {
    const unknown = items.filter((i) => i.type === 'unknown');
    expect(unknown).toEqual([
      { type: 'unknown', recordType: 'future-record-type', ts: expect.any(String) },
    ]);
  });

  it('reports malformed JSON instead of throwing', () => {
    expect(claudeCodeAdapter.createParser().parseLine('{not json')).toEqual([
      { type: 'unknown', recordType: 'malformed-json' },
    ]);
  });

  it('accepts only top-level session files, not subagent transcripts', () => {
    expect(claudeCodeAdapter.matches('-home-me-proj/abc.jsonl')).toBe(true);
    expect(claudeCodeAdapter.matches('-home-me-proj/abc/subagents/agent-1.jsonl')).toBe(false);
    expect(claudeCodeAdapter.matches('-home-me-proj/memory/notes.md')).toBe(false);
    expect(claudeCodeAdapter.nativeIdFromPath('/x/-p/abc-123.jsonl')).toBe('abc-123');
  });
});

describe('codex adapter', () => {
  const items = parseAll(codexAdapter, codexSessionLines());

  it('maps rollout items, treating injected context as system', () => {
    const e = events(items);
    expect(e[0]).toMatchObject({ kind: 'system' });
    expect(e.find((x) => x.callId === 'call_1')).toMatchObject({
      kind: 'tool_call',
      name: 'shell',
    });
    expect(e.find((x) => x.callId === 'call_2')).toMatchObject({
      kind: 'file_op',
      name: 'apply_patch',
    });
    expect(JSON.parse(e.find((x) => x.callId === 'call_2')?.input ?? '{}')).toMatchObject({
      files: ['src/a.ts'],
    });
  });

  it('derives the error flag from the exit code and reports token totals', () => {
    expect(items.find((i) => i.type === 'result' && i.callId === 'call_1')).toMatchObject({
      isError: true,
    });
    expect(items.find((i) => i.type === 'result' && i.callId === 'call_2')).toMatchObject({
      isError: false,
    });
    expect(items.find((i) => i.type === 'meta' && i.totalTokens)).toMatchObject({
      totalTokens: { tokensIn: 500, tokensOut: 60 },
    });
  });

  it('flags records it does not know, and takes the id from the rollout file name', () => {
    expect(items.filter((i) => i.type === 'unknown')).toHaveLength(1);
    expect(
      codexAdapter.nativeIdFromPath(
        '/s/2026/10/01/rollout-2026-10-01T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001.jsonl',
      ),
    ).toBe('0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001');
  });
});
