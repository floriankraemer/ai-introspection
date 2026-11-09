import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrendBucketSize, TrendMarker, Trends } from '../api/types.js';
import {
  bucketOf,
  bucketTick,
  bucketTitle,
  formatDayLocal,
  LOW_SAMPLE,
  overlapGroups,
  pct,
  rubricLabel,
  yAxis,
} from '../lib/trends.js';

export interface Series {
  name: string;
  color: string;
  target: number | null;
}

/** A vertical line on the chart: a merged change or a baseline reset. */
interface Pin {
  id: string;
  x: string;
  slot: number;
  reset: boolean;
  title: string;
  at: string;
  detail: string;
  files: string[];
  rubrics: string[];
  proposalId: string | null;
}

const HEIGHT = 320;
const MARGIN = { top: 34, right: 24, bottom: 4, left: 0 };
// Flags of pins that share a bucket stack upwards above the plot, one slot apart.
const SLOT = 22;
// Dash length of the stripes that tell identical, overlapping lines apart.
const STRIPE = 6;
const MAX_DOTS = 30;
const POPOVER_W = 288;

function pinsOf(data: Trends, series: Series[]): Pin[] {
  const shown = new Set(series.map((s) => s.name));
  const raw: Omit<Pin, 'slot'>[] = [];
  for (const m of data.markers) {
    const x = bucketOf(data.buckets, m.at);
    // A rubric change is drawn once, as a baseline reset below.
    if (
      !x ||
      m.kind === 'rubric_changed' ||
      !(m.rubrics.length === 0 || m.rubrics.some((r) => shown.has(r)))
    )
      continue;
    raw.push(pinOf(m, x));
  }
  for (const r of data.baselineResets) {
    const x = bucketOf(data.buckets, r.at);
    if (!x || !shown.has(r.rubric)) continue;
    raw.push({
      id: `reset-${r.rubric}-${r.at}`,
      x,
      reset: true,
      title: `Baseline reset: ${rubricLabel(r.rubric)}`,
      at: r.at,
      detail: r.reason,
      files: [],
      rubrics: [r.rubric],
      proposalId: null,
    });
  }
  // Pins in one bucket share a line; their flags are staggered so none hides another.
  const seen = new Map<string, number>();
  return raw.map((p) => {
    const slot = seen.get(p.x) ?? 0;
    seen.set(p.x, slot + 1);
    return { ...p, slot };
  });
}

const pinOf = (m: TrendMarker, x: string): Omit<Pin, 'slot'> => ({
  id: m.id,
  x,
  reset: false,
  title: m.title,
  at: m.at,
  detail: m.kind === 'manual_edit' ? 'Manual edit' : 'Merged proposal',
  files: m.files,
  rubrics: m.rubrics,
  proposalId: m.proposalId,
});

interface Active {
  pin: Pin;
  left: number;
  top: number;
}

export default function TrendChart({
  data,
  series,
  bucket,
  single,
}: {
  data: Trends;
  series: Series[];
  bucket: TrendBucketSize;
  /** One rubric selected: the target line and the last value are labelled. */
  single: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Active | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const rows = data.buckets.map((b) => ({
    start: b.start,
    ...Object.fromEntries(
      series.flatMap((s) => {
        const p = b.rubrics[s.name];
        return [
          [s.name, p?.passRate ?? null],
          [`${s.name}#n`, p?.graded ?? 0],
        ];
      }),
    ),
  }));
  const dots = data.buckets.length <= MAX_DOTS;
  const pins = pinsOf(data, series);
  const margin = { ...MARGIN, top: MARGIN.top + SLOT * Math.max(0, ...pins.map((p) => p.slot)) };
  const stripes = overlapGroups(
    data.buckets,
    series.map((s) => s.name),
  );
  const values = [
    ...series.flatMap((s) => data.buckets.map((b) => b.rubrics[s.name]?.passRate ?? null)),
    ...series.map((s) => s.target),
  ].filter((v): v is number => v !== null);
  // One line per distinct target: rubrics that share a target would otherwise draw on top of each other.
  const targets = [...new Set(series.map((s) => s.target).filter((t) => t !== null))];
  const axis = yAxis(values.length ? values : [0.5]);

  const open = (pin: Pin, x: number, y: number) => {
    window.clearTimeout(closeTimer.current);
    const w = box.current?.clientWidth ?? 800;
    setActive({ pin, left: Math.max(0, Math.min(x - POPOVER_W / 2, w - POPOVER_W)), top: y + 14 });
  };
  const closeSoon = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setActive(null);
    }, 150);
  };

  return (
    <div ref={box} className="relative" style={{ height: HEIGHT }}>
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 800, height: HEIGHT }}
      >
        <LineChart data={rows} margin={margin}>
          <CartesianGrid vertical={false} stroke="var(--line-soft)" />
          <XAxis
            dataKey="start"
            tickFormatter={(v: string) => bucketTick(v, bucket)}
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
            tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}
            tickMargin={8}
            minTickGap={16}
            padding={{ left: 12, right: 36 }}
          />
          <YAxis
            domain={axis.domain}
            ticks={axis.ticks}
            tickFormatter={pct}
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}
          />
          <Tooltip
            cursor={{ stroke: 'var(--ink-muted)', strokeWidth: 1 }}
            content={(p) => (
              <ChartTooltip
                label={typeof p.label === 'string' ? p.label : ''}
                bucket={bucket}
                series={series}
                row={(p.payload[0]?.payload ?? {}) as Record<string, number | null>}
              />
            )}
          />
          {targets.map((t) => (
            <ReferenceLine
              key={`t-${String(t)}`}
              y={t}
              stroke="var(--ink-muted)"
              strokeOpacity={0.7}
              strokeWidth={1.5}
              strokeDasharray="6 5"
              label={{
                value: `${pct(t)} target`,
                position: 'insideTopLeft',
                fill: 'var(--ink-muted)',
                fontSize: 12,
              }}
            />
          ))}
          {pins.map((pin) => (
            <ReferenceLine
              key={pin.id}
              x={pin.x}
              stroke={pin.reset ? 'var(--ink-muted)' : 'var(--ink)'}
              strokeWidth={1.25}
              strokeDasharray={pin.reset ? '1 4' : '4 4'}
              strokeLinecap="round"
              label={{
                position: 'top',
                content: (l) => {
                  const vb = l.viewBox as { x?: number; y?: number } | undefined;
                  return (
                    <PinFlag
                      pin={pin}
                      x={vb?.x ?? 0}
                      y={(vb?.y ?? margin.top) - 14 - pin.slot * SLOT}
                      onOpen={open}
                      onClose={closeSoon}
                      onEscape={() => {
                        setActive(null);
                      }}
                    />
                  );
                },
              }}
            />
          ))}
          {series.map((s) => {
            // Identical lines would hide each other: each gets every n-th stripe of the same dash.
            const group = stripes.find((g) => g.includes(s.name));
            const stripe = group
              ? {
                  strokeLinecap: 'butt' as const,
                  strokeDasharray: `${String(STRIPE)} ${String(STRIPE * (group.length - 1))}`,
                  strokeDashoffset: -group.indexOf(s.name) * STRIPE,
                }
              : { strokeLinecap: 'round' as const };
            return (
              <Line
                key={s.name}
                dataKey={s.name}
                name={rubricLabel(s.name)}
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                {...stripe}
                isAnimationActive={false}
                dot={dots ? (p) => <Dot key={p.index} {...dotProps(p, s)} /> : false}
                activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2, fill: s.color }}
                {...(single && {
                  label: (p: Parameters<typeof endProps>[0]) => (
                    <EndLabel {...endProps(p, rows.length)} />
                  ),
                })}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
      {active ? (
        <div
          role="group"
          aria-label={active.pin.title}
          onPointerEnter={() => {
            window.clearTimeout(closeTimer.current);
          }}
          onPointerLeave={closeSoon}
          className="absolute z-10 flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3 text-[13px] shadow-lg"
          style={{ left: active.left, top: active.top, width: POPOVER_W }}
        >
          <span className="text-xs text-muted">
            {active.pin.detail} · {formatDayLocal(active.pin.at)}
          </span>
          <strong className="font-semibold text-ink">{active.pin.title}</strong>
          {active.pin.files.length ? (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {active.pin.files.map((f) => (
                <li key={f}>
                  <code className="break-all">{f}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {active.pin.reset ? (
            <span className="text-muted">
              Comparisons across this line are not like-for-like: the rubric or judge grades
              differently after it.
            </span>
          ) : null}
          {active.pin.proposalId ? <Link to="/proposals">Open in Proposals</Link> : null}
        </div>
      ) : null}
    </div>
  );
}

interface DotArgs {
  cx?: number;
  cy?: number;
  index: number;
  value?: unknown;
  payload?: Record<string, unknown>;
}

function dotProps(p: DotArgs, s: Series) {
  const graded = Number(p.payload?.[`${s.name}#n`] ?? 0);
  return { cx: p.cx, cy: p.cy, color: s.color, empty: p.value == null, low: graded < LOW_SAMPLE };
}

/** Filled point with a surface ring; hollow (and lighter) when the bucket is a thin sample. */
function Dot({
  cx,
  cy,
  color,
  empty,
  low,
}: {
  cx?: number | undefined;
  cy?: number | undefined;
  color: string;
  empty: boolean;
  low: boolean;
}) {
  if (empty || cx === undefined || cy === undefined || Number.isNaN(cy)) return <g />;
  return low ? (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill="var(--surface)"
      stroke={color}
      strokeWidth={2}
      opacity={0.75}
    />
  ) : (
    <circle cx={cx} cy={cy} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
  );
}

function endProps(
  p: { x?: unknown; y?: unknown; value?: unknown; index?: unknown },
  count: number,
) {
  return {
    x: Number(p.x),
    y: Number(p.y),
    value: typeof p.value === 'number' ? p.value : null,
    last: p.index === count - 1,
  };
}

/** The last value in the ink colour, never the series colour (text keeps its contrast). */
function EndLabel({
  x,
  y,
  value,
  last,
}: {
  x: number;
  y: number;
  value: number | null;
  last: boolean;
}) {
  if (!last || value === null) return null;
  return (
    <text x={x} y={y - 12} textAnchor="end" fontSize={12} fontWeight={600} fill="var(--ink)">
      {pct(value)}
    </text>
  );
}

/** Flag on a vertical line: a filled dot for a change, a hollow diamond for a baseline reset. */
function PinFlag({
  pin,
  x,
  y,
  onOpen,
  onClose,
  onEscape,
}: {
  pin: Pin;
  x: number;
  y: number;
  onOpen: (pin: Pin, x: number, y: number) => void;
  onClose: () => void;
  onEscape: () => void;
}) {
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${pin.title}, ${formatDayLocal(pin.at)}`}
      className="cursor-pointer outline-none [&:focus-visible>.ring]:opacity-100"
      onPointerEnter={() => {
        onOpen(pin, x, y);
      }}
      onPointerLeave={onClose}
      onFocus={() => {
        onOpen(pin, x, y);
      }}
      onBlur={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onEscape();
      }}
    >
      <circle
        className="ring"
        cx={x}
        cy={y}
        r={12}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        opacity={0}
      />
      <circle cx={x} cy={y} r={14} fill="transparent" />
      {pin.reset ? (
        <rect
          x={x - 5}
          y={y - 5}
          width={10}
          height={10}
          transform={`rotate(45 ${String(x)} ${String(y)})`}
          fill="var(--surface)"
          stroke="var(--ink-muted)"
          strokeWidth={2}
        />
      ) : (
        <circle cx={x} cy={y} r={5} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} />
      )}
    </g>
  );
}

function ChartTooltip({
  label,
  bucket,
  series,
  row,
}: {
  label: string;
  bucket: TrendBucketSize;
  series: Series[];
  row: Record<string, number | null>;
}) {
  if (!label) return null;
  return (
    <div className="flex min-w-48 flex-col gap-1.5 rounded-lg border border-line bg-surface p-3 text-[13px] shadow-lg">
      <span className="text-xs font-semibold text-muted">{bucketTitle(label, bucket)}</span>
      {series.map((s) => {
        const rate = row[s.name] ?? null;
        const n = row[`${s.name}#n`] ?? 0;
        return (
          <div key={s.name} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-0.5 w-3.5 shrink-0 rounded"
              style={{ background: s.color }}
            />
            <strong className="font-semibold text-ink">{pct(rate)}</strong>
            <span className="text-ink-soft">{rubricLabel(s.name)}</span>
            <span className="ml-auto pl-2 text-xs text-muted">
              {n === 0 ? 'none graded' : `${String(n)} graded${n < LOW_SAMPLE ? ', low' : ''}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
