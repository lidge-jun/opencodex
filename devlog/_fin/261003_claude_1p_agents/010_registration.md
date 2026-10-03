# wp1: Reconcile registered agents at successful first-party setup

## File changes

- MODIFY src/server/management/agent-settings-routes.ts: in the dedicated cliFirstParty branch, after reconciliation succeeds and rollback/refusal paths exit, await the existing syncClaudeAgentDefsBestEffort before response. Apply to successful on/off writes so idempotent saves repair missing files; disabling first-party alone keeps registered agents when the integration remains enabled.
- MODIFY the same file: for Desktop first-party apply, reconcile after picker reconciliation immediately before the success response, guarded by modeSaved.ok; saved:false partial success must not register. Reuse the existing helper; never put filesystem registration in the settings transaction or TLS startup primitive.
- NEW tests/claude-integration/claude-first-party-agent-sync.test.ts if existing large test owners cannot accommodate focused cases; use isolated config directories and real management API/file assertions. Register in scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json.
- MODIFY docs-site/src/content/docs/guides/claude-code.md and structure/runtime.md: state successful first-party setup attempts best-effort reconciliation of the owned roster and new sessions load it. Review adjacent translated roster prose and update contradictions only.

## Activation and proof

1. Empty isolated agents directory, non-empty configured routed roster, CLI first-party enable succeeds: expected marker-owned file exists before response, with correct ocx-route directive.
2. Repeat successful enable after removing only the test fixture's generated file: file repaired.
3. injectAgents=false: no registration; existing owned file pruned according to existing policy, user-authored file retained.
4. Refused or rolled-back enable: no registration is created, and pre-existing files remain byte-identical; rollback checks retain existing semantics.
5. Successful CLI first-party disable with enabled integration: roster retained.
6. Existing generator/startup tests must continue proving enabled:false and sibling-ownership gates.
7. Successful Desktop first-party apply with persisted mode: roster generated; persistence failure never adds a new registration side effect.

Verification is now hosted-only by explicit user correction. GitHub CI must execute the new focused test through its registered domain and the applicable existing suites, typecheck, structure/privacy gates and documentation build. Do not execute these locally. Baseline GUI tests (20 pass) were investigation evidence only, not proof of this fix. No GUI change planned, so screenshot requirement is inapplicable.

## Security review scope

Preserve existing management admission and settings-file ownership. The existing generator writes only marker-owned definitions; regression tests exercise refusal and disabled registration. No credentials, request bodies or private local configuration enter repository artifacts. Independent security review must confirm the new call occurs only after successful reconciliation and does not weaken consent or ownership checks.
