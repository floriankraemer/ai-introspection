/** The one source of "now" for business logic; modules take it as a `now` dependency. */
export type Clock = () => Date;

/**
 * The real time, or, for deterministic E2E runs (env `INTROSPECT_NOW`), a clock that starts at
 * `fixedNow` and then advances with real elapsed time, so jobs, leases and timeouts still work.
 */
export function createClock(fixedNow?: string): Clock {
  if (fixedNow === undefined) return () => new Date();
  const start = Date.parse(fixedNow);
  if (Number.isNaN(start)) throw new Error(`INTROSPECT_NOW is not an ISO timestamp: "${fixedNow}"`);
  const offset = start - Date.now();
  return () => new Date(Date.now() + offset);
}
