# Playwright runner. The version tag must equal the exact @playwright/test in package.json.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /opt/e2e
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json playwright.config.ts ./
COPY seed seed
COPY tests tests
# Runs as the host user (compose.e2e.yaml); results and snapshots are bind-mounted.
ENV HOME=/tmp
