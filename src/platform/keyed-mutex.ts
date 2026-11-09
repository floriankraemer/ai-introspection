/** Runs async functions one at a time per key (the other keys run alongside). In-process only: one Introspect server owns its repositories. */
export interface KeyedMutex {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const result = (tails.get(key) ?? Promise.resolve()).then(fn);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}
