import Anthropic from '@anthropic-ai/sdk';
import { buildPrompt } from './prompt.js';
import {
  JUDGE_MODEL,
  JudgeCallError,
  JudgeUnavailableError,
  verdictJsonSchema,
  verdictSchema,
  type Judge,
  type JudgeRequest,
  type JudgeResult,
  type Usage,
} from './types.js';

/** Re-runs a refused request on the fallback model the API picks (Sonnet 5.5, Claude API only). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Room for adaptive thinking plus a short verdict. */
const MAX_TOKENS = 8000;

export interface ApiJudgeOptions {
  /** The stored key, or the environment's; resolved per call so a new key takes effect at once. */
  apiKey: () => string | undefined;
  model?: string;
  /** Tests inject a client. */
  client?: (apiKey: string) => Pick<Anthropic, 'messages' | 'beta'>;
}

function describe(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'The API key may not use this model.';
  if (e instanceof Anthropic.RateLimitError)
    return 'The API rate limit is reached; try again later.';
  if (e instanceof Anthropic.APIConnectionError) return 'The Anthropic API is not reachable.';
  if (e instanceof Anthropic.APIError) return `The API answered ${String(e.status)}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Anthropic API transport: structured output (JSON schema restricted to the rubric's scale) and
 * medium effort. The rubric rides in the system prompt, ahead of the trace, and the trace sits
 * behind a per-request boundary token (ADR-0006); every request differs, so nothing is cached.
 */
export function createApiJudge(opts: ApiJudgeOptions): Judge {
  const model = opts.model ?? JUDGE_MODEL;
  const clientFor = (key: string): Pick<Anthropic, 'messages' | 'beta'> =>
    opts.client ? opts.client(key) : new Anthropic({ apiKey: key });
  const key = (): string => {
    const k = opts.apiKey();
    if (!k) throw new JudgeUnavailableError('No Anthropic API key is set');
    return k;
  };
  return {
    transport: 'api',
    model,

    async grade(req: JudgeRequest): Promise<JudgeResult> {
      const client = clientFor(key());
      const prompt = buildPrompt(req);
      let res;
      try {
        res = await client.beta.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: prompt.system,
          output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: verdictJsonSchema(req.rubric.scale) },
          },
          messages: [{ role: 'user', content: prompt.user }],
        });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError)
          throw new JudgeUnavailableError(describe(e));
        throw e;
      }
      const usage: Usage = {
        input: res.usage.input_tokens,
        cacheRead: res.usage.cache_read_input_tokens ?? 0,
        cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
        output: res.usage.output_tokens,
      };
      if (res.stop_reason === 'refusal') return { kind: 'refused', model: res.model, usage };
      // From here on the response is paid for: failures carry its usage so the ledger sees it.
      const unusable = (why: string): JudgeCallError =>
        new JudgeCallError(why, usage, res.model, true);
      if (res.stop_reason === 'max_tokens')
        throw unusable('The judge ran out of output tokens before it answered');
      const text = res.content.find((b) => b.type === 'text');
      if (text?.type !== 'text') throw unusable('The judge answered without text');
      const parsed = (() => {
        try {
          return verdictSchema.safeParse(JSON.parse(text.text));
        } catch {
          return undefined;
        }
      })();
      if (!parsed?.success)
        throw unusable('The judge answered with something that is not a verdict');
      const v = parsed.data;
      return {
        kind: 'verdict',
        score: v.score,
        reason: v.reason,
        evidence: v.evidenceEventIds,
        model: res.model,
        usage,
      };
    },

    async test() {
      try {
        const res = await clientFor(key()).messages.create({
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the word OK.' }],
        });
        return { ok: true, detail: `The Anthropic API answered as ${res.model}` };
      } catch (e) {
        return { ok: false, detail: e instanceof JudgeUnavailableError ? e.message : describe(e) };
      }
    },
  };
}
