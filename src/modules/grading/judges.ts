import type { SecretStore } from '../settings/index.js';
import { createApiJudge } from './judge-api.js';
import {
  createCliJudge,
  credentialsPresent,
  isolationProblem,
  loginFile,
  type CliRunner,
} from './judge-cli.js';
import { createFakeJudge } from './judge-fake.js';
import type { Judge, JudgeTransport } from './types.js';

export interface JudgeProviderDeps {
  secrets: Pick<SecretStore, 'getJudgeKey'>;
  env: NodeJS.ProcessEnv;
  /** Which transport the settings select. */
  transport: () => Promise<'api' | 'cli'>;
  /** The judge's private HOME; it holds the judge's own `claude` login. */
  claudeHome: string;
  /** Opt-in, native only: a login file copied into `claudeHome` once. Never set in Docker. */
  claudeSeedCredentials?: string | undefined;
  sourcePaths: () => Promise<string[]>;
  /** `fake` is the test-only adapter; it comes from the environment and never from the UI. */
  override: 'fake' | undefined;
  runner?: CliRunner;
}

export interface JudgeStatus {
  transport: JudgeTransport;
  /** API: a key is stored or in the environment. */
  apiKeyPresent: boolean;
  /** CLI: the judge's own login exists in its private home. */
  cliLoginPresent: boolean;
  claudeHome: string;
  /** Why the CLI's private home would be unsafe, or null. */
  isolationProblem: string | null;
  fake: boolean;
}

export function createJudgeProvider(deps: JudgeProviderDeps) {
  const apiKey = (override?: string): string | undefined =>
    [override?.trim(), deps.secrets.getJudgeKey(), deps.env.ANTHROPIC_API_KEY].find(
      (k) => k !== undefined && k !== '',
    );

  const build = (transport: 'api' | 'cli', keyOverride?: string): Judge => {
    if (deps.override === 'fake') return createFakeJudge();
    return transport === 'api'
      ? createApiJudge({ apiKey: () => apiKey(keyOverride) })
      : createCliJudge({
          home: deps.claudeHome,
          seedCredentials: deps.claudeSeedCredentials,
          sourcePaths: deps.sourcePaths,
          ...(deps.runner && { run: deps.runner }),
        });
  };

  // One instance per transport, so the fake keeps its call log and the CLI its version check.
  const cache = new Map<string, Judge>();
  const get = (transport: 'api' | 'cli'): Judge => {
    const found = cache.get(transport);
    if (found) return found;
    const judge = build(transport);
    cache.set(transport, judge);
    return judge;
  };

  return {
    /** The judge the settings select. */
    current: async (): Promise<Judge> => get(await deps.transport()),

    /** The Settings "test connection" button: a tiny real request on the named transport. */
    test: (transport: 'api' | 'cli', key?: string): Promise<{ ok: boolean; detail: string }> =>
      build(transport, key).test(),

    async status(): Promise<JudgeStatus> {
      const transport = await deps.transport();
      return {
        transport: deps.override === 'fake' ? 'fake' : transport,
        apiKeyPresent: Boolean(apiKey()),
        cliLoginPresent: await credentialsPresent(loginFile(deps.claudeHome)),
        claudeHome: deps.claudeHome,
        isolationProblem: await isolationProblem(deps.claudeHome, await deps.sourcePaths()),
        fake: deps.override === 'fake',
      };
    },
  };
}

export type JudgeProvider = ReturnType<typeof createJudgeProvider>;
