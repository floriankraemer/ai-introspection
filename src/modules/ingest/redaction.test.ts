import { describe, expect, it } from 'vitest';
import {
  createRedactor,
  isSensitivePath,
  readsSensitiveFile,
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
      '/h/.htpasswd',
      '/h/.pypirc',
      '/h/.docker/config.json',
      '/i/prod.tfvars',
      '/i/terraform.tfstate',
      '/i/terraform.tfstate.backup',
      '/i/secrets.yaml',
      '/i/service-account-prod.json',
      '/i/release.keystore',
      '/i/trust.jks',
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
      expect(redactor.redact(text).text, text).toMatch(
        /\[REDACTED:keyed-secret(?:-quoted)?:[0-9a-f]{8}\]/,
      );
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

  const j = (command: string): string => JSON.stringify({ command });
  // [text, the secret that must not survive]; most are tool inputs, i.e. JSON text, as the audit found them.
  const LEAKS: [string, string][] = [
    ['export PASSWORD=\\"hunter2hunter2\\"', 'hunter2hunter2'],
    [j('mysql -u root --password="Tr0ub4dor&3xx" db'), 'Tr0ub4dor'],
    [j('export DB_PASSWORD="Tr0ub4dor&3xx"'), 'Tr0ub4dor'],
    [j('export DB_PASSWORD="two words here"'), 'words here'],
    [
      j('curl -H "Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3M=" https://x'),
      'dXNlcjpzdXBlcnNlY3JldHBhc3M',
    ],
    [j('curl -H "Authorization: Bearer abc123abc123abc123abc123" https://x'), 'abc123abc123abc123'],
    [
      'Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'abcdefghijklmnopqrstuvwxyz0123',
    ],
    ['Authorization: token someopaquetoken99', 'someopaquetoken99'],
    [
      'Authorization: Digest username="u", realm="r", nonce="n", response="0123456789abcdef0123456789abcdef"',
      '0123456789abcdef0123456789abcdef',
    ],
    [j('curl -u admin:SuperSecret123 https://x'), 'SuperSecret123'],
    [j('curl --user admin:SuperSecret123 https://x'), 'SuperSecret123'],
    ['mysql -pSuperSecret123 db', 'SuperSecret123'],
    [j('psql -h x -pSuperSecret123 db'), 'SuperSecret123'],
    ['--password SuperSecret123', 'SuperSecret123'],
    ['--password=SuperSecret123', 'SuperSecret123'],
    [j("tool --password 'two words'"), 'two words'],
    [
      'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab==;',
      'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
    ],
    ['SharedAccessSignature=sv=2020&sig=abcDEF123xyz;', 'abcDEF123xyz'],
    ['https://x.blob.core.windows.net/c?sv=2020&sig=abcDEF123%2Fxyz%3D', 'abcDEF123%2Fxyz'],
    ['ya29.a0AfH6SMBx7abcdefghijklmnopqrstuvwxyz1234567890', 'a0AfH6SMBx7abcdefghijklmnop'],
    ['whsec_abcdefghijklmnopqrstuvwxyz123456', 'abcdefghijklmnopqrstuvwxyz123456'],
    ['postgres://user:pa/ss@host/db', 'pa/ss'],
    ['postgres://user:p%40ss@host/db', 'p%40ss'],
    ['SECRET_KEY=abc123', 'abc123'],
    ['client_secret: abc123', 'abc123'],
    ['cookie: session=abcdefghijklmnopqrstuvwxyz123456', 'abcdefghijklmnopqrstuvwxyz123456'],
    ['Set-Cookie: sid=abcdefghijklmnopqrstuvwxyz123456', 'abcdefghijklmnopqrstuvwxyz123456'],
    [j('curl -H "Cookie: sid=abcdefghijklmnop" https://x'), 'abcdefghijklmnop'],
    ['tok​en=abcdefghijklmnopqrstuvwxyz0123', 'abcdefghijklmnopqrstuvwxyz0123'],
    ['password: "p@ss w0rd long"', 'w0rd long'],
    [JSON.stringify({ env: { API_TOKEN: 'abcd1234' } }), 'abcd1234'],
    [
      JSON.stringify({
        private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n',
      }),
      'MIIEvQ',
    ],
    ['NPM_TOKEN=abcd', 'abcd'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['password=aGVsbG8gd29ybGQgdGhpcw==', 'aGVsbG8gd29ybGQ'],
  ];

  it.each(LEAKS)('removes the secret from %j', (text, secret) => {
    const r = redactor.redact(text);
    expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThan(0);
  });

  it('keeps JSON valid after redacting its string leaves', () => {
    const r = redactor.redact(j('curl -u admin:SuperSecret123 "https://x/a b"'));
    expect(() => {
      JSON.parse(r.text);
    }).not.toThrow();
  });

  it('leaves look-alikes alone', () => {
    for (const text of [
      'mysql -p 5432 db',
      'psql -p5432 db',
      'http://localhost:3000/@scope/pkg',
      'curl -u $USER:$PASS https://x',
      'Authorization: Bearer ${TOKEN}',
      JSON.stringify({ command: 'ls -la', max_tokens: 4096 }),
    ])
      expect(redactor.redact(text), text).toEqual({ text, failed: false, count: 0 });
  });

  it('bumps the redaction version', () => {
    expect(REDACTION_VERSION).toBe('3');
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

  it('sees reads of credential files through more readers', () => {
    for (const c of [
      'cp .env /tmp/x',
      'jq . service-account.json',
      `python3 -c "print(open('.env').read())"`,
      "node -e \"require('fs').readFileSync('.npmrc')\"",
      'echo "$(<.env)"',
      'base64 .env',
      'xxd id_rsa',
      JSON.stringify({ command: 'cat ".env"' }),
    ])
      expect(readsSensitiveFile(c), c).toBe(true);
    expect(readsSensitiveFile('cat README.md')).toBe(false);
  });
});
