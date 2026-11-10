import { Readable } from 'node:stream';

/** In-memory bucket with the shape of the ingest module's `S3Api`; `pageSize` forces pagination. */
export function fakeS3Api(
  objects: Record<string, { body: string; lastModified: Date }>,
  opts: { pageSize?: number; failWith?: string } = {},
) {
  const gets: string[] = [];
  const api = {
    list(prefix: string, token: string | undefined, maxKeys?: number) {
      if (opts.failWith) return Promise.reject(new Error(opts.failWith));
      const keys = Object.keys(objects)
        .filter((k) => k.startsWith(prefix))
        .sort();
      const start = token ? Number(token) : 0;
      const size = maxKeys ?? opts.pageSize ?? keys.length;
      const page = keys.slice(start, start + size);
      return Promise.resolve({
        objects: page.map((key) => {
          const o = objects[key] as { body: string; lastModified: Date };
          return { key, size: Buffer.byteLength(o.body), lastModified: o.lastModified };
        }),
        next: start + size < keys.length ? String(start + size) : undefined,
      });
    },
    get(key: string) {
      gets.push(key);
      return Promise.resolve(Readable.from([(objects[key] as { body: string }).body]));
    },
  };
  return { api, gets };
}
