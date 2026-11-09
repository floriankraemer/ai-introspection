import type { RedactedTrace, TraceRecord } from '../ingest/index.js';

/** ADR-0006: the judge input is capped at about 50,000 tokens. */
export const MAX_TRACE_TOKENS = 50_000;
const HEAD_CHARS = 2000;
const TAIL_CHARS = 1000;
const MIN_HEAD_CHARS = 200;
/** Rough, deterministic, and on the high side so the cap holds; the API reports real usage. */
const CHARS_PER_TOKEN = 3;
const MAX_LISTED_REPEATS = 10;
const MESSAGE_KINDS = new Set(['user', 'assistant', 'system']);

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export interface CondensedTrace {
  text: string;
  estimatedTokens: number;
  /** `e<seq>` label to event id, for the events whose label is in `text`: shown, or folded into a "repeated" line. */
  labels: Map<string, string>;
  omittedEvents: number;
}

export const labelOf = (e: Pick<TraceRecord, 'seq'>): string => `e${String(e.seq)}`;

function clip(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n[${String(text.length - head - tail)} characters omitted]\n${text.slice(-tail)}`;
}

const CUT_NOTE = '\n[... trace cut in the middle to fit the limit ...]\n';

/** Keeps the start and the end (first request, final answer) and drops the middle. */
function cutMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - CUT_NOTE.length;
  const head = Math.floor(keep / 2);
  return text.slice(0, head) + CUT_NOTE + text.slice(text.length - (keep - head));
}

/** Labels the judge can see: the start of an entry, or the list of a "repeated" line. */
function sentLabels(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^\[(e\d+)\] \+/gm)) if (m[1]) out.add(m[1]);
  for (const m of text.matchAll(/\(repeated \d+ more times: ([^)]*)\)/g))
    for (const l of (m[1] ?? '').split(', ')) if (/^e\d+$/.test(l)) out.add(l);
  return out;
}

const indent = (text: string): string => text.replaceAll('\n', '\n    ');

const firstLine = (s: string | null): string =>
  (s ?? '').trim().split('\n')[0]?.slice(0, 200) ?? '';

interface Prepared {
  event: TraceRecord;
  /** Later copies of this error, folded into this event's line. */
  repeats: TraceRecord[];
  /** Folded into an earlier event; not rendered. */
  folded: boolean;
  /** Never dropped to fit the cap. */
  protectedFromDrop: boolean;
}

/** Repeated identical errors (same tool, same first error line) fold into their first occurrence. */
function prepare(events: readonly TraceRecord[]): Prepared[] {
  const out: Prepared[] = events.map((event) => ({
    event,
    repeats: [],
    folded: false,
    protectedFromDrop: event.isError,
  }));
  const firstOf = new Map<string, Prepared>();
  for (const p of out) {
    if (!p.event.isError || MESSAGE_KINDS.has(p.event.kind)) continue;
    const key = `${p.event.name ?? ''}|${firstLine(p.event.output)}|${firstLine(p.event.input)}`;
    const first = firstOf.get(key);
    if (first) {
      first.repeats.push(p.event);
      p.folded = true;
    } else firstOf.set(key, p);
  }
  const firstUser = out.find((p) => p.event.kind === 'user');
  if (firstUser) firstUser.protectedFromDrop = true;
  const lastAssistant = out.findLast((p) => p.event.kind === 'assistant');
  if (lastAssistant) lastAssistant.protectedFromDrop = true;
  return out;
}

function renderEvent(p: Prepared, startMs: number, head: number, tail: number): string {
  const e = p.event;
  const offset = e.ts && startMs ? Math.max(0, Math.round((Date.parse(e.ts) - startMs) / 1000)) : 0;
  const lead = `[${labelOf(e)}] +${String(offset)}s ${e.kind}${e.isError ? ' ✕' : ''}`;
  let body: string;
  if (MESSAGE_KINDS.has(e.kind)) {
    body = clip(e.output ?? e.summary, head, tail);
  } else {
    body = e.summary;
    const out = e.output?.trim();
    if (out) body += `\n  ↳ ${indent(clip(out, head, tail))}`;
  }
  let line = `${lead} ${body}`;
  if (p.repeats.length > 0) {
    const ids = p.repeats.slice(0, MAX_LISTED_REPEATS).map(labelOf).join(', ');
    const more = p.repeats.length > MAX_LISTED_REPEATS ? ', ...' : '';
    line += `\n  (repeated ${String(p.repeats.length)} more times: ${ids}${more})`;
  }
  return line;
}

function render(
  items: readonly Prepared[],
  dropped: ReadonlySet<number>,
  startMs: number,
  head: number,
  tail: number,
): string {
  const lines: string[] = [];
  let run: TraceRecord[] = [];
  const flush = (): void => {
    const first = run[0];
    const last = run.at(-1);
    if (first && last)
      lines.push(
        `[... ${String(run.length)} events omitted: ${labelOf(first)} to ${labelOf(last)} ...]`,
      );
    run = [];
  };
  for (const p of items) {
    if (p.folded) continue;
    if (dropped.has(p.event.seq)) {
      run.push(p.event);
      continue;
    }
    flush();
    lines.push(renderEvent(p, startMs, head, tail));
  }
  flush();
  return lines.join('\n');
}

/**
 * One entry per event, labelled `e<seq>` (the sequence number never changes, so labels and the
 * evidence ids derived from them stay stable). Repeated errors fold into one entry. Over the cap,
 * successful events are dropped from the middle outwards, then payloads are cut shorter; errors,
 * the first user message and the final assistant message always stay. The result depends only on
 * the trace and the cap.
 */
export function condenseTrace(trace: RedactedTrace, maxTokens = MAX_TRACE_TOKENS): CondensedTrace {
  const items = prepare(trace.events);
  const allLabels = new Map(trace.events.map((e) => [labelOf(e), e.id]));
  const firstTs = trace.events.find((e) => e.ts)?.ts;
  const startMs = firstTs ? Date.parse(firstTs) : 0;
  const droppable = items.filter((p) => !p.folded && !p.protectedFromDrop).map((p) => p.event.seq);
  const dropped = new Set<number>();
  let head = HEAD_CHARS;
  let tail = TAIL_CHARS;
  let text = render(items, dropped, startMs, head, tail);

  // Middle-out: the order in which droppable events are removed is fixed by their position.
  const middleOut: number[] = [];
  const mid = Math.floor(droppable.length / 2);
  for (let d = 0; d < droppable.length; d += 1) {
    const after = droppable[mid + d];
    const before = droppable[mid - d - 1];
    if (after !== undefined) middleOut.push(after);
    if (before !== undefined) middleOut.push(before);
  }
  while (estimateTokens(text) > maxTokens) {
    if (dropped.size < middleOut.length) {
      const step = Math.max(1, Math.ceil(middleOut.length / 20));
      for (const seq of middleOut.slice(dropped.size, dropped.size + step)) dropped.add(seq);
    } else if (head > MIN_HEAD_CHARS) {
      head = Math.max(MIN_HEAD_CHARS, Math.floor(head / 2));
      tail = Math.max(MIN_HEAD_CHARS / 2, Math.floor(tail / 2));
    } else {
      text = cutMiddle(text, maxTokens * CHARS_PER_TOKEN); // last resort; keeps the cap a hard one
      break;
    }
    text = render(items, dropped, startMs, head, tail);
  }
  const labels = new Map(
    [...sentLabels(text)].flatMap((l) => {
      const id = allLabels.get(l);
      return id === undefined ? [] : [[l, id] as const];
    }),
  );
  return { text, estimatedTokens: estimateTokens(text), labels, omittedEvents: dropped.size };
}
