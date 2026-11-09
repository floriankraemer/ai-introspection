import type { Agent, EventKind, SessionDetail, TraceEvent } from '../api/types.js';

export const AGENT_LABEL: Record<Agent, string> = { claude_code: 'Claude Code', codex: 'Codex' };

/** "2 h ago", "Yesterday", "3 days ago" (the wording of the Sessions mockup). */
export function formatWhen(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'Just now';
  if (min < 60) return `${String(min)} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${String(h)} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'Yesterday' : `${String(d)} days ago`;
}

/** Trace offset as m:ss, with minutes padded to two digits ("13:02"). */
export function formatOffset(s: number): string {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function formatDuration(s: number): string {
  return s < 3600 ? `${String(Math.max(1, Math.round(s / 60)))} min` : `${(s / 3600).toFixed(1)} h`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return n >= 1000 ? `${String(Math.round(n / 1000))}k` : String(n);
}

/** "in 120k · out 45k · cache 17.5M"; cache is left out when there is none. */
export function formatTokenSplit(s: SessionDetail): string {
  const cache = s.tokensCacheRead + s.tokensCacheWrite;
  return [
    `in ${formatTokens(s.tokensIn)}`,
    `out ${formatTokens(s.tokensOut)}`,
    cache > 0 ? `cache ${formatTokens(cache)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The server cuts titles at 80 characters without a marker; add one unless it already ends in "…". */
export function titleText(title: string): string {
  return title.length >= 80 && !title.endsWith('…') ? `${title}…` : title;
}

/** Source names in check labels/details: `claude_code` -> "Claude Code". */
export function humanizeSources(text: string): string {
  // Not inside paths ("~/.codex/sessions", "/sources/codex"): skip names glued to path characters.
  return text
    .replace(/(?<![\w./~-])claude_code(?![\w/-])/g, AGENT_LABEL.claude_code)
    .replace(/(?<![\w./~-])codex(?![\w/.-])/g, AGENT_LABEL.codex);
}

export function formatPercent(rate: number): string {
  return `${String(Math.round(rate * 100))}%`;
}

export function outcomeLabel(o: SessionDetail['outcome']): string | null {
  if (!o.ref) return null;
  if (o.kind === 'pr_merged') return `PR #${o.ref} merged`;
  if (o.kind === 'pr_open') return `PR #${o.ref} open`;
  if (o.kind === 'commit') return `commit ${o.ref.slice(0, 7)}`;
  return null;
}

export function eventLabel(e: { kind: EventKind; name: string | null; isError: boolean }): string {
  const base =
    e.kind === 'tool_call'
      ? (e.name ?? 'tool')
      : e.kind === 'file_op'
        ? (e.name ?? 'file')
        : e.kind;
  return e.isError ? `${base} ✕` : base;
}

export type TraceRow =
  | { type: 'event'; event: TraceEvent }
  | { type: 'collapsed'; key: string; name: string | null; offsetS: number; events: TraceEvent[] };

/** Keeps the first `keep` events of each run of same-named errors; folds the rest into one row. */
export function collapseRuns(events: TraceEvent[], keep = 2): TraceRow[] {
  const rows: TraceRow[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (!e) break;
    let j = i + 1;
    if (e.isError)
      while (j < events.length && events[j]?.isError && events[j]?.name === e.name) j++;
    const run = events.slice(i, j);
    if (run.length > keep + 1) {
      for (const r of run.slice(0, keep)) rows.push({ type: 'event', event: r });
      const rest = run.slice(keep);
      rows.push({
        type: 'collapsed',
        key: `c${String(rest[0]?.seq)}`,
        name: e.name,
        offsetS: rest[0]?.offsetS ?? 0,
        events: rest,
      });
    } else for (const r of run) rows.push({ type: 'event', event: r });
    i = j;
  }
  return rows;
}
