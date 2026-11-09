import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createApiJudge } from './judge-api.js';

const request = {
  rubric: { name: 'efficiency', version: 'abc', scale: [0, 0.5, 1], body: 'Did it work?' },
  trace: '[e0] +0s user hello',
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
      system: { cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown; text: string }[] }[];
      output_config: {
        effort: string;
        format: { schema: { properties: { score: { enum: number[] } } } };
      };
    };
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format.schema.properties.score.enum).toEqual([0, 0.5, 1]);
    expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    const [trace, rubric] = body.messages[0]?.content ?? [];
    expect(trace?.cache_control).toEqual({ type: 'ephemeral' });
    expect(rubric?.text).toContain('Did it work?');
    expect(rubric?.cache_control).toBeUndefined(); // the rubric comes after the breakpoint
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
