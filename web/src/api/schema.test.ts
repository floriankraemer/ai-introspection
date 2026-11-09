import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('src/api/schema.ts is in sync with docs/api/openapi.json', () => {
  // Fails with the regenerate hint when the server's OpenAPI document changed.
  expect(() =>
    execFileSync('node', ['scripts/gen-api.mjs', '--check'], { stdio: 'pipe' }),
  ).not.toThrow();
});
