import { watch } from 'chokidar';

const POLL_INTERVAL_MS = 5000;

export interface SourceWatcher {
  add(root: string): void;
  close(): Promise<void>;
}

/** File events carry no state: they only tell the caller which file to look at (ADR-0005). */
export function createWatcher(opts: {
  poll: boolean;
  onFile(path: string): void;
  onError(error: unknown): void;
}): SourceWatcher {
  const watcher = watch([], {
    ignoreInitial: true,
    usePolling: opts.poll,
    interval: POLL_INTERVAL_MS,
    ignored: (path, stats) => Boolean(stats?.isFile()) && !path.endsWith('.jsonl'),
  });
  const onFile = (path: string): void => {
    opts.onFile(path);
  };
  const onError = (error: unknown): void => {
    opts.onError(error);
  };
  watcher.on('add', onFile).on('change', onFile).on('error', onError);
  return {
    add: (root) => {
      watcher.add(root);
    },
    close: () => watcher.close(),
  };
}
