# Container smoke executable

## File delta

NEW `scripts/ci/docker-smoke.ts`: bounded Bun-native TypeScript probe for the existing source-build Compose contract. Reuse the canonical compatibility generator and docker/bootstrap-token.ts; do not add an alternative token writer or deployment configuration. The probe creates a unique temporary Compose project and image, builds the actual Dockerfile, bootstraps a freshly generated throwaway token through stdin, starts the hub, verifies health and data-plane admission, recreates the container on the same named volumes, and verifies persistent state again. Cleanup is limited to the unique test project and its generated artifacts. Never use an operator project, host home, provider credentials, global docker prune, or real upstream inference.

MODIFY owning documentation only as needed to explain the CI acceptance scope and its limits; no claim of upstream-provider validation.

## Acceptance

- Real image builds from the checkout with a generated compatibility manifest.
- Read-only/non-root Compose service becomes healthy; requests without a token are refused.
- A synthetic catalog in the separate Codex volume is served with the throwaway token, proving admission and persistence without provider access.
- /readyz succeeds separately from liveness, token reinitialization fails without replacement, and effective container restrictions are verified.
- Token/config/catalog persist across an actual container replacement (different container id, same volumes).
- Failures and cleanup are bounded; token/body contents never appear in logs.
- Existing Docker settings and defaults remain unchanged.

Run only in final remote CI. Locally perform source/static inspection, not the smoke or a test suite. Read the current lifecycle/API contracts before implementing assertions.

## Audit amendments

Use explicit unique project on every Compose command, unique image tag via a temporary override, controlled Compose environment, and loopback ephemeral host port. Preserve pre-existing generated files; cleanup must fail the probe if it cannot remove its own project resources. Bound every child, output capture and cleanup; terminate/reap timed-out children. Never print raw runtime logs or complete inspect output.

Before/after replacement: require readyz 200 with status ready; authenticated catalog 200 with exact synthetic fixture; missing/wrong token 401 for catalog, Responses and compact. Second bootstrap must fail and preserve the original token while rejecting the proposed replacement. Verify different container IDs, identical named-volume identities and persistent config/catalog evidence without reseeding; check effective non-root UID and read-only root.
