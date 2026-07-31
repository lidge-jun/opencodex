# OpenAI Hardening — Unit Plan

Date: 2026-07-17
PABCD session: `019f6ddf-4d26-7782-8427-721bbb0b98bc`
Work class: C4 (authentication, routing, and public provider contract)
Historical execution context: this unit opened under a HOTL goal loop, and this P response
originally locked the plan before the docs-only Audit/Build/Check/Done cycles began.

> **Historical start-state note.** Loop-start instructions below are retained as audit
> history, not current commands. Terminal execution and evidence are consolidated in
> [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md),
> [`050_integration_verification.md`](./050_integration_verification.md), and
> [`051_audit_wp050_implementation.md`](./051_audit_wp050_implementation.md).

## Loop spec

- **Archetype:** spec-satisfaction repair. The user contract is fixed; divergence is
  off and each cycle collapses to one audited implementation strategy at P.
- **Trigger:** the existing `openai` provider combines Direct and account-pool auth,
  while the requested contract requires three separately selectable tiers.
- **Goal:** deliver Direct, Multi (main included), and API tiers with route-owned auth,
  official API metadata, exact Pro aliases, management/UI parity, and runtime proof.
- **Non-goals:** other jawcode/provider hardening, pricing, Programmatic Tool Calling,
  prompt-cache UI, persisted-reasoning UI, arbitrary body transforms, release/deploy/push.
- **Verifier:** focused activation tests per decade doc; final `bun x tsc --noEmit`,
  `bun test`, GUI `bun run lint:i18n` and `bun run build`, rendered GUI inspection,
  restarted Direct/Multi runtime smokes, and sanitized API smoke or an honest
  `NOT RUN (credential unavailable)`. These measure type safety, behavioral isolation,
  public surface consistency, and live routing rather than static plausibility alone.
- **Stop condition:** all goalplan work-phases are `done`, every criterion is `met`
  with fresh `capturedEvidence`, the final D closes the FSM to IDLE, and no in-scope
  diff or failed gate remains.
- **Memory artifact:** this numbered devlog unit plus
  `.codexclaw/goalplans/opencodex-openai-1-provider-id-openai-codex-dire/goalplan.json`
  and its append-only ledger.
- **Expected terminal outcomes:** `DONE` for verified completion; `NOOP` only if the
  current tree already satisfies every criterion; `BLOCKED`, `UNSAFE`, `NEEDS_HUMAN`,
  or `BUDGET_EXHAUSTED` only under the explicit definitions in the bound objective.
- **Escalation:** upward, the main agent reclaims a bounded slice after two distinct
  delegated actors fail the same packet; downward, delegation is added only as a
  P-phase amendment with disjoint scope. Three same-failure repairs trigger re-plan;
  auth/migration ambiguity that changes the locked contract terminates as `UNSAFE` or
  `NEEDS_HUMAN`, never an inferred policy change.
- **HOTL resource bounds:** writes are limited to this repository and `.codexclaw`
  state; credentials are read only when required and never modified/logged; paid API
  verification is capped at four prompts below 1,000 input tokens each when an existing
  key is configured; each work-phase has a 120-minute wall-clock bound; no push,
  deploy, external account creation, or destructive config mutation is authorized.

## Goal

Make OpenAI a deliberate three-tier provider family:

| Provider id | User-facing tier | Credential owner | Account behavior | Upstream |
|---|---|---|---|---|
| `openai` | Codex Direct | caller / main Codex login | main account only; never enters rotation | `chatgpt.com/backend-api/codex` |
| `openai-multi` | Codex Multi-account | OpenCodex Codex-account pool | main account plus added accounts; affinity, quota, cooldown, failover | `chatgpt.com/backend-api/codex` |
| `openai-apikey` | OpenAI API | configured OpenAI API key/key pool | no Codex-account routing | `api.openai.com/v1` |

The main Codex account is a normal candidate in the Multi-account pool. It is not an
out-of-band fallback and must continue to participate in quota scoring and affinity.

## Locked product contract

- `openai` means Direct, even when global pool state exists.
- `openai-multi` means Multi-account and includes main plus configured accounts.
- `openai-apikey` means the platform API and never consumes ChatGPT/Codex credentials.
- Bare native model ids remain Codex Direct catalog rows. Multi and API rows are routed,
  namespaced rows (`openai-multi/<model>`, `openai-apikey/<model>`).
- The API provider exposes official GPT-5.6 family metadata and these OCX-owned virtual
  picker ids only:
  - `gpt-5.6-sol-pro` -> upstream `gpt-5.6-sol` with `reasoning.mode: "pro"`
  - `gpt-5.6-terra-pro` -> upstream `gpt-5.6-terra` with `reasoning.mode: "pro"`
  - `gpt-5.6-luna-pro` -> upstream `gpt-5.6-luna` with `reasoning.mode: "pro"`
- There is no generic `gpt-5.6-pro` alias.
- Virtual ids stay visible in picker, disabled-model state, subagent selection, history,
  and request logs. Rewriting happens only at the outbound request boundary.
- No OpenRouter or other jawcode/provider work is in this unit.

## Scope exclusions

- pricing and cost estimation
- Programmatic Tool Calling UI
- explicit prompt-cache controls
- persisted-reasoning UI
- generalized user-configurable request-body transforms
- non-OpenAI provider hardening

These can be separate units after the three-tier contract is stable.

## Historical 18-cycle work-phase map

This opening map is superseded for finish ordering by
[`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), which collapsed the
remaining work into Cycles A, B, and C and records why ten later documents were already done.

| Cycle | Document | Deliverable |
|---|---|---|
| 1 | [`010_provider_tier_contract.md`](./010_provider_tier_contract.md) | non-activating types, pure migration projection, native-catalog projection |
| 2 | [`020_route_aware_codex_auth.md`](./020_route_aware_codex_auth.md) | atomic tier activation, migration, legacy chatgpt retirement, HTTP/WS/compact auth |
| 3 | [`030_openai_api_models_and_pro_aliases.md`](./030_openai_api_models_and_pro_aliases.md) | official API model metadata and narrow Pro virtual aliases |
| 4 | [`040_management_gui_and_sidecars.md`](./040_management_gui_and_sidecars.md) | management/GUI presentation and rendered QA |
| 5 | [`050_integration_verification.md`](./050_integration_verification.md) | cross-tier regression matrix, live smokes, SoT docs, closeout |
| 6 | [`060_compact_response_hardening.md`](./060_compact_response_hardening.md) | 32 MiB compact reader, overflow cancel, single-log ownership |
| 7 | [`070_virtual_model_validator.md`](./070_virtual_model_validator.md) | `validateOpenAiVirtualModelDefinition`, fail-closed seam, error class |
| 8 | [`080_exact_eight_catalog.md`](./080_exact_eight_catalog.md) | exact-eight API catalog augmentation, collision dedupe, signature warnings |
| 9 | [`090_max_input_validation.md`](./090_max_input_validation.md) | `positiveIntegerRecordConfigError`, disk/management validation, route lowering |
| 10 | [`100_key_login_metadata_clone.md`](./100_key_login_metadata_clone.md) | key DTO max-input clone, no virtualModels in DTO/CLI config |
| 11 | [`110_auto_compact_max_input_cap.md`](./110_auto_compact_max_input_cap.md) | auto-compaction `min(0.9*context, maxInput)` formula |
| 12 | [`120_transport_identity_proof.md`](./120_transport_identity_proof.md) | HTTP JSON/SSE/WS wire+log identity, no Codex account headers on API |
| 13 | [`130_usage_summary_pro_isolation.md`](./130_usage_summary_pro_isolation.md) | usage summary Pro rows don't collapse into base |
| 14 | [`140_request_log_three_identities.md`](./140_request_log_three_identities.md) | `model`/`requestedModel`/`resolvedModel` persistence proof |
| 15 | [`150_config_virtual_map_rejection.md`](./150_config_virtual_map_rejection.md) | disk + management reject forged `virtualModels` |
| 16 | [`160_router_max_input_lowering.md`](./160_router_max_input_lowering.md) | API tier min-wins merge for context and max-input |
| 17 | [`170_gpt56_alias_registration.md`](./170_gpt56_alias_registration.md) | `gpt-5.6` generic alias as eighth API model |
| 18 | [`180_reasoning_merge_contract.md`](./180_reasoning_merge_contract.md) | Pro reasoning merge: mode override, field preservation, compact strip |

At unit start, each implementation cycle was required to run its own P → A → B → C → D
loop, and Cycle 1 could begin only after Plan approval and Audit. That gate is historical.

## Compatibility policy

Fresh installs retain `openai` as the default and therefore start in Direct mode.

Legacy configurations that previously used the global Codex account pool through
`openai` receive a one-time, versioned migration:

1. Detect legacy pool intent from persisted `codexAccounts` or an explicit
   `activeCodexAccountId`.
2. Add `openai-multi` from the canonical registry seed when absent.
3. If the legacy default is `openai`, move the default to `openai-multi` so the
   user's routing behavior does not silently change on upgrade.
4. Persist a migration marker so later deliberate removal or default changes are
   never undone.
5. Never copy credentials into provider config; account credentials remain owned
   by the existing Codex account store.

Fresh configs and legacy configs without pool intent are not migrated to Multi.

## Success criteria and terminal result

All criteria below are terminally met. The criterion-to-evidence mapping is in
[`050_integration_verification.md`](./050_integration_verification.md#criterion-ledger), the
independent final audit is `051`, and the consolidation rationale is `190`.

- The three tiers are separately addable/selectable in CLI and GUI.
- Direct requests cannot resolve, refresh, cool down, fail over, or log a pool account.
- Multi requests can select main or an added account and preserve current affinity,
  quota, cooldown, failover, and outcome recording.
- API requests use only API-key auth and show the corrected GPT-5.6 catalog.
- Every Pro virtual id produces exactly the base upstream model plus
  `reasoning.mode: "pro"`; no other provider or model is rewritten.
- HTTP, WebSocket, remote compaction, search, image, catalog, and management paths
  agree on provider ownership.
- Targeted tests, full typecheck, full test suite, GUI i18n lint, and configured live
  smokes all pass with evidence recorded in the decade documents.

## Evidence index

- [`001_current_architecture.md`](./001_current_architecture.md) — present owners and defects.
- [`002_official_api_contract.md`](./002_official_api_contract.md) — official OpenAI facts used by the build.
- [`003_audit_round1.md`](./003_audit_round1.md) — Sol audit blockers and accepted amendments.
- [`004_audit_round2.md`](./004_audit_round2.md) — Sol re-audit blockers and exact closure amendments.
- [`005_audit_round3.md`](./005_audit_round3.md) — final contradiction cleanup before approval.
- [`006_audit_round4.md`](./006_audit_round4.md) — atomic publication and persistence closure.
- [`007_audit_round5.md`](./007_audit_round5.md) — hard-link post-publication cleanup correction.
- [`008_audit_final.md`](./008_audit_final.md) — independent Sol PASS and audit closure.
- [`009_audit_wp010.md`](./009_audit_wp010.md) — Cycle-010 phase audit amendment.
- [`019_audit_wp020.md`](./019_audit_wp020.md) — Cycle-020 atomic-activation audit amendments.
- [`050_integration_verification.md`](./050_integration_verification.md) — final integration,
  runtime, source-of-truth, and criterion ledger.
- [`051_audit_wp050_implementation.md`](./051_audit_wp050_implementation.md) — final independent
  implementation audit.
- [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md) — audited Cycles A/B/C
  finish ordering and 060–180 consolidation.
- Decade documents — exact changes, activation cases, tests, and stop conditions.

## Historical start-state stop conditions

- Do not implement during this docs-first Plan cycle.
- Do not enter Audit without user confirmation.
- Do not claim API live-smoke completion when no configured API key is available.
- Do not collapse Direct and Multi back into one provider because they share an
  adapter or upstream URL.
