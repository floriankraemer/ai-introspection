import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLines } from './lines.js';

const collect = async (path: string, start: number, end: number, max: number) => {
  const out = [];
  for await (const l of readLines(path, start, end, max)) out.push(l);
  return out;
};

describe('readLines', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'introspect-lines-')), 'f.jsonl');

  it('yields complete lines with the offset after each newline, and drops a trailing partial line', async () => {
    writeFileSync(file, 'one\ntwo\npart');
    const lines = await collect(file, 0, 12, 100);
    expect(lines.map((l) => [l.text, l.endOffset])).toEqual([
      ['one', 4],
      ['two', 8],
    ]);
  });

  it('starts mid-file at a byte offset', async () => {
    writeFileSync(file, 'one\ntwo\nthree\n');
    expect((await collect(file, 4, 14, 100)).map((l) => l.text)).toEqual(['two', 'three']);
  });

  it('drops oversized lines without buffering them but keeps their head', async () => {
    writeFileSync(file, `ok\n{"type":"api-request-blob"${'x'.repeat(500)}\nafter\n`);
    const lines = await collect(file, 0, 1000, 100);
    expect(lines.map((l) => l.text)).toEqual(['ok', null, 'after']);
    expect(lines[1]?.head.startsWith('{"type":"api-request')).toBe(true);
  });

  it('handles multi-byte characters across chunk boundaries', async () => {
    const text = `${'é'.repeat(700_000)}\nnext\n`;
    writeFileSync(file, text);
    const lines = await collect(file, 0, Buffer.byteLength(text), 5_000_000);
    expect(lines[0]?.text).toBe('é'.repeat(700_000));
    expect(lines[1]?.text).toBe('next');
  });
});
