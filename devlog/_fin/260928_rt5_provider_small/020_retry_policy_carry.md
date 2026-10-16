# wp2 — provider retry policies survive a save

Carries #6121 by moseoridev (`ed68d9f0c7`, `401de750ac`).

## Changes

1. `git cherry-pick ed68d9f0c7 401de750ac`: MODIFY
   `src/server/management/provider-overwrite-carry.ts`: add `retryOn429`,
   `transientRetryOn5xx`, `retryOnReset` to the same-destination POST carry set; PATCH
   validates named policies and deletes one on `null`. MODIFY `src/config/load-degrade.ts`
   (strict 5xx validator), `src/config/schema/leaf-validators.ts` (export the existing
   schema), `tests/server/management-provider-compat-carry.test.ts`, and the eight
   `docs-site/.../reference/configuration/providers.md` locales.
2. MODIFY `structure/gui-and-management-api.md` Providers row: "keeps the five operator
   compatibility settings" becomes "keeps the eight operator compatibility settings".

## Acceptance

- A POST overwrite to the same destination without the three fields keeps them.
- A POST overwrite with a changed adapter, base URL, or auth mode drops them.
- PATCH `{retryOn429: null}` clears the policy; PATCH with a malformed policy returns 400
  and saves nothing.
- PATCH that changes only `baseUrl` keeps the retry policies it does not name (field mask,
  architect D4). If #6121's tests do not already pin this, add the case to
  `tests/server/management-provider-compat-carry.test.ts`.
- A POST overwrite that changes only `authMode` drops the retry policies: add an API-level
  case to `tests/server/management-provider-compat-carry.test.ts` that reloads the saved row
  (audit blocker 2; the source PR covers auth mode only through
  `providerOverwriteKeepsDestination`).

## Review gate

This changes management-API writes that sit beside the destination check guarding the
stored key pool. `MAINTAINERS.md` requires explicit security review for that boundary, so
the PR body flags it and the lane report routes it to the coordinator as a pre-merge
security-review item (audit blocker 1).

## Verify

`bun test tests/server/management-provider-compat-carry.test.ts`, typecheck,
test:changed, structure:check, privacy:scan, docs-site build.
