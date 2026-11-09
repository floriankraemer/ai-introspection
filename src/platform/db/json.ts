export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/** SQLite returns the stored text, Postgres jsonb is already parsed; top-level values are always objects or arrays. */
export function fromJson(stored: unknown): unknown {
  return typeof stored === 'string' ? (JSON.parse(stored) as unknown) : stored;
}

/** SQLite returns 0/1, Postgres true/false. */
export function asBool(stored: boolean | number): boolean {
  return stored === true || stored === 1;
}
