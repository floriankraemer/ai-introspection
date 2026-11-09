import { cliUsageOf, createCliInvoker, parseCliJson, type CliRunner } from '../grading/index.js';
import {
  describeTarget,
  evidenceBlock,
  filesBlock,
  newBoundary,
  systemPrompt,
} from './improver-prompt.js';
import {
  IMPROVER_MODEL,
  ImproverCallError,
  proposalJsonSchema,
  proposalSchema,
  type ImproveRequest,
  type ImproveResult,
  type Improver,
} from './types.js';

/** A proposal on a large file is slow; the improver runs once a night. */
const CLI_TIMEOUT_MS = 20 * 60_000;

export interface CliImproverOptions {
  home: string;
  seedCredentials?: string | undefined;
  sourcePaths: () => Promise<string[]>;
  binary?: string;
  model?: string;
  run?: CliRunner;
}

/**
 * `claude -p` transport. Same private HOME and login as the CLI judge, no tools at all: the target's
 * allowed files are inlined in the prompt, so the model cannot read anything else or write anything.
 * The answer is structured output, checked with the same schema as the API's.
 */
export function createCliImprover(opts: CliImproverOptions): Improver {
  const model = opts.model ?? IMPROVER_MODEL;
  const invoke = createCliInvoker(opts);

  return {
    transport: 'cli',
    model,

    async propose(req: ImproveRequest): Promise<ImproveResult> {
      const boundary = newBoundary();
      const out = await invoke(
        [
          '-p',
          '--output-format',
          'json',
          '--no-session-persistence',
          '--tools',
          '',
          '--setting-sources',
          '',
          '--model',
          model,
          '--system-prompt',
          systemPrompt(boundary),
          '--json-schema',
          JSON.stringify(proposalJsonSchema),
        ],
        `${describeTarget(req)}\n\n${evidenceBlock(req, boundary)}\n\nThe files you may change (complete content):\n${filesBlock(req.files, boundary) || '(none yet; you may add files)'}\n\nPropose a change, or decline with declineReason.`,
        CLI_TIMEOUT_MS,
      );
      const json = parseCliJson(out);
      const usage = cliUsageOf(json.usage as Record<string, unknown> | undefined);
      const answered = Object.keys((json.modelUsage as object | undefined) ?? {})[0] ?? model;
      if (json.is_error === true)
        throw new ImproverCallError(
          `claude reported an error: ${String(json.result).slice(0, 300)}`,
          usage,
          answered,
        );
      if (typeof json.safety_stops === 'number' && json.safety_stops > 0)
        return { kind: 'none', reason: 'The model declined this request.', model: answered, usage };
      let raw: unknown;
      try {
        raw =
          json.structured_output ??
          (typeof json.result === 'string' ? (JSON.parse(json.result) as unknown) : null);
      } catch {
        raw = null;
      }
      const decline = (raw as { declineReason?: unknown } | null)?.declineReason;
      const edits = (raw as { edits?: unknown } | null)?.edits;
      if (
        typeof decline === 'string' &&
        decline.trim() !== '' &&
        (!Array.isArray(edits) || edits.length === 0)
      )
        return { kind: 'none', reason: decline.trim(), model: answered, usage };
      const parsed = proposalSchema.safeParse(raw);
      if (!parsed.success)
        throw new ImproverCallError(
          'The improver answered with something that is not a proposal',
          usage,
          answered,
        );
      return { kind: 'proposal', ...parsed.data, model: answered, usage };
    },
  };
}
