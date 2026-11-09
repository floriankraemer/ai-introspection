import pg from 'pg';
import { expect, it } from 'vitest';

it('reaches the postgres service', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; run via `make test-pg`');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ ok: number }>('select 1 as ok');
    expect(rows[0]?.ok).toBe(1);
  } finally {
    await client.end();
  }
});
