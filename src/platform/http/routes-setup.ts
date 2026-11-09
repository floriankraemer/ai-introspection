import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { type SkillRepos } from '../../modules/improvement/index.js';
import { copyStarterRubrics } from '../../modules/rubrics/index.js';
import type { SettingsService } from '../../modules/settings/index.js';
import { ConflictError } from '../errors.js';
import type { DoctorReport } from '../doctor/index.js';
import { ApiError, problemResponses } from './problem.js';
import { security } from './schemas.js';

export interface SetupRouteDeps {
  settings: SettingsService;
  skillRepos: SkillRepos;
  /** Runs every environment check (see platform/doctor). */
  doctor: () => Promise<DoctorReport>;
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const skillRepoSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['global', 'project']),
    path: z.string(),
    hasRubrics: z.boolean(),
    enabled: z.boolean(),
    acceptMode: z.enum(['merge', 'pr']).nullable(),
  })
  .openapi('SkillRepo');

const doctorReportSchema = z
  .object({
    checks: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        status: z.enum(['ok', 'warn', 'fail']),
        detail: z.string(),
        fix: z.string().nullable(),
      }),
    ),
  })
  .openapi('DoctorReport');

const getDoctor = createRoute({
  method: 'get',
  path: '/v1/doctor',
  summary: 'Environment checks, the same as `introspect doctor`',
  security,
  responses: { 200: json(doctorReportSchema, 'One entry per check'), ...problemResponses },
});

const detectedRepoSchema = z
  .object({
    path: z.string(),
    isGitRepo: z.boolean(),
    hasRubrics: z.boolean(),
    isEmpty: z.boolean(),
  })
  .openapi('DetectedSkillRepo');

const detectSkillRepoRoute = createRoute({
  method: 'get',
  path: '/v1/skill-repos/detected',
  summary: 'Folders that look like a global skills repository (the compose mount first)',
  security,
  responses: { 200: json(z.array(detectedRepoSchema), 'Candidates'), ...problemResponses },
});

const putJudgeKey = createRoute({
  method: 'put',
  path: '/v1/settings/judge-key',
  summary: 'Store the judge API key (write-only; `judge.api_key_set` reports that it exists)',
  security,
  request: {
    body: {
      content: {
        'application/json': { schema: z.object({ apiKey: z.string().trim().min(8).max(500) }) },
      },
      required: true,
    },
  },
  responses: { 204: { description: 'Stored' }, ...problemResponses },
});

const testJudge = createRoute({
  method: 'post',
  path: '/v1/judge/test',
  summary: 'Check that the judge is reachable',
  security,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            transport: z.enum(['api', 'cli']),
            apiKey: z.string().max(500).optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: json(z.object({ ok: z.boolean(), detail: z.string() }), 'The result'),
    ...problemResponses,
  },
});

const listSkillRepos = createRoute({
  method: 'get',
  path: '/v1/skill-repos',
  summary: 'Registered skills repositories',
  security,
  responses: { 200: json(z.array(skillRepoSchema), 'The repositories'), ...problemResponses },
});

const putGlobal = createRoute({
  method: 'put',
  path: '/v1/skill-repos/global',
  summary: 'Set the global skills repository; the path must be the root of a git repository',
  security,
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ path: z.string().min(1) }) } },
      required: true,
    },
  },
  responses: { 200: json(skillRepoSchema, 'The repository'), ...problemResponses },
});

const initGlobal = createRoute({
  method: 'post',
  path: '/v1/skill-repos/global/init',
  summary:
    'Create the global skills repository in an empty folder below a mounted root: git init (main), starter rubrics, one commit',
  security,
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ path: z.string().min(1) }) } },
      required: true,
    },
  },
  responses: { 200: json(skillRepoSchema, 'The new repository'), ...problemResponses },
});

const starterRubrics = createRoute({
  method: 'post',
  path: '/v1/skill-repos/global/starter-rubrics',
  summary:
    'Copy the starter rubrics that the global repository lacks into rubrics/ and commit them',
  security,
  responses: {
    200: json(z.object({ copied: z.array(z.string()) }), 'Names of the rubrics that were added'),
    ...problemResponses,
  },
});

const patchRepo = createRoute({
  method: 'patch',
  path: '/v1/skill-repos/{id}',
  summary: 'Enable or disable a skills repository',
  security,
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } },
      required: true,
    },
  },
  responses: { 200: json(skillRepoSchema, 'The repository'), ...problemResponses },
});

export function registerSetupRoutes(
  app: OpenAPIHono,
  { settings, skillRepos, doctor }: SetupRouteDeps,
): void {
  app.openapi(putJudgeKey, (c) => {
    settings.setJudgeKey(c.req.valid('json').apiKey);
    return c.body(null, 204);
  });

  // The judge arrives in Phase 2; until then the check reports that honestly.
  app.openapi(testJudge, (c) =>
    c.json({ ok: false, detail: 'Judge not available until Phase 2' }, 200),
  );

  app.openapi(getDoctor, async (c) => c.json(await doctor(), 200));
  app.openapi(detectSkillRepoRoute, async (c) => c.json(await skillRepos.detect(), 200));
  app.openapi(listSkillRepos, async (c) => c.json(await skillRepos.list(), 200));
  app.openapi(putGlobal, async (c) =>
    c.json(await skillRepos.putGlobal(c.req.valid('json').path), 200),
  );
  app.openapi(initGlobal, async (c) =>
    c.json(await skillRepos.initGlobal(c.req.valid('json').path), 200),
  );
  app.openapi(starterRubrics, async (c) => {
    const repo = await skillRepos.getGlobal();
    if (!repo) throw new ConflictError('Set the global skills repository first');
    return c.json(await copyStarterRubrics(repo.path), 200);
  });
  app.openapi(patchRepo, async (c) => {
    const repo = await skillRepos.setEnabled(c.req.valid('param').id, c.req.valid('json').enabled);
    if (!repo) throw new ApiError(404, 'Not found', 'No such repository');
    return c.json(repo, 200);
  });
}
