import { describe, expect, it } from 'vitest';
import {
  createRedactor,
  isSensitivePath,
  REDACTION_FAILED,
  REDACTION_VERSION,
  shannonEntropy,
  unsafePatternReason,
} from './redaction.js';
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
      'token_limit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa", max_tokens: 4096, sk-learn is a library, see https://example.com/path';
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
    for (const p of [
      '/a/.env',
      '/a/.env.local',
      '/k/server.pem',
      '/h/.ssh/id_ed25519',
      '/h/.claude/.credentials.json',
      '/h/.npmrc',
      '/h/.netrc',
      '/h/.aws/credentials',
      '/k/tls.key',
      '/k/client.p12',
      '/k/client.pfx',
      '/h/.kube/config',
      '/h/kubeconfig',
      '/h/.git-credentials',
      '/h/.pgpass',
    ])
      expect(isSensitivePath(p), p).toBe(true);
    for (const p of [
      '/a/environment.ts',
      '/h/.ssh/id_ed25519.pub',
      '/a/readme.md',
      '/a/config',
      '/a/credentials',
      '/a/keys.ts',
    ])
      expect(isSensitivePath(p), p).toBe(false);
  });

  it('removes short secrets whose key name gives them away, whatever their entropy', () => {
    for (const text of [
      'password=hunter2',
      'DB_PASSWD: abcd',
      '{"api_key": "xy12"}',
      "const secret = 'aaaa';",
      'export AUTH_TOKEN=1234',
      'private-key = abcd',
    ])
      expect(redactor.redact(text).text, text).toMatch(/\[REDACTED:keyed-secret:[0-9a-f]{8}\]/);
    expect(redactor.redact('password=hunter2').text).toBe(
      `password=${/\[REDACTED:keyed-secret:[0-9a-f]{8}\]/.exec(redactor.redact('password=hunter2').text)?.[0] ?? ''}`,
    );
  });

  it('leaves placeholders, short values and unrelated keys alone', () => {
    for (const text of [
      'password=***',
      'password=${DB_PASSWORD}',
      'token: $TOKEN',
      'password=<your-password>',
      'secret={{ secrets.X }}',
      'password=abc',
      'token: null',
      'tokenizer=gpt',
      'password_hash=abcdefgh',
    ])
      expect(redactor.redact(text), text).toEqual({ text, failed: false, count: 0 });
  });

  it('bumps the redaction version', () => {
    expect(REDACTION_VERSION).toBe('2');
  });

  it('redacts 1 MB of pathological input in under a second', () => {
    const MB = 1024 * 1024;
    const inputs = [
      'a'.repeat(MB),
      `${'a.'.repeat(MB / 2 - 4)}:// x`,
      `${'user:pw:'.repeat(MB / 16)}://`,
      'x://'.repeat(MB / 4),
      'http://a:'.repeat(MB / 9),
      'a:'.repeat(MB / 2) + '@',
      'secret'.repeat(MB / 6),
      `token${' '.repeat(MB - 10)}x`,
      'password='.repeat(MB / 9),
      'aws key '.repeat(MB / 8),
      '-----BEGIN PRIVATE KEY-----'.repeat(MB / 27),
      'bearer '.repeat(MB / 7),
      'sk-'.repeat(MB / 3),
      'ghp_'.repeat(MB / 4),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redactor.redact(input);
      const ms = performance.now() - started;
      expect(ms, `${input.slice(0, 20)}... took ${String(Math.round(ms))} ms`).toBeLessThan(1000);
    }
  });

  it('still catches secrets in every chunk of a long field', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(20_000);
    const r = redactor.redact(`${filler}${SECRETS.github} ${filler}${SECRETS.aws}`);
    expect(r.text).not.toContain(SECRETS.github);
    expect(r.text).not.toContain(SECRETS.aws);
    expect(r.failed).toBe(false);
  });

  it('rejects custom patterns that can backtrack catastrophically', () => {
    for (const p of ['(a+)+$', '(a*)*b', '(.*a){10,}', '([a-z]+)*x', '(\\w+\\s?)+$'])
      expect(unsafePatternReason(p), p).not.toBeNull();
    for (const p of ['ACME-\\d{6}', '(foo|bar)-\\d+', 'tok_[a-z0-9]{20}'])
      expect(unsafePatternReason(p), p).toBeNull();
    expect(unsafePatternReason('(')).not.toBeNull();
  });

  it('never runs an unsafe custom pattern, and bounds the input of the safe ones', () => {
    const r = createRedactor({
      key: Buffer.from('k'.repeat(32)),
      customPatterns: ['(a+)+$', 'ACME-\\d{6}'],
    });
    const started = performance.now();
    const out = r.redact(`${'a'.repeat(50_000)}! ACME-123456`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.text).toMatch(/\[REDACTED:custom-2:/);
  });
});
