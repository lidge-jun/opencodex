# wp6 — Revalidation before integration and maintenance commands

Parent layer is `105ce99314d4abdf380dd3667109ec7c2b1490bb`, published as #6539. Prior D closed eighteen account/runtime tasks with functional, security and document re-reviews passing; 37 isolated CLI scenarios and the documented scoped gates passed. Its hosted CI remains a separate publication check. The next direction remains the prewritten 060 integration/maintenance phase.

## Loop contract

This satisfy-spec cycle responds to the requested GUI/CLI task parity. It completes named integration inspection/recovery and maintenance workflows while preserving existing server ownership and consent rules. No GUI, provider behavior, installation, service restart, live account/configuration or remote execution is included. No user time/token bound exists.

Verification uses focused CLI regressions, existing server/plan tests, real CLI subprocess fixtures, typecheck, generated skill, structure, layout, privacy and documentation checks. Completion requires all assigned rows, independent functional/security review, source-bound evidence and an isolated teardown; hosted CI is required for the published layer. A real missing management capability or changed authority returns to main for a scoped decision, never an unguarded API command. Plans and closeout remain in this numbered unit; raw reviewer and execution evidence stays in scratch.

## Main source inspection

`src/cli/integrations.ts` owns client status/history/direct enable/disable/restore, with Aside profile paths already separated. The new entrypoints can intercept their new verbs/options before the legacy action parser, preserving old requests when none of the new options is present. Numeric results must be returned directly rather than lost inside a void action wrapper.

`src/server/management/integration-routes.ts:330` accepts Droid defaults only for Droid apply/overwrite. Preview binding is the top-level operation/planFingerprint pair; a nested plan object supplies no binding. `src/integrations/mutation-plan.ts:83` is the value-free plan authority. The GUI validator at `gui/src/pages/integrations/integration-api.ts:291` establishes its closed keys, kinds, schema paths, order, fingerprint and applicability consistency. CLI validation must retain this contract without importing GUI components or server writers.

`src/server/management/integration-routes.ts:539` retires a journal row by query opId, refusing the latest row before mutation. Its success receipt separates retired identity from snapshotRemoved. Scoped Aside journal DELETE dispatch remains at `src/server/management/aside-profile-routes.ts:242`; a CLI profile selector must use that canonical path. A cleanup failure after retirement cannot be labeled a rollback.

`src/cli/aside-profiles.ts:10` already owns the local attested Aside synchronization exchange and the explicit dependency-injected runtime transport. The new user-facing sync verb must call that helper unchanged. Pre-resolving a base URL would choose its other transport branch and is therefore not a harmless refactor. `src/integrations/owned-refresh.ts:34` owns per-profile outcomes; partial rows remain visible and return nonzero.

## Existing verifier baseline

`bun test tests/server/management-droid-reasoning-defaults.test.ts tests/clients/mutation-plan.test.ts tests/server/aside-profiles-routes.test.ts` passed 70 tests and 434 assertions, exit 0, against the parent tree. These exact arguments exercise Droid defaults binding, plan/no-op/refusal and Aside profile restore ownership; they do not verify the not-yet-written CLI. Log: `.tmp/cli-parity/wp6-baseline.log`.

The repository-native structure-map command was unavailable in the installed plugin (it requires the Codexclaw development checkout). Bounded file/symbol lookup was used instead; no tooling was installed or runtime changed.

Architecture consultation and independent small-command source findings are recorded in the 060 executable refinement before A; they are not inferred from this baseline.

## Parent CI prerequisite

Parent #6539 head `105ce99314d4abdf380dd3667109ec7c2b1490bb` failed test shard2 in run37148668332, job111278002435. All five reported failures are in the single existing `tests/cli/cli-account.test.ts` (the initial two-file hypothesis was corrected after reading the job log). Its unsupported-device assertion expects provider-echo prose. The retained-credential error case expects usage2 and raw backend text, while the approved safe operation-error boundary now returns1. Three pending-login cases still expect0; the approved wp5 contract returns1 for validation/catalog pending. The exact completed JSON assertion also needs the preserved flowId field after its stale exit assertion is corrected.

The prerequisite repair is limited to this fixture: assert the fixed device diagnostic; assert operation failure1 without raw backend text and retain no-success guidance; change pending exits to1 in both modes, preserving pending/recovery/model-guidance checks; add the actual fixed flow-mock identity to the exact JSON expected object. Do not remove assertions, loosen output to arbitrary matches or change production code to recover stale expectations. Main performs this at B before new worker writes, runs the whole original fixture plus the new login-options regressions, publishes the small follow-up to the parent branch and propagates it into this child. A must independently inspect the proposed repair against the implementation; a new production finding instead reopens that contract.

Additional owner baseline: `bun test tests/server/management-integration-routes.test.ts tests/server/management-integration-journal-delete.test.ts tests/clients/aside-profile-sync-owner.test.ts tests/server/local-aside-sync-capability.test.ts tests/clients/remote-workspace-management.test.ts` passed 68 tests with 667 assertions, exit0. These direct file arguments cover the established binding/journal/attestation/Hub admission owners. They do not validate new CLI commands.
