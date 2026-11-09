import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Usage } from '../grading/index.js';
import { JudgeUnavailableError } from '../grading/index.js';
import { describeTarget, evidenceBlock, newBoundary, systemPrompt } from './improver-prompt.js';
import {
  addUsage,
  IMPROVER_MODEL,
  ImproverCallError,
  NO_USAGE,
  proposalSchema,
  type ImproveRequest,
  type ImproveResult,
  type Improver,
} from './types.js';

/** Room for thinking plus whole-file edits; larger non-streaming requests risk the SDK's HTTP timeout. */
const MAX_TOKENS = 16_000;
/** Reads, then the proposal. A model that is still reading after this many turns is stopped. */
const MAX_TURNS = 10;

export interface ApiImproverOptions {
  apiKey: () => string | undefined;
  model?: string;
  /** Tests inject a client. */
  client?: (apiKey: string) => Pick<Anthropic, 'messages'>;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_files',
    description: 'Lists the files of the target you may read and change.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Returns the content of one file from list_files.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_proposal',
    description:
      'Submits the change. Give the complete new content of every file you change. Call it once, last.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'At most 80 characters, imperative' },
        rationale: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'rationale', 'edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'decline',
    description: 'Use when no instruction change would help. Say why.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

const readInput = z.object({ path: z.string() });
const declineInput = z.object({ reason: z.string().min(1) });

function describe(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected.';
  if (e instanceof Anthropic.RateLimitError)
    return 'The API rate limit is reached; try again later.';
  if (e instanceof Anthropic.APIConnectionError) return 'The Anthropic API is not reachable.';
  if (e instanceof Anthropic.APIError) return `The API answered ${String(e.status)}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Anthropic API transport: a manual tool loop with read tools over the snapshot in the request.
 * The model never gets a write or shell tool; it submits whole-file edits that Introspect applies
 * in a worktree and validates (ADR-0006, ADR-0010).
 */
export function createApiImprover(opts: ApiImproverOptions): Improver {
  const model = opts.model ?? IMPROVER_MODEL;
  const clientFor = (key: string): Pick<Anthropic, 'messages'> =>
    opts.client ? opts.client(key) : new Anthropic({ apiKey: key });

  return {
    transport: 'api',
    model,

    async propose(req: ImproveRequest): Promise<ImproveResult> {
      const key = opts.apiKey();
      if (!key) throw new JudgeUnavailableError('No Anthropic API key is set');
      const client = clientFor(key);
      const boundary = newBoundary();
      const messages: Anthropic.MessageParam[] = [
        {
          role: 'user',
          content: `${describeTarget(req)}\n\n${evidenceBlock(req, boundary)}\n\nUse list_files and read_file to look at the instruction files, then call submit_proposal, or decline.`,
        },
      ];
      let usage: Usage = NO_USAGE;
      let answered = model;
      let lastTurn = { input: 0, output: 0 };
      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        // The next turn re-sends everything so far and may answer with a full MAX_TOKENS: stop before
        // that could go past what the budget reserved (cache reads are not counted, as in the ledger).
        const spent = usage.input + usage.cacheWrite + usage.output;
        if (
          turn > 0 &&
          req.tokenCap !== undefined &&
          spent + lastTurn.input + lastTurn.output + MAX_TOKENS > req.tokenCap
        )
          return {
            kind: 'none',
            reason: `budget: stopped after ${String(turn)} turns at ${String(spent)} tokens, close to the ${String(req.tokenCap)} reserved for this call`,
            model: answered,
            usage,
            budget: true,
          };
        let res: Anthropic.Message;
        try {
          res = await client.messages.create({
            model,
            max_tokens: MAX_TOKENS,
            system: systemPrompt(boundary),
            output_config: { effort: 'high' },
            tools: TOOLS,
            messages,
          });
        } catch (e) {
          if (e instanceof Anthropic.AuthenticationError)
            throw new JudgeUnavailableError(describe(e));
          // Earlier turns of this loop were billed even when this one failed.
          throw usage === NO_USAGE ? e : new ImproverCallError(describe(e), usage, answered);
        }
        answered = res.model;
        lastTurn = {
          input: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0),
          output: res.usage.output_tokens,
        };
        usage = addUsage(usage, {
          input: res.usage.input_tokens,
          cacheRead: res.usage.cache_read_input_tokens ?? 0,
          cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
          output: res.usage.output_tokens,
        });
        if (res.stop_reason === 'refusal')
          return {
            kind: 'none',
            reason: 'The model declined this request.',
            model: answered,
            usage,
          };
        if (res.stop_reason === 'max_tokens')
          throw new ImproverCallError('The improver ran out of output tokens', usage, answered);
        const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (calls.length === 0)
          return {
            kind: 'none',
            reason: 'The improver ended without submitting a proposal.',
            model: answered,
            usage,
          };
        // The assistant turn goes back unchanged (thinking blocks included).
        messages.push({ role: 'assistant', content: res.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const call of calls) {
          if (call.name === 'submit_proposal') {
            const parsed = proposalSchema.safeParse(call.input);
            if (!parsed.success)
              throw new ImproverCallError(
                `The improver submitted something that is not a proposal: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
                usage,
                answered,
              );
            return { kind: 'proposal', ...parsed.data, model: answered, usage };
          }
          if (call.name === 'decline') {
            const parsed = declineInput.safeParse(call.input);
            return {
              kind: 'none',
              reason: parsed.success ? parsed.data.reason : 'The improver declined.',
              model: answered,
              usage,
            };
          }
          results.push(runReadTool(call, req.files));
        }
        messages.push({ role: 'user', content: results });
      }
      throw new ImproverCallError(
        `The improver was still reading after ${String(MAX_TURNS)} turns`,
        usage,
        answered,
      );
    },
  };
}

function runReadTool(
  call: Anthropic.ToolUseBlock,
  files: Readonly<Record<string, string>>,
): Anthropic.ToolResultBlockParam {
  const result = (content: string, isError = false): Anthropic.ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: call.id,
    content,
    ...(isError && { is_error: true }),
  });
  if (call.name === 'list_files') return result(Object.keys(files).join('\n') || '(no files yet)');
  if (call.name === 'read_file') {
    const input = readInput.safeParse(call.input);
    const content = input.success ? files[input.data.path] : undefined;
    return content === undefined
      ? result('No such file. Call list_files for the paths you may read.', true)
      : result(content);
  }
  return result(`Unknown tool ${call.name}`, true);
}
