import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { byteCap } from '../../platform/byte-cap.js';
import { InvalidInputError } from '../../platform/errors.js';
import { transportAllowed } from '../../platform/transport.js';
import { adapterFor } from './adapters/index.js';
import type { Agent } from './types.js';

/** Stored in `source.remote`. Never holds credentials: those come from the standard AWS chain. */
export interface S3Remote {
  bucket: string;
  prefix: string;
  region?: string | undefined;
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: Date;
}

/** The two calls the sync needs; tests stub this instead of the SDK. */
export interface S3Api {
  /** One page of keys under `prefix`; `maxKeys` caps the page size. */
  list(prefix: string, token: string | undefined, maxKeys?: number): Promise<S3ListPage>;
  get(key: string): Promise<Readable>;
}
export interface S3ListPage {
  objects: S3Object[];
  next: string | undefined;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** A prefix names a folder: no leading slash, one trailing slash (or empty for the whole bucket). */
export const normalizePrefix = (prefix: string): string => {
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
};

/** Credentials and logs travel to the endpoint: https only, unless it is this machine or `allowHttp` is set. */
export function checkEndpoint(endpoint: string | undefined, allowHttp: boolean): void {
  if (endpoint === undefined) return;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidInputError(`The S3 endpoint "${endpoint}" is not a URL`);
  }
  if (transportAllowed(url, allowHttp)) return;
  throw new InvalidInputError(
    `The S3 endpoint must use https:// (plain http only to this machine, or with INTROSPECT_S3_ALLOW_HTTP=1)`,
  );
}

/** Real client; region, credentials and profile resolve through the SDK's default chain. */
const clientFor = (remote: S3Remote): S3Client =>
  new S3Client({
    ...(remote.region ? { region: remote.region } : {}),
    ...(remote.endpoint ? { endpoint: remote.endpoint } : {}),
    ...(remote.forcePathStyle ? { forcePathStyle: true } : {}),
  });

export function createS3Api(remote: S3Remote, client: S3Client = clientFor(remote)): S3Api {
  return {
    async list(prefix, token, maxKeys) {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: remote.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
          ...(maxKeys ? { MaxKeys: maxKeys } : {}),
        }),
      );
      return {
        objects: (out.Contents ?? []).flatMap((o) =>
          o.Key !== undefined && o.LastModified
            ? [{ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified }]
            : [],
        ),
        next: out.IsTruncated ? out.NextContinuationToken : undefined,
      };
    },
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: remote.bucket, Key: key }));
      if (!(out.Body instanceof Readable)) throw new Error(`S3 returned no body for "${key}"`);
      return out.Body;
    },
  };
}

/** Throws the AWS error (missing credentials, no such bucket, access denied) when the bucket cannot be listed. */
export async function probeS3(remote: S3Remote, api: S3Api = createS3Api(remote)): Promise<void> {
  await api.list(normalizePrefix(remote.prefix), undefined, 1);
}

export interface S3Diagnosis {
  /** Why no AWS credentials resolve, or null. */
  credentialsError: string | null;
  /** Why the bucket cannot be listed, or null (also null when credentials are missing). */
  bucketError: string | null;
}

/** For the doctor: do credentials resolve through the standard chain, and does the bucket answer? */
export async function diagnoseS3(remote: S3Remote): Promise<S3Diagnosis> {
  const client = clientFor(remote);
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  try {
    await client.config.credentials();
  } catch (e) {
    return { credentialsError: message(e), bucketError: null };
  }
  try {
    await probeS3(remote, createS3Api(remote, client));
    return { credentialsError: null, bucketError: null };
  } catch (e) {
    return { credentialsError: null, bucketError: message(e) };
  }
}

/** The key below the prefix as a safe relative path, or null when it could leave the cache folder. */
export function safeRelative(prefix: string, key: string): string | null {
  if (!key.startsWith(prefix) || key.endsWith('/')) return null;
  const relative = key.slice(prefix.length);
  const parts = relative.split('/');
  if (
    parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))
  )
    return null;
  return relative;
}

export interface S3SyncResult {
  downloaded: number;
  /** Keys refused because they would escape the cache folder. */
  rejected: string[];
  /** Keys skipped because the object is larger than `maxBytes`. */
  tooLarge: string[];
}

/**
 * Mirrors the session logs under the bucket prefix into `dir`. A file is fetched when its size or
 * mtime differs from the object's; objects deleted in the bucket keep their local copy. Objects
 * older than `notBefore` are skipped, so the retention purge of the cache is not undone.
 * `onFile` runs for each fresh download (the caller queues the ingest).
 */
export async function syncS3Source(opts: {
  api: S3Api;
  remote: S3Remote;
  agent: Agent;
  dir: string;
  /** Largest object fetched; larger ones are skipped and the download stream is capped too. */
  maxBytes: number;
  /** Objects last modified before this are past retention: never fetched (again). */
  notBefore: Date;
  onFile: (path: string) => Promise<void>;
}): Promise<S3SyncResult> {
  const { api, agent, onFile, maxBytes } = opts;
  const prefix = normalizePrefix(opts.remote.prefix);
  const root = resolve(opts.dir);
  const adapter = adapterFor(agent);
  const result: S3SyncResult = { downloaded: 0, rejected: [], tooLarge: [] };
  await mkdir(root, { recursive: true, mode: DIR_MODE });

  let token: string | undefined;
  do {
    const page = await api.list(prefix, token);
    token = page.next;
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.jsonl')) continue;
      const relative = safeRelative(prefix, obj.key);
      const target = relative === null ? null : resolve(root, relative);
      if (relative === null || !target?.startsWith(root + sep)) {
        if (obj.key.startsWith(prefix) && !obj.key.endsWith('/')) result.rejected.push(obj.key);
        continue;
      }
      if (!adapter.matches(relative) || obj.lastModified < opts.notBefore) continue;
      if (obj.size > maxBytes) {
        result.tooLarge.push(obj.key);
        continue;
      }
      const mtimeMs = Math.floor(obj.lastModified.getTime());
      const have = await stat(target).catch(() => null);
      if (have?.size === obj.size && Math.floor(have.mtimeMs) === mtimeMs) continue;
      await mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
      const part = `${target}.${randomUUID()}.part`;
      try {
        await pipeline(
          await api.get(obj.key),
          byteCap(maxBytes),
          createWriteStream(part, { mode: FILE_MODE }),
        );
        await utimes(part, obj.lastModified, obj.lastModified);
        await rename(part, target);
      } catch (e) {
        await unlink(part).catch(() => undefined);
        throw e;
      }
      result.downloaded += 1;
      await onFile(target);
    }
  } while (token);
  return result;
}
