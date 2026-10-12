# Phase 3: opt-in Qoder client (#5950)

Depends on the preceding lane batch's `dev` result; Qoder reuses the existing
pure export, registry and journaled writer seams rather than adding request
path code. The source PR touches 36 files, including GUI and translations;
carry one coherent client slice and remove unrelated drift.

## Exact change map

- NEW `src/clients/config-export/qoder.ts`: build the documented provider
  contribution and exact managed fragment paths. Loopback may use a
  non-secret placeholder; remote bind must have a supported admission header
  or refuse.
- MODIFY `src/clients/config-export/contracts.ts` and
  `src/clients/config-export.ts`: before, Qoder is absent from the export ID
  union/registry. After, `qoder` is a named opt-in export with a derived
  roster count, not a hand-written total.
- MODIFY `src/integrations/registry.ts` and `mutation-plan.ts`: resolve a
  Qoder-supported user path, validate file/directory safety, and use the
  common status/preview/apply/disable/restore classifier. No automatic
  detection write or core request-path import.
- MODIFY `src/cli/help.ts`, `src/cli/registry.ts`, the GUI integration lists,
  routing, marks, API IDs, and affected locales to expose the same client ID.
  Update `docs-site/src/content/docs/guides/integrations.md`,
  `structure/clients/integrations.md`, and
  `structure/dashboard-and-usage.md` in the same change.
- MODIFY/NEW tests under `tests/clients/`, `tests/config/`, `tests/gui/`, and
  `gui/tests/` for exact generated shape, absent client, foreign keys,
  symlink/unsafe path refusal, drift, snapshot-before-write, disable, and
  byte-exact restore. Register new test names in both test-layout manifests.

## Acceptance and proof

Activation: an operator explicitly enables Qoder against a disposable config;
the generated provider is present and a later disable/restore recovers prior
bytes. A hostile or changed file refuses without overwrite. Windows path
tests use a Windows-shaped home/env and confirm no POSIX-only assumption.
Run `bun test tests/clients/qoder-client.test.ts
tests/clients/integrations-state.test.ts
tests/config/client-config-export-new-clients.test.ts`, relevant `gui/tests/`,
`bun run test:changed`, `bun run typecheck`, `bun run lint:gui`,
`bun run build:gui`, `bun run structure:check`, `bun run privacy:scan`,
and `bun run skill:surface:check` if the capability registry changes.
Perform explicit security review of admission and config serialization. Check
the file-size ratchet, test-layout manifests, locale union, screenshot,
exact-head required CI, and merged `dev` run.
