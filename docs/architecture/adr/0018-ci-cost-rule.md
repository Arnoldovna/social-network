# ADR-0018: CI cost rule: e2e on pull requests only, images only for a public repository

- Status: accepted (cross-project rule decided by Marina; applied to social-network in the consistency-pass re-review)
- Date: 2026-11-17
- Related: PLAN.md "CI" and "CD" rows; amends ADR-0017 and `project-scaffold/references/conventions.md` §9 for this
  repository; same rule as imageboard ADR 0020 and petition ADR 0018

## Context

The repository stays private until Marina makes it public herself. Private repositories pay for GitHub Actions
minutes and GHCR storage.

- The most expensive CI job is `e2e`: it builds both production images (`api` with sharp, argon2 and socket.io;
  `web` with nginx), starts the isolated compose project `social-network-e2e` (Postgres, Redis, MinIO, migrate,
  seed, api, web) and runs Playwright on two projects with two browser contexts per real-time journey. After a
  squash-merge, the push to `main` would run it again on a tree the PR run already tested: one PR per phase, phases
  run one after another, so `main` does not move between the PR run and the merge.
- `release.yml` (conventions §9) builds and pushes `ghcr.io/arnoldovna/social-network-api` and `-web` with
  provenance and SBOM after every green CI run on `main`. Nobody pulls the images while the repository is private,
  and there is no deploy target.
- The template `release.yml` tags with `type=sha` and passes `IMAGE_TAG: sha-${{ github.sha }}` to the deploy job.
  Under `workflow_run`, `github.sha` is the head of `main` when the release workflow starts, which can be newer than
  the commit CI tested.

## Decision

1. **`ci.yml` job `e2e` runs on pull requests only**: `if: github.event_name == 'pull_request'`. On `push` to `main`
   and on `workflow_dispatch` it is skipped. All other jobs (`lint` with the schema drift check, `typecheck`, `unit`,
   `integration`, `build`, `dev-setup-smoke`, `gitleaks`) keep the template triggers (`pull_request`, `push` to
   `main`, `workflow_dispatch`). A run with skipped jobs still concludes `success`, so `release.yml` is still
   triggered.
2. **`release.yml` job `images` runs only when the repository is public**:

   ```yaml
   env:
     RELEASE_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}
   jobs:
     images:
       if: >-
         github.event.repository.private == false &&
         ((github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
          (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'))
   ```

   `repository` is part of both the `workflow_run` and the `workflow_dispatch` event payloads (verified for the
   sibling projects against the octokit webhook schemas on 2026-11-16), so the expression never reads a missing
   object. Manual runs are accepted on `main` only, because `latest` must never point at a branch build.

3. **`deploy`** keeps `needs: images`, the `production` environment and the PLAN.md switch, plus the visibility
   rule: `if: github.event.repository.private == false && vars.DEPLOY_ENABLED == 'true'`.
4. **The released commit is the tested commit.** `RELEASE_SHA` (item 2) is used for `actions/checkout` `ref`, for the
   tags of both images (`type=raw,value=sha-${{ env.RELEASE_SHA }}` and `type=raw,value=latest`), for the OCI label
   `org.opencontainers.image.revision` (metadata-action `labels:` override) and for the deploy job's `IMAGE_TAG`. The
   template's `type=sha,format=long` and `IMAGE_TAG: sha-${{ github.sha }}` lines are not used.
5. **Static validation instead of a live run.** Because `images` and `deploy` are skipped while the repository is
   private, Gate 1a checks every workflow with actionlint
   (`docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:<tag>`, a one-off check, nothing committed) and
   checks that the `release.yml` run on `main` shows `images` and `deploy` as skipped.

## Alternatives

- **e2e on every event (template)**: roughly doubles the e2e minutes for no new information while `main` cannot move
  between the PR run and the merge. Rejected.
- **Nightly e2e on `main` instead of per PR**: the quality gate needs the e2e result on the PR
  (`gh pr checks --watch`). Rejected.
- **Build the images on `main` without pushing them**: the PR's e2e job already builds both Dockerfiles from the
  same tree. Rejected.
- **Delete `release.yml` until the repository is public**: PLAN.md requires the CD workflow to exist (prepared,
  deploy disabled). The visibility condition makes it a no-op without deleting it. Rejected.

## Consequences

- While the repository is private, every `release.yml` run shows `images` and `deploy` as skipped. Gate 1a and every
  later gate check this instead of "images pushed". The PR's `e2e` job is the proof that both production images
  build and that sharp, argon2 and socket.io load in the distroless runtime on linux/amd64; the local
  `pnpm verify` proves linux/arm64 (Colima on Apple silicon).
- `project-scaffold` "Done when: release workflow builds both images on main" cannot hold for a private repository;
  this ADR replaces it for social-network (flagged for Marina).
- After Marina makes the repository public, the next green CI run on `main` publishes the images. To publish at
  once: `gh workflow run release.yml --ref main` (hand-over note in the Presentation phase, not an autonomous step).
- Deploying from the private repository is impossible by design; it needs a new ADR that supersedes item 3.
- Dependabot PRs also run e2e. That is intended: dependency updates are what e2e must catch.
- PLAN.md Etappe 3b (`pages.yml`, GitHub Pages demo) follows the same principle: deploy only when the repository is
  public.
- `project-scaffold/references/conventions.md` §9 does not contain this rule yet. The three projects now carry the
  same rule in their ADRs; the shared file should be updated (flagged for Marina).
