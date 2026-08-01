# WP010 — #139 provider catalog contract

- Base/branch: ~~`origin/dev` -> `codex/wibias-139-01-provider-catalog-contract`~~ **P-amendment (2026-07-17): user steering — no child-branch stack. Commit directly onto local `dev` (which already carries openai-hardening wp-020..050).**
- P stale-check (2026-07-17, dev@ae485f4b): dev gained `CodexAccountMode`, `virtualModels`, `modelMaxInputTokens`, `openaiProviderTierVersion` since the ledger was cut. The PR139 source diff REMOVES those (predates hardening) — apply only the additive contract hunks; never delete hardening symbols. `note` already exists on `ProviderRegistryEntry` and `DerivedProviderPreset` in dev; net-new on dev is: `freeTier` (types/registry/derive), `note` on `OcxProviderConfig` (type-only), NVIDIA `freeTier:true` + note, `freeTier` propagation + tests. (`authMode "local"` moved to WP050 — see A-audit corrections.)
- A-audit corrections (2026-07-17, Sol reviewer round 1 FAIL → amendments):
  - **`authMode: "local"` union addition is DEFERRED out of WP010.** Runtime treats non-oauth/forward as key auth (api-keys.ts:38, key-failover.ts:62) and openai-chat only enforces credentials for key|oauth (openai-chat.ts:383), so config-level `"local"` on a key provider (e.g. NVIDIA) would bypass key-required enforcement via router passthrough (router.ts:95). It lands only in the WP that gives it a consumer + guard (WP050 add-provider catalog): guard = reject/ignore `authMode:"local"` when registry `authKind !== "local"`, plus a NVIDIA local-bypass regression test.
  - **Propagation scope is `freeTier` ONLY.** `note` stays preset-only (existing derive.ts:245 path); seeding `note` into `providerConfigSeed` breaks tests/provider-payload.test.ts:65 (reserved OpenAI canonical seed must stay clean). `note` on `OcxProviderConfig` is added as a type-only contract field (consumer arrives in WP030/050 GUI).
  - `freeTier` enrich follows the existing `=== undefined` backfill pattern (derive.ts:201,207) so a user-set `false` is preserved.
  - Source PR marks only NVIDIA `freeTier:true` (opencode-free/mimo-free are `keyOptional` only — no freeTier).
  - Follow-up ownership note: `safeConfigDTO` whitelist (src/server/auth-cors.ts:266) does not expose `freeTier`; that server hunk belongs to WP040 (management API) — verify at WP040 P.
- Scope: ledger child `010`; no GUI component or label-only copy churn.
- Exact source rows: `139-H220`-`H223`, `H234`, `H241`-`H242`, and `H257`. Rows `H255`-`H256` (authMode "local" union + doc line) move to WP050 (guard + consumer land there). Label/note copy rows `H224`-`H225`, `H235`-`H240`, `H270`-`H271` belong to WP100.
- MODIFY `src/types.ts`: add the consumed `freeTier` and UI-only `note` contract fields; document `freeTier !== keyOptional`. Do NOT touch the `authMode` union (WP050).
- MODIFY `src/providers/registry.ts`: add `ProviderRegistryEntry.freeTier`; mark NVIDIA NIM free-but-key-required. Keep unrelated provider label/note rewrites out.
- MODIFY `src/providers/derive.ts`: seed/enrich/preset propagation for `freeTier` ONLY, without overwriting user config (`=== undefined` backfill).
- MODIFY `tests/provider-registry-parity.test.ts`: maintainer repair assertions (not source hunks) prove NVIDIA is `freeTier:true` and still requires a key; prove `freeTier` config/preset propagation.
- Before -> after: no pricing signal and conflated keylessness -> explicit free pricing independent from credential requirement.
- Verification: `bun test tests/provider-registry-parity.test.ts`; `bun run typecheck`; `git diff --check`; diff <=500 lines.
- Attribution: Wibias author if copied contract is unchanged; maintainer author + Wibias co-author if schema is narrowed during repair.
- Rollback: revert this child only; no runtime routing behavior may depend on the field yet.
