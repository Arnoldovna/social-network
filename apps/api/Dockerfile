# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/api/Dockerfile .
# Base images are pinned by digest (conventions §9); Dependabot (docker ecosystem) proposes updates.

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Node 25+ no longer bundles corepack. Install exactly the version in package.json#packageManager.
RUN npm install --global pnpm@10.34.9
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# The pnpm store lives in a cache mount, which is not part of any layer: a layer cache hit for `pnpm fetch` (CI's gha
# cache, a pruned builder) can come with an empty store. So the later steps use --prefer-offline, never --offline:
# packages come from the store when it is warm and are downloaded only when it is not.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# --ignore-scripts skips the root `prepare` (lefthook needs git); argon2 loads its bundled prebuilds and sharp its
# prebuilt libvips package, so neither needs an install script.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --filter "@app/api..."
RUN pnpm --filter "@app/api..." run build
# `deploy` installs the production dependencies into /out from the store again, so it needs the same cache mount
# (without it every production package would be downloaded a second time).
# `deploy` copies only package.json#files (`dist`) plus package.json, its lockfile and node_modules; the build fails if
# sources, tests (the test-only sign-in route, ADR-0019 §3) or configs ever reach the image (Gate 1b, OVERVIEW §19).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @app/api deploy --prod --prefer-offline --ignore-scripts /out \
 && cp -r apps/api/drizzle /out/drizzle \
 && for leaked in src test tsconfig.json vitest.config.ts Dockerfile; do \
      if [ -e "/out/$leaked" ]; then echo "/out/$leaked must not ship in the image" >&2; exit 1; fi; \
    done \
 && test -z "$(find /out/dist -name '*.test.*' -o -name '__tests__' | head -n 1)"

# Distroless: no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out ./
USER nonroot
EXPOSE 3000
# The image entrypoint is node; the compose one-shots run the same image with CMD ["dist/db/migrate.js"] (migrate)
# and CMD ["dist/db/seed/cli.js"] (seed).
CMD ["--enable-source-maps", "dist/server.js"]
