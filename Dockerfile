# syntax=docker/dockerfile:1
# One image lineage: dev (tooling, bind-mounted source), build (compile), runtime (ships).

FROM node:24-slim AS base
RUN npm install -g pnpm@12.18.0
WORKDIR /app

# ---- dev: used by compose.dev.yaml and CI. Source is bind-mounted, not copied.
FROM base AS dev
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The container runs as the host UID/GID. Named volumes inherit the mount-point
# permissions of the first mount, so these directories must be writable by any uid.
RUN mkdir -p /app/node_modules /app/web/node_modules /pnpm/store \
 && chmod 1777 /app/node_modules /app/web/node_modules /pnpm /pnpm/store
ENV HOME=/tmp/home \
    PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    INTROSPECT_HOST=0.0.0.0
EXPOSE 5173 7317
CMD ["sleep", "infinity"]

# ---- build: compile server and SPA, then drop dev dependencies.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY web/package.json web/
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.base.json tsconfig.json tsconfig.build.json ./
COPY src src
COPY web web
RUN pnpm build \
 && CI=true pnpm prune --prod

# ---- runtime: non-root, read-only root fs friendly (writes only to /data and /tmp).
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HOME=/tmp \
    INTROSPECT_HOST=0.0.0.0 \
    INTROSPECT_DATA_DIR=/data
WORKDIR /app
# git: skills repositories are read and committed to (starter rubrics, proposal branches, merges).
# gh: PR accept mode (`gh pr create`); it reads GH_TOKEN from the environment.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The claude CLI is the second judge transport (subscription login, local mode). Pinned: the adapter
# refuses an untested major version. It runs with a private HOME under /data and its own login
# (`make claude-login`); the host's login is never mounted or copied; see compose.yaml.
RUN npm install -g @anthropic-ai/claude-code@2.1.319
# /data is world-writable (sticky) so the container works with any host UID:GID.
RUN mkdir /data && chmod 1777 /data \
 && printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/introspect \
 && chmod 755 /usr/local/bin/introspect
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
USER node
VOLUME /data
EXPOSE 7317
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7317/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["introspect"]
CMD ["serve"]
