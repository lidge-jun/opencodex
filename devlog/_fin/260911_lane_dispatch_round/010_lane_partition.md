# Lane partition — measured file collisions

Method: `gh pr view <n> --json files` over 27 open PRs on 2026-09-11, `devlog/` paths dropped, then
grouped by path. Revision 3, after two audit rounds (`030_audit_round1.md`, `040_audit_round2.md`).

Ownership below is stated as an exact path or as one named directory meaning every file under it.
No two lanes name the same path, and no named directory contains another lane's path.

## Contended files

| Count | Path | Open PRs |
|---|---|---|
| 4 | `src/server/responses/core.ts` | #4050, #4118, #4181, #4184 |
| 4 | `src/providers/quota.ts` | #4090, #4105, #4174, #4210 |
| 4 | `tests/providers/provider-quota.test.ts` | #4090, #4105, #4174, #4210 |
| 3 | `gui/src/i18n/{de,en,fr,ja,ko,ru,tr,zh,zh-TW}.ts` | #4111, #4183, #4193 |
| 3 | `scripts/test-layout/layout.json` | #4119, #4193, #4203 |
| 3 | `tests/fixtures/test-layout-expected.json` | #4119, #4193, #4203 |
| 2 | `src/server/claude-messages.ts` | #4050, #4184 |
| 2 | `src/server/chat-completions.ts` | #4118, #4184 |
| 2 | `src/types/tools.ts` | #4171, #4181 |
| 2 | `src/combos/resolve.ts` | #4090, #4105 |
| 2 | `src/config.ts` | #4100, #4183 |
| 2 | `src/update/job.ts` | #4185, #4203 |

Collision-free PRs, touching no file any other open PR touches: #4062, #4104, #4119, #4124, #4130,
#4139, #4159, #4177, #4178, #4187, #4188, #4199.

## Ownership

**L1** `codex/260911-l1-responses-core` — `src/server/responses/core.ts`,
`src/server/responses/compact.ts`, `src/server/responses/policy-fallback.ts`,
`src/server/chat-completions.ts`, `src/server/claude-messages.ts`,
`src/server/request-log-conversation.ts`, `src/server/responses-undeclared-tool-guard.ts`,
`src/providers/opencode-go-transport.ts`, `src/types/tools.ts`,
`docs-site/src/content/docs/reference/configuration/providers.md`. Stack: #4172 → #4176.

**L2** `codex/260911-l2-catalog-provider` — `src/providers/quota.ts`,
`src/providers/quota-types.ts`, `src/providers/quota-wire.ts`,
`src/providers/quota-routing-cache.ts`, `src/providers/quota-key-accounts.ts`,
`src/providers/account-quota-disk.ts`, `src/providers/registry.ts`, and the roster oracle
`tests/providers/provider-registry-parity.test.ts`. Stack: #4201.

**L3** `codex/260911-l3-account-pool` — `src/codex/account-usability.ts`,
`src/codex/account-pause.ts`, `src/codex/account-store.ts`, `src/codex/account-runtime-state.ts`,
`src/codex/plan.ts`, `src/codex/plan-from-token.ts`, `src/codex/warmup.ts`,
`src/codex/model-entitlements.ts`, `src/server/responses/codex-auth-error.ts`,
`src/codex/auth-api.ts`, `src/codex/routing.ts`, `src/types/config.ts`, the single key `codexPool.excludedPlans` in
`src/config.ts`, and `docs-site/src/content/docs/guides/codex-integration.md` and its seven locale copies under
`docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/guides/codex-integration.md`.
Stack: #4126 → #4212 → #4211.

**L4** `codex/260911-l4-service-cli` — directories `src/update/`, `src/cli/`, `src/client/`; files
`bin/ocx.mjs`, `src/cli.ts`, `src/service.ts`, `src/config/pending-teardown.ts`,
`src/lib/bun-runtime.ts`, `src/lib/package-tree-integrity.ts`, `src/lib/process-control.ts`,
`src/codex/catalog/effort.ts`, `src/codex/cli-install-provenance.ts`,
`docs-site/src/content/docs/getting-started/installation.md`. Stack: #4202 → #4169 → #4207.

**L5** `codex/260911-l5-integrations-io` — directory `src/integrations/`; files
`src/config/atomic-write.ts`, `src/clients/config-export.ts`,
`src/clients/config-export/contracts.ts`. Stack: #4197 → #4214.

**L6** `codex/260911-l6-streaming-tools` — `src/server/responses/codex-ws-exchange.ts`,
`src/server/responses/codex-ws-wire.ts`, directory `src/adapters/qoder/`. Stack: #4191 → #4190.

**L7** `codex/260911-l7-docs` — `docs-site/src/content/docs/guides/providers.md`,
`docs-site/src/content/docs/guides/remote-hub.md`. Stack: #4215 → #4200.

## Custody of shared assets

- `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`: every lane
  registers its own new test files in both, as `AGENTS.md` requires. They are append-only lists, so
  the conflicts are mechanical and the orchestrator resolves them during the serialized merges.
- `gui/src/i18n/*`: no lane adds a locale key this round. A lane that needs one stops and reports.
- `src/config.ts`: only L3, and only `codexPool.excludedPlans`.
- `docs-site/src/content/docs/guides/providers.md`: L7 only. A lane whose carried PR edits it drops
  that hunk and reports the wording to the orchestrator.

## Amendments from the seven-lane feasibility audit

Ownership above already carries them; `130_wp4_feasibility.md` records why each was granted. In short:
L2 gained the roster oracle it must update, L3 traded `oauth-account-routes.ts` for the Codex account
surface `auth-api.ts` plus `routing.ts` and `types/config.ts`, L5 gained the export-client contract,
and #4204 left the round because binding the clamp to the Desktop runtime is a design decision.
