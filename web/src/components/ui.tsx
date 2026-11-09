import type { ComponentProps, ReactNode } from 'react';

export type ChipTone = 'pass' | 'fail' | 'warn' | 'na';

// Full class strings, never built dynamically, so Tailwind generates them.
const CHIP: Record<ChipTone, string> = {
  pass: 'text-pass bg-pass-bg border-pass-line',
  fail: 'text-fail bg-fail-bg border-fail-line',
  warn: 'text-warn bg-warn-bg border-warn-line',
  na: 'text-muted bg-sunken border-line',
};

export function Chip({
  tone = 'na',
  className = '',
  ...p
}: { tone?: ChipTone } & ComponentProps<'span'>) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs leading-4 font-semibold ${CHIP[tone]} ${className}`}
      {...p}
    />
  );
}

/** Pass / Fail / n/a chip, with the score in front when there is one ("0.2 · Fail"). */
export function VerdictChip({
  passed,
  score,
  className,
}: {
  passed: boolean | null;
  score?: number | null;
  className?: string;
}) {
  const label = passed === null ? 'n/a' : passed ? 'Pass' : 'Fail';
  return (
    <Chip
      tone={passed === null ? 'na' : passed ? 'pass' : 'fail'}
      {...(className ? { className } : {})}
    >
      {score == null ? label : `${String(score)} · ${label}`}
    </Chip>
  );
}

const BTN_BASE =
  'inline-flex h-11 items-center justify-center rounded-lg px-4 text-sm no-underline disabled:cursor-not-allowed disabled:opacity-60';
export const BTN = {
  primary: `${BTN_BASE} border-0 bg-accent font-semibold text-accent-ink hover:bg-accent-hover hover:text-accent-ink`,
  secondary: `${BTN_BASE} border border-line bg-surface text-ink hover:bg-sunken hover:text-ink`,
  dashed: `${BTN_BASE} border border-dashed border-line-dashed bg-transparent text-ink hover:bg-sunken hover:text-ink`,
} as const;

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...p
}: { variant?: keyof typeof BTN } & ComponentProps<'button'>) {
  return <button type={type} className={`${BTN[variant]} ${className}`} {...p} />;
}

export function Card({ className = '', ...p }: ComponentProps<'div'>) {
  return <div className={`rounded-xl border border-line bg-surface ${className}`} {...p} />;
}

export const FIELD =
  'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted disabled:bg-sunken disabled:text-muted';

/** Label wrapper in the mockup style: small muted caption above the control. */
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  // The hint sits outside the <label> so it does not become part of the control's accessible name.
  return (
    <div className={`flex flex-col gap-1 text-xs text-muted ${className}`}>
      <label className="flex flex-col gap-1">
        {label}
        {children}
      </label>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[28px] leading-tight font-bold">{title}</h1>
        {subtitle ? <p className="m-0 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** Empty state: always names the next step (plan principle). */
export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-start gap-3 border-dashed border-line-dashed bg-surface-alt p-8">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      <p className="m-0 max-w-xl text-sm leading-normal text-ink-soft">{children}</p>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </Card>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <p role="status" aria-busy="true" className="m-0 py-6 text-sm text-muted">
      {label}…
    </p>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl border border-fail-line bg-fail-bg p-4 text-sm text-fail"
    >
      <span>Something went wrong: {msg}</span>
      {onRetry ? (
        <Button onClick={onRetry} className="h-10">
          Try again
        </Button>
      ) : null}
    </div>
  );
}
