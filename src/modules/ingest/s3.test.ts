import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeS3Api } from '../../platform/testkit/s3.js';
import { Readable } from 'node:stream';
import { checkEndpoint, normalizePrefix, probeS3, safeRelative, syncS3Source } from './s3.js';

const remote = { bucket: 'b', prefix: 'team/' };
const at = new Date('2026-01-02T03:04:05Z');
const obj = (body: string) => ({ body, lastModified: at });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'introspect-s3-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('syncS3Source', () => {
  const run = async (
    api: ReturnType<typeof fakeS3Api>['api'],
    agent: 'claude_code' | 'codex',
    limits: { maxBytes?: number; notBefore?: Date } = {},
  ) => {
    const queued: string[] = [];
    const result = await syncS3Source({
      api,
      remote,
      agent,
      dir,
      maxBytes: limits.maxBytes ?? 1024,
      notBefore: limits.notBefore ?? new Date(0),
      onFile: (p) => {
        queued.push(p);
        return Promise.resolve();
      },
    });
    return { result, queued };
  };

  it('downloads matching keys only, across pages, with private modes and the object mtime', async () => {
    const { api, gets } = fakeS3Api(
      {
        'team/-proj/a.jsonl': obj('{"a":1}\n'),
        'team/-proj/b.jsonl': obj('{"b":1}\n'),
        'team/-proj/sub/deep.jsonl': obj('x'), // claude layout is <project>/<file>.jsonl
        'team/-proj/notes.txt': obj('x'),
        'other/-proj/c.jsonl': obj('x'),
      },
      { pageSize: 1 },
    );
    const { result, queued } = await run(api, 'claude_code');
    expect(result.downloaded).toBe(2);
    expect(gets.sort()).toEqual(['team/-proj/a.jsonl', 'team/-proj/b.jsonl']);
    expect(queued).toHaveLength(2);
    const file = join(dir, '-proj', 'a.jsonl');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    expect(statSync(file).mtimeMs).toBe(at.getTime());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '-proj')).mode & 0o777).toBe(0o700);
  });

  it('skips unchanged files, refetches a changed one, and keeps files deleted upstream', async () => {
    const objects = { 'team/-p/a.jsonl': obj('one\n'), 'team/-p/b.jsonl': obj('two\n') };
    await run(fakeS3Api(objects).api, 'claude_code');
    const second = fakeS3Api({ ...objects, 'team/-p/a.jsonl': obj('one more\n') });
    const { result } = await run(second.api, 'claude_code');
    expect(result.downloaded).toBe(1);
    expect(second.gets).toEqual(['team/-p/a.jsonl']);
    const third = fakeS3Api({ 'team/-p/a.jsonl': obj('one more\n') });
    expect((await run(third.api, 'claude_code')).result.downloaded).toBe(0);
    expect(readFileSync(join(dir, '-p', 'b.jsonl'), 'utf8')).toBe('two\n');
  });

  it('rejects keys that would escape the cache folder', async () => {
    const { api, gets } = fakeS3Api({
      'team/../evil.jsonl': obj('x'),
      'team/a/../../evil.jsonl': obj('x'),
      'team//x.jsonl': obj('x'),
      'team/ok/fine.jsonl': obj('x'),
    });
    const { result } = await run(api, 'codex');
    expect(gets).toEqual(['team/ok/fine.jsonl']);
    expect(result.rejected).toHaveLength(3);
    expect(readdirSync(dir)).toEqual(['ok']);
  });

  it('skips objects larger than the cap, and caps a download whose listed size was wrong', async () => {
    const { api, gets } = fakeS3Api({
      'team/-p/big.jsonl': obj('x'.repeat(11)),
      'team/-p/ok.jsonl': obj('fine\n'),
    });
    const { result } = await run(api, 'claude_code', { maxBytes: 10 });
    expect(result.tooLarge).toEqual(['team/-p/big.jsonl']);
    expect(gets).toEqual(['team/-p/ok.jsonl']);

    // The listing says 5 bytes; the body streams more.
    const lying = {
      ...fakeS3Api({ 'team/-p/lie.jsonl': obj('fine\n') }).api,
      get: () => Promise.resolve(Readable.from([Buffer.alloc(64, 'a')])),
    };
    await expect(run(lying, 'claude_code', { maxBytes: 10 })).rejects.toThrow(/larger than 10/);
    expect(readdirSync(join(dir, '-p')).sort()).toEqual(['ok.jsonl']);
  });

  it('skips objects last modified before notBefore (past retention)', async () => {
    const { api, gets } = fakeS3Api({ 'team/-p/old.jsonl': obj('x\n') });
    const { result } = await run(api, 'claude_code', { notBefore: new Date(at.getTime() + 1) });
    expect(result.downloaded).toBe(0);
    expect(gets).toEqual([]);
  });
});

describe('helpers', () => {
  it('requires https for S3 endpoints except on this machine or when allowed', () => {
    expect(() => {
      checkEndpoint('http://minio:9000', false);
    }).toThrow(/https/);
    expect(() => {
      checkEndpoint('ftp://x', true);
    }).toThrow(/https/);
    for (const [endpoint, allow] of [
      ['https://s3.example.com', false],
      ['http://127.0.0.1:9000', false],
      ['http://localhost:9000', false],
      ['http://minio:9000', true],
    ] as const)
      expect(() => {
        checkEndpoint(endpoint, allow);
      }).not.toThrow();
    expect(() => {
      checkEndpoint(undefined, false);
    }).not.toThrow();
  });

  it('normalizes prefixes and validates relative keys', () => {
    expect(normalizePrefix('/a/b')).toBe('a/b/');
    expect(normalizePrefix('')).toBe('');
    expect(safeRelative('a/', 'a/x/y.jsonl')).toBe('x/y.jsonl');
    expect(safeRelative('a/', 'a/x/..')).toBeNull();
    expect(safeRelative('a/', 'a\\b.jsonl')).toBeNull();
  });

  it('probeS3 surfaces the AWS message', async () => {
    await expect(
      probeS3(remote, fakeS3Api({}, { failWith: 'The specified bucket does not exist' }).api),
    ).rejects.toThrow(/bucket does not exist/);
  });
});
