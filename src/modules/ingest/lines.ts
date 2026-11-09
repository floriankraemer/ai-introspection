import { createReadStream } from 'node:fs';

export interface LineRecord {
  /** `null` when the line exceeded `maxLine` and was dropped without buffering it. */
  text: string | null;
  /** First bytes of an oversized line, enough to recognise known bulky record types. */
  head: string;
  /** Byte offset just after this line's newline. */
  endOffset: number;
}

const NEWLINE = 0x0a;
const HEAD_BYTES = 64;

/**
 * Complete lines in bytes [start, end). A trailing line without newline is not yielded, so the caller's
 * cursor never moves past a half-written record. Memory stays bounded by `maxLine`.
 */
export async function* readLines(
  path: string,
  start: number,
  end: number,
  maxLine: number,
): AsyncGenerator<LineRecord> {
  if (end <= start) return;
  const stream = createReadStream(path, { start, end: end - 1, highWaterMark: 1024 * 1024 });
  let chunkStart = start;
  let parts: Buffer[] = [];
  let length = 0;
  let head = '';
  let oversized = false;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, pos);
      const stop = nl === -1 ? chunk.length : nl;
      if (!oversized) {
        length += stop - pos;
        if (length > maxLine) {
          oversized = true;
          head = Buffer.concat([...parts, chunk.subarray(pos, stop)])
            .subarray(0, HEAD_BYTES)
            .toString('utf8');
          parts = [];
        } else parts.push(chunk.subarray(pos, stop));
      }
      if (nl === -1) break;
      const text = oversized
        ? null
        : ((parts.length === 1 ? parts[0] : Buffer.concat(parts))?.toString('utf8') ?? '');
      yield { text, head: oversized ? head : '', endOffset: chunkStart + nl + 1 };
      parts = [];
      length = 0;
      oversized = false;
      pos = nl + 1;
    }
    chunkStart += chunk.length;
  }
}
