import { describe, expect, it } from 'vitest';
import { createRedactor, isSensitivePath, REDACTION_FAILED, shannonEntropy } from './redaction.js';
import { SECRETS } from '../../platform/testkit/agent-fixtures.js';

const redactor = createRedactor({ key: Buffer.from('k'.repeat(32)) });

describe('redaction', () => {
  it.each([
    ['anthropic-api-key', `key ${SECRETS.anthropic} end`],
    ['github-token', `token=${SECRETS.github}`],
    ['aws-access-key', `id: ${SECRETS.aws}`],
    ['npm-token', `//registry/:_authToken=${SECRETS.npm}`],
    ['url-credentials', `postgres://app:${SECRETS.dbPassword}@db:5432/app`],
    [
      'private-key',
      `-----BEGIN RSA PRIVATE KEY-----\n${SECRETS.privateKeyBody}\n-----END RSA PRIVATE KEY-----`,
    ],
    ['generic-secret', SECRETS.genericToken],
  ])('removes a %s and names the rule', (rule, text) => {
    const r = redactor.redact(text);
    expect(r.text).toMatch(new RegExp(`\\[REDACTED:${rule}:[0-9a-f]{8}\\]`));
    for (const secret of Object.values(SECRETS))
      if (text.includes(secret)) expect(r.text).not.toContain(secret);
    expect(r.failed).toBe(false);
  });

  it('keeps the surrounding text and gives identical secrets identical placeholders', () => {
    const a = redactor.redact(`use ${SECRETS.github} now`).text;
    const b = redactor.redact(`again ${SECRETS.github}`).text;
    expect(a.startsWith('use [REDACTED:github-token:')).toBe(true);
    expect(a.endsWith(' now')).toBe(true);
    const placeholder = /\[REDACTED[^\]]+\]/;
    expect(placeholder.exec(a)?.[0]).toBe(placeholder.exec(b)?.[0]);
    const other = createRedactor({ key: Buffer.from('z'.repeat(32)) }).redact(SECRETS.github).text;
    expect(other).not.toBe(redactor.redact(SECRETS.github).text);
  });

  it('leaves ordinary text and low-entropy assignments alone', () => {
    const text =
      'password = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa" and sk-learn is a library, see https://example.com/path';
    expect(redactor.redact(text)).toEqual({ text, failed: false, count: 0 });
    expect(shannonEntropy('aaaa')).toBe(0);
  });

  it('applies user-defined patterns', () => {
    const custom = createRedactor({
      key: Buffer.from('k'.repeat(32)),
      customPatterns: ['ACME-\\d{6}'],
    });
    expect(custom.redact('ticket ACME-123456').text).toMatch(/\[REDACTED:custom-1:/);
  });

  it('fails closed when a field exceeds the time budget', () => {
    let clock = 0;
    const slow = createRedactor({ key: Buffer.from('k'.repeat(32)), now: () => (clock += 500) });
    expect(slow.redact(`token ${SECRETS.github}`)).toMatchObject({
      text: REDACTION_FAILED,
      failed: true,
    });
  });

  it('recognises files whose contents are redacted completely', () => {
    for (const p of ['/a/.env', '/a/.env.local', '/k/server.pem', '/h/.ssh/id_ed25519'])
      expect(isSensitivePath(p)).toBe(true);
    for (const p of ['/a/environment.ts', '/h/.ssh/id_ed25519.pub', '/a/readme.md'])
      expect(isSensitivePath(p)).toBe(false);
  });
});
