// Encodes ADR-0009 dependency rules. Zero violations allowed (`pnpm lint:deps`).
const modules = ['ingest', 'rubrics', 'grading', 'improvement', 'trends', 'settings'];

// Module -> modules it must NOT import (ADR-0009 rule 3). Allowed edges:
// rubrics->ingest; grading->ingest,rubrics; improvement->grading,ingest,rubrics;
// trends->grading,improvement; every module->settings; ingest and settings import no other module.
const forbiddenImports = {
  ingest: ['rubrics', 'grading', 'improvement', 'trends'],
  rubrics: ['grading', 'improvement', 'trends'],
  grading: ['improvement', 'trends'],
  improvement: ['trends'],
  trends: [],
  settings: ['ingest', 'rubrics', 'grading', 'improvement', 'trends'],
};

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'module-internals-private',
      comment: 'A module may only be imported through its index.ts (ADR-0009 rule 1).',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/[^/]+/(?!index\\.ts$)', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'outside-modules-use-index-only',
      comment: 'Code outside modules (platform, cli) imports modules only through index.ts.',
      severity: 'error',
      from: { path: '^src/(?!modules/)' },
      to: { path: '^src/modules/[^/]+/(?!index\\.ts$)' },
    },
    {
      name: 'platform-never-imports-modules',
      comment:
        'platform/* is a shared kernel without domain logic (ADR-0009 rule 4). ' +
        'The composition roots platform/http (thin route handlers, rule 5) and platform/bootstrap.ts call module APIs by design.',
      severity: 'error',
      from: { path: '^src/platform/(?!http/|bootstrap\\.ts$)' },
      to: { path: '^src/modules/' },
    },
    ...modules.flatMap((from) =>
      forbiddenImports[from].map((to) => ({
        name: `${from}-must-not-import-${to}`,
        comment: 'Allowed module dependency graph from ADR-0009 rule 3.',
        severity: 'error',
        from: { path: `^src/modules/${from}/` },
        to: { path: `^src/modules/${to}/` },
      })),
    ),
    {
      name: 'web-never-imports-server',
      comment: 'The SPA talks to the server over HTTP only; no shared source imports.',
      severity: 'error',
      from: { path: '^web/src/' },
      to: { path: '^src/' },
    },
    {
      name: 'server-never-imports-web',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^web/' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
