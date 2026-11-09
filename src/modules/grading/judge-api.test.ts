import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createApiJudge } from './judge-api.js';
import { JudgeCallError } from './types.js';

const request = {
  rubric: { name: 'efficiency', version: 'abc', scale: [0, 0.5, 1], body: 'Did it work?' },
  trace: '[e0] +0s user hello',
  eventCount: 1,
};

function judgeWith(response: Record<string, unknown>, sent: unknown[] = []) {
  const create = (body: unknown) => {
    sent.push(body);
    return Promise.resolve(response);
  };
  return createApiJudge({
    apiKey: () => 'sk-ant-test',
    client: () =>
      ({ beta: { messages: { create } }, messages: { create } }) as unknown as Pick<
        Anthropic,
        'messages' | 'beta'
      >,
  });
}
const usage = {
  input_tokens: 10,
  cache_creation_input_tokens: 400,
  cache_read_input_tokens: 0,
  output_tokens: 30,
};

describe('Anthropic API judge', () => {
  it('sends a cached prefix, the scale-restricted schema and parses the structured verdict', async () => {
    const sent: Record<string, unknown>[] = [];
    const judge = judgeWith(
      {
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        usage,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ score: 0.5, reason: 'Some detours.', evidenceEventIds: ['e0'] }),
          },
        ],
      },
      sent,
    );
    const result = await judge.grade(request);
    expect(result).toMatchObject({
      kind: 'verdict',
      score: 0.5,
      evidence: ['e0'],
      model: 'claude-sonnet-5-5',
      usage: { input: 10, cacheWrite: 400, cacheRead: 0, output: 30 },
    });
    const body = sent[0] as {
      model: string;
      system: string;
      messages: { content: string }[];
      output_config: {
        effort: string;
        format: { schema: { properties: { score: { enum: number[] } } } };
      };
    };
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format.schema.properties.score.enum).toEqual([0, 0.5, 1]);
    // Rubric first (system prompt), then the trace alone in the user message behind a random boundary.
    expect(body.system).toContain('Did it work?');
    expect(body.messages[0]?.content).toMatch(
      /^<trace-[0-9a-f]{24}>\n\[e0\] \+0s user hello\n<\/trace-/,
    );
  });

  it('attaches the billed usage to an answer it cannot parse, so the ledger can record it', async () => {
    const judge = judgeWith({
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      usage,
      content: [{ type: 'text', text: 'not json' }],
    });
    const err = await judge.grade(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeCallError);
    expect(err).toMatchObject({
      unusable: true,
      usage: { input: 10, cacheWrite: 400, output: 30 },
    });
    const cut = judgeWith({ model: 'm', stop_reason: 'max_tokens', usage, content: [] });
    expect(await cut.grade(request).catch((e: unknown) => e)).toMatchObject({ unusable: true });
  });

  it('turns a refusal into a refused result and still reports usage', async () => {
    const judge = judgeWith({
      model: 'claude-opus-4-8',
      stop_reason: 'refusal',
      usage,
      content: [],
    });
    expect(await judge.grade(request)).toMatchObject({ kind: 'refused', model: 'claude-opus-4-8' });
  });

  it('fails clearly without a key', async () => {
    const judge = createApiJudge({ apiKey: () => undefined });
    await expect(judge.grade(request)).rejects.toThrow(/No Anthropic API key/);
    expect(await judge.test()).toEqual({ ok: false, detail: 'No Anthropic API key is set' });
  });
});
