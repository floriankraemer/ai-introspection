import { Transform } from 'node:stream';
import { PayloadTooLargeError } from './errors.js';

/** Passes at most `maxBytes` through; one byte more fails the stream with `tooLarge` (413 by default). */
export function byteCap(
  maxBytes: number,
  tooLarge: () => Error = () =>
    new PayloadTooLargeError(`The body is larger than ${String(maxBytes)} bytes`),
): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > maxBytes) done(tooLarge());
      else done(null, chunk);
    },
  });
}
