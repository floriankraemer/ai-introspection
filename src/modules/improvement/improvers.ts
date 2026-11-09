import type { SecretStore } from '../settings/index.js';
import type { CliRunner } from '../grading/index.js';
import { createApiImprover } from './improver-api.js';
import { createCliImprover } from './improver-cli.js';
import { createFakeImprover } from './improver-fake.js';
import type { Improver } from './types.js';

export interface ImproverProviderDeps {
  secrets: Pick<SecretStore, 'getJudgeKey'>;
  env: NodeJS.ProcessEnv;
  /** `judge.transport`: one setting selects the transport of both LLM roles (ADR-0006). */
  transport: () => Promise<'api' | 'cli'>;
  claudeHome: string;
  claudeSeedCredentials?: string | undefined;
  sourcePaths: () => Promise<string[]>;
  /** `INTROSPECT_IMPROVER=fake`: test-only, environment-only. */
  override: 'fake' | undefined;
  runner?: CliRunner;
}

/** The improver the settings select; one instance per transport. */
export function createImproverProvider(deps: ImproverProviderDeps) {
  const cache = new Map<string, Improver>();
  const build = (transport: 'api' | 'cli'): Improver => {
    if (deps.override === 'fake') return createFakeImprover();
    return transport === 'api'
      ? createApiImprover({
          apiKey: () =>
            [deps.secrets.getJudgeKey(), deps.env.ANTHROPIC_API_KEY].find(
              (k) => k !== undefined && k !== '',
            ),
        })
      : createCliImprover({
          home: deps.claudeHome,
          seedCredentials: deps.claudeSeedCredentials,
          sourcePaths: deps.sourcePaths,
          ...(deps.runner && { run: deps.runner }),
        });
  };
  return {
    async current(): Promise<Improver> {
      const transport = await deps.transport();
      const key = deps.override === 'fake' ? 'fake' : transport;
      const found = cache.get(key);
      if (found) return found;
      const improver = build(transport);
      cache.set(key, improver);
      return improver;
    },
  };
}

export type ImproverProvider = ReturnType<typeof createImproverProvider>;
