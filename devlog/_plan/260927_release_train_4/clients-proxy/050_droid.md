# Phase 5: focused Factory Droid integration (#5193)

Depends on `040_kilo.md` for shared roster reconciliation. The source PR
conflicts with current `dev` and changes 83 files, including broad export
behavior and unrelated test harnesses. Reimplement the narrow client thesis;
if the installed Droid contract cannot be verified, record a hold and leave
the source PR open with a reason.

## Exact change map if verified

- NEW `src/clients/config-export/droid.ts`: build only Droid's documented
  settings and per-model rows using the documented user settings path. Do not
  add an automatic startup/config write or copy provider credentials.
- MODIFY `src/clients/config-export.ts`, `contracts.ts`,
  `src/integrations/registry.ts`, and `mutation-plan.ts` to add the typed ID
  and exact managed fragments. Before, Droid is absent. After, explicit
  export/enable uses the shared journal and restore path.
- MODIFY `src/cli/export-command.ts` only if Droid needs a distinct
  loopback catalog source. Preserve the existing catalog provenance for every
  other loopback-only client; the source PR's all-client redirect is not
  accepted without a separate proof. Update CLI help, GUI roster/locales,
  `docs-site/src/content/docs/guides/integrations.md`, and
  `structure/clients/integrations.md` for the verified client slice.
- NEW `tests/clients/droid-client.test.ts`: assert exact client-consumed
  settings, foreign model preservation, symlink/unsafe path refusal, Windows
  path, drift, disable and exact-byte restore. MODIFY
  `tests/cli/cli-export-command.test.ts` to prove existing clients retain
  their old catalog/selection source. Register the new test in both manifests.

## Acceptance and proof

Activation: a disposable Droid config is explicitly enabled and subsequently
restored. Negative: a changed user model or unsafe target refuses before
overwrite, and a non-Droid loopback client exports the same catalog as before.
Run `bun test tests/clients/droid-client.test.ts
tests/cli/cli-export-command.test.ts`, relevant integration and GUI tests,
`bun run test:changed`, `bun run typecheck`, `bun run lint:gui`,
`bun run build:gui`, `bun run structure:check`, `bun run privacy:scan`, and
surface check if needed. Do not claim live Droid behavior from a synthetic
fixture alone; verify the documented client schema before committing the
implementation. Explicit credential/path security review, a GUI screenshot,
and exact-head CI precede merge.
