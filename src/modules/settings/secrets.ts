import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface SecretFile {
  judgeApiKey?: string;
}

export interface SecretStore {
  hasJudgeKey(): boolean;
  /** For the judge adapter (Phase 2). Never exposed through the API. */
  getJudgeKey(): string | undefined;
  setJudgeKey(key: string): void;
}

/** `<dataDir>/secrets`: one JSON file, mode 0600. Write-only from the API's point of view. */
export function createSecretStore(dataDir: string): SecretStore {
  const path = join(dataDir, 'secrets');
  const read = (): SecretFile =>
    existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SecretFile) : {};
  return {
    hasJudgeKey: () => Boolean(read().judgeApiKey),
    getJudgeKey: () => read().judgeApiKey,
    setJudgeKey(key) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      // Temp file + rename, so a crash never leaves a half-written secrets file.
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...read(), judgeApiKey: key }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    },
  };
}
