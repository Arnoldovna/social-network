# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/web/Dockerfile .
# Base images are pinned by digest (conventions §9); Dependabot (docker ecosystem) proposes updates.

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Node 25+ no longer bundles corepack. Install exactly the version in package.json#packageManager.
RUN npm install --global pnpm@10.34.9
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# The store is a cache mount, not a layer: a layer cache hit for `pnpm fetch` can come with an empty store (CI's gha
# cache, a pruned builder), so the install uses --prefer-offline, never --offline.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --filter "@app/web..."
RUN pnpm --filter "@app/web..." run build

# Unprivileged nginx (uid 101, listens on 8080). Serves the SPA and proxies /api, /health and /socket.io to the api
# service (same origin, so cookies stay SameSite=Lax).
FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
