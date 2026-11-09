import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Bump when rules change; `ingest_warnings` and re-ingest key off it (ADR-0007). */
export const REDACTION_VERSION = '1';
const FIELD_TIME_BUDGET_MS = 200;
const ENTROPY_MIN_BITS = 4.0;
export const REDACTION_FAILED = '[REDACTION_FAILED]';

interface Rule {
  id: string;
  /** Lowercase literals; the rule only runs when the text contains one (cheap pre-filter). */
  keywords: readonly string[];
  /** Global regex. A named group `secret` limits the replacement to that part of the match. */
  regex: RegExp;
  /** Minimum Shannon entropy of the secret group, for rules that would otherwise match ordinary text. */
  entropy?: number;
}

// A vendored subset of the gitleaks default rules (MIT), written as JS regexes, plus the generic entropy rule.
const BUILT_IN_RULES: readonly Rule[] = [
  {
    id: 'private-key',
    keywords: ['private key'],
    regex:
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { id: 'anthropic-api-key', keywords: ['sk-ant-'], regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    id: 'openai-api-key',
    keywords: ['sk-'],
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
  },
  {
    id: 'aws-access-key',
    keywords: ['akia', 'asia', 'abia', 'acca'],
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'aws-secret-key',
    keywords: ['aws'],
    regex:
      /aws[\w.\- ]{0,30}?(?:secret|key)[\w.\- ]{0,30}?['"=:\s]{1,4}(?<secret>[0-9a-zA-Z/+]{40})\b/gi,
  },
  { id: 'github-token', keywords: ['gh'], regex: /\bgh[pousr]_[0-9A-Za-z]{36,255}\b/g },
  {
    id: 'github-fine-grained-pat',
    keywords: ['github_pat_'],
    regex: /\bgithub_pat_[0-9A-Za-z_]{22,255}\b/g,
  },
  { id: 'gitlab-pat', keywords: ['glpat-'], regex: /\bglpat-[0-9A-Za-z_-]{20,}/g },
  { id: 'slack-token', keywords: ['xox'], regex: /\bxox[abposr]-[0-9A-Za-z-]{10,}/g },
  {
    id: 'slack-webhook',
    keywords: ['hooks.slack.com'],
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  },
  {
    id: 'stripe-key',
    keywords: ['k_live_', 'k_test_'],
    regex: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  },
  { id: 'google-api-key', keywords: ['aiza'], regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm-token', keywords: ['npm_'], regex: /\bnpm_[0-9A-Za-z]{36}\b/g },
  { id: 'pypi-token', keywords: ['pypi-'], regex: /\bpypi-AgEIcHlwaS5vcmc[0-9A-Za-z_-]{50,}/g },
  { id: 'sendgrid-key', keywords: ['sg.'], regex: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b/g },
  { id: 'huggingface-token', keywords: ['hf_'], regex: /\bhf_[A-Za-z]{34}\b/g },
  { id: 'digitalocean-token', keywords: ['dop_v1_'], regex: /\bdop_v1_[a-f0-9]{64}\b/g },
  { id: 'twilio-key', keywords: ['sk'], regex: /\bSK[0-9a-fA-F]{32}\b/g },
  {
    id: 'jwt',
    keywords: ['eyj'],
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: 'bearer-token',
    keywords: ['bearer'],
    regex: /\bbearer\s+(?<secret>[A-Za-z0-9._~+/=-]{20,})/gi,
  },
  {
    id: 'url-credentials',
    keywords: ['://'],
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:(?<secret>[^\s/@]{3,})@/gi,
  },
  {
    id: 'generic-secret',
    keywords: ['secret', 'token', 'password', 'passwd', 'pwd', 'key', 'credential', 'auth'],
    regex:
      /(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]{0,20}["']?\s*[:=]\s*["']?(?<secret>[A-Za-z0-9+/_=.~-]{20,})/gi,
    entropy: ENTROPY_MIN_BITS,
  },
];

const SENSITIVE_FILE = [/^\.env(?:\..*)?$/, /\.pem$/, /^id_(?!.*\.pub$).+/];

/** Contents read from these files are redacted completely, whatever they look like. */
export function isSensitivePath(path: string): boolean {
  const name = basename(path);
  return SENSITIVE_FILE.some((re) => re.test(name));
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

export interface RedactionResult {
  text: string;
  /** The field could not be redacted in time or threw; `text` is the fail-closed marker. */
  failed: boolean;
  count: number;
}

export interface Redactor {
  redact(text: string): RedactionResult;
  /** Replaces a whole value, for contents of sensitive files. */
  redactWhole(text: string): string;
}

/** Per-install key: identical secrets get identical placeholders without being recoverable (ADR-0007). */
export function loadOrCreateRedactionKey(dataDir: string): Buffer {
  const path = join(dataDir, 'redaction.key');
  mkdirSync(dataDir, { recursive: true });
  try {
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  chmodSync(path, 0o600);
  return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
}

export function createRedactor(opts: {
  key: Buffer;
  customPatterns?: readonly string[];
  now?: () => number;
}): Redactor {
  const now = opts.now ?? (() => performance.now());
  const custom: Rule[] = (opts.customPatterns ?? []).map((p, i) => ({
    id: `custom-${String(i + 1)}`,
    keywords: [],
    regex: new RegExp(p, 'g'),
  }));
  const rules = [...BUILT_IN_RULES, ...custom];
  const placeholder = (id: string, secret: string): string =>
    `[REDACTED:${id}:${createHmac('sha256', opts.key).update(secret).digest('hex').slice(0, 8)}]`;

  return {
    redactWhole: (text) => placeholder('sensitive-file', text),
    redact(text) {
      const started = now();
      let count = 0;
      try {
        const lower = text.toLowerCase();
        let out = text;
        for (const rule of rules) {
          if (rule.keywords.length > 0 && !rule.keywords.some((k) => lower.includes(k))) continue;
          out = out.replace(rule.regex, (match: string, ...args: unknown[]) => {
            const groups = args.at(-1);
            const secret =
              typeof groups === 'object' && groups !== null
                ? (groups as { secret?: string }).secret
                : undefined;
            const target = secret ?? match;
            if (rule.entropy !== undefined && shannonEntropy(target) < rule.entropy) return match;
            count += 1;
            const replaced = placeholder(rule.id, target);
            if (secret === undefined) return replaced;
            const at = match.lastIndexOf(secret);
            return match.slice(0, at) + replaced + match.slice(at + secret.length);
          });
          if (now() - started > FIELD_TIME_BUDGET_MS)
            return { text: REDACTION_FAILED, failed: true, count };
        }
        return { text: out, failed: false, count };
      } catch {
        return { text: REDACTION_FAILED, failed: true, count };
      }
    },
  };
}
