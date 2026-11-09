import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiImprover } from './improver-api.js';
import { createCliImprover } from './improver-cli.js';
import { ImproverCallError, type ImproveRequest } from './types.js';

const req: ImproveRequest = {
  cluster: {
    id: 'c1',
    rubrics: ['efficiency'],
    summary: 'efficiency: 2 sessions',
    failures: [
      {
        sessionId: 's1',
        title: 'T',
        rubric: 'efficiency',
        reason: 'looped',
        evidence: ['[e1] bash ✕: x'],
      },
    ],
  },
  target: { kind: 'global', allowList: ['**'] },
  files: { 'CLAUDE.md': '# Hi\n' },
};

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const message = (content: unknown[], stop = 'tool_use') =>
  ({ model: 'claude-opus-5-5', content, stop_reason: stop, usage }) as unknown as Anthropic.Message;

function clientReturning(...replies: Anthropic.Message[]) {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const queue = [...replies];
  return {
    seen,
    client: () =>
      ({
        messages: {
          create: (p: Anthropic.MessageCreateParamsNonStreaming) => {
            seen.push(JSON.parse(JSON.stringify(p)) as Anthropic.MessageCreateParamsNonStreaming);
            const next = queue.shift();
            if (!next) throw new Error('no more replies');
            return Promise.resolve(next);
          },
        },
      }) as unknown as Pick<Anthropic, 'messages'>,
  };
}

describe('API improver', () => {
  it('reads files through tools, then submits a proposal, summing usage over turns', async () => {
    const { client, seen } = clientReturning(
      message([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'CLAUDE.md' } }]),
      message([
        {
          type: 'tool_use',
          id: 't2',
          name: 'submit_proposal',
          input: {
            title: 'Fix',
            rationale: 'because',
            edits: [{ path: 'CLAUDE.md', content: '# Hi\nmore\n' }],
          },
        },
      ]),
    );
    const out = await createApiImprover({ apiKey: () => 'k', client }).propose(req);
    expect(out).toMatchObject({ kind: 'proposal', title: 'Fix', usage: { input: 20, output: 10 } });
    // No forced tool choice, no write tool, the file content went back as a tool result.
    expect(seen[0]).toMatchObject({ model: 'claude-opus-5-5' });
    expect(seen[0]?.tool_choice).toBeUndefined();
    expect((seen[0]?.tools as { name: string }[] | undefined)?.map((t) => t.name)).toEqual([
      'list_files',
      'read_file',
      'submit_proposal',
      'decline',
    ]);
    expect(JSON.stringify(seen[1]?.messages)).toContain('# Hi');
    expect(seen[0]?.system).toMatch(/evidence token/);
  });

  it('turns a decline and a refusal into "none"', async () => {
    const decline = clientReturning(
      message([{ type: 'tool_use', id: 't', name: 'decline', input: { reason: 'one-off' } }]),
    );
    expect(
      await createApiImprover({ apiKey: () => 'k', client: decline.client }).propose(req),
    ).toMatchObject({ kind: 'none', reason: 'one-off' });
    const refused = clientReturning(message([], 'refusal'));
    expect(
      await createApiImprover({ apiKey: () => 'k', client: refused.client }).propose(req),
    ).toMatchObject({ kind: 'none' });
  });

  it('carries the billed usage on an unusable answer, and refuses without a key', async () => {
    const bad = clientReturning(
      message([{ type: 'tool_use', id: 't', name: 'submit_proposal', input: { title: '' } }]),
    );
    const err = await createApiImprover({ apiKey: () => 'k', client: bad.client })
      .propose(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImproverCallError);
    expect((err as ImproverCallError).usage.output).toBe(5);
    await expect(createApiImprover({ apiKey: () => undefined }).propose(req)).rejects.toThrow(
      /API key/,
    );
  });
});

describe('CLI improver', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'introspect-cli-imp-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"x":1}');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const runner = (result: object) => {
    const calls: { args: string[]; input: string }[] = [];
    return {
      calls,
      run: (_cmd: string, args: string[], o: { input?: string }) => {
        calls.push({ args, input: o.input ?? '' });
        const stdout = args[0] === '--version' ? '2.1.319 (Claude Code)' : JSON.stringify(result);
        return Promise.resolve({ stdout, stderr: '', code: 0 });
      },
    };
  };

  it('runs without tools, inlines the files, and parses structured output', async () => {
    const r = runner({
      structured_output: {
        title: 'Fix',
        rationale: 'why',
        declineReason: '',
        edits: [{ path: 'CLAUDE.md', content: 'x\n' }],
      },
      usage: { input_tokens: 3, output_tokens: 4 },
      modelUsage: { 'claude-opus-5-5': {} },
    });
    const out = await createCliImprover({
      home,
      sourcePaths: () => Promise.resolve([]),
      run: r.run,
    }).propose(req);
    expect(out).toMatchObject({ kind: 'proposal', title: 'Fix', usage: { input: 3, output: 4 } });
    const call = r.calls.find((c) => c.args[0] === '-p');
    expect(call?.args).toEqual(
      expect.arrayContaining([
        '--tools',
        '',
        '--setting-sources',
        '',
        '--model',
        'claude-opus-5-5',
      ]),
    );
    expect(call?.input).toContain('<file path="CLAUDE.md">');
  });

  it('treats a declineReason with no edits as a decline', async () => {
    const r = runner({
      structured_output: { title: '', rationale: '', declineReason: 'not instructions', edits: [] },
      usage: {},
    });
    expect(
      await createCliImprover({ home, sourcePaths: () => Promise.resolve([]), run: r.run }).propose(
        req,
      ),
    ).toMatchObject({ kind: 'none', reason: 'not instructions' });
  });

  it('keeps the billed usage when the answer is not a proposal', async () => {
    const r = runner({
      structured_output: { nope: 1 },
      usage: { input_tokens: 9, output_tokens: 1 },
    });
    const err = await createCliImprover({
      home,
      sourcePaths: () => Promise.resolve([]),
      run: r.run,
    })
      .propose(req)
      .catch((e: unknown) => e);
    expect((err as ImproverCallError).usage.input).toBe(9);
  });
});
