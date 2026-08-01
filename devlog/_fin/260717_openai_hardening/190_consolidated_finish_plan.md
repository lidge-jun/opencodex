# OpenAI Hardening — Consolidated Finish Plan

> **Superseded execution procedure.** This file is retained as audit history for the
> 060–180 consolidation findings. Its former Cycle B/C instructions are not executable
> authority. `050_integration_verification.md` now owns final integration, maintained
> SoT, isolated no-spend runtime proof, evidence privacy, and closeout. In particular,
> do not restart the user's real proxy, make credential-gated live calls without
> `OCX_ALLOW_LIVE_OPENAI_SMOKE=1`, modify archived `docs/`, or reopen the real user GUI
> solely because older text below says so.

> Archive note: `_plan/260717_openai_hardening` paths in this audited execution order are
> historical after Cycle C; the completed unit and equivalent relative paths live under `_fin`.

Date: 2026-07-17
Audit base: `9bba3605` (`dev`, current HEAD after Cycle-040 landing)
Scope: consolidate Cycles 040–180 into the minimum dependency-ordered finish path.

## Verdict

The 18-cycle map is stale. Commit `42e958fd` implemented almost all of the work later
split into Cycles 060–180, while their decade documents retained `## Status pending`.
Of the thirteen documents in that range, ten are already implemented and covered by
tests, three are partial, and none are wholly unstarted.

The honest remaining plan is three cycles. Cycle 040 was committed as `9bba3605`
while this audit was running, so it is no longer a remaining cycle:

1. close the three narrow Cycle-070/090/160 contract gaps and run one consolidated
   060–180 verification sweep;
2. execute Cycle 050's still-missing mandatory integration, client-history, runtime,
   and post-restart GUI proofs;
3. synchronize durable documentation/status evidence and archive the unit to `_fin`.

This ordering is dependency-based, not effort-based: the remaining contract gaps must
be fixed before the full matrix; documentation and archival follow only after runtime
proof. The landed GUI/management admission is now available to the integration fixture.

## Current verification snapshot

Fresh commands run against the present worktree during this audit:

| Gate | Result |
|---|---|
| `bun test tests/provider-payload.test.ts tests/codex-multi-state.test.ts tests/server-auth.test.ts tests/provider-registry-parity.test.ts tests/config.test.ts tests/umans-provider.test.ts tests/codex-catalog.test.ts tests/openai-api-virtual-models.test.ts tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts` | PASS — 275 tests, 0 failures, 1,532 assertions |
| `bun x tsc --noEmit` | PASS — exit 0 |
| `cd gui && bun run lint:i18n && bun run build` | PASS — exit 0; Vite emitted only the existing chunk-size warning |
| `git diff --check` | PASS — exit 0 before this file was added |

These focused gates prove the existing implementation is healthy, but they do not
replace Cycle 050's absent fixed E2E test, full suite, real runtime smokes, or
client-history activation proof.

## Per-document source verification (060–180)

Status meanings:

- `ALREADY_DONE`: required production behavior and meaningful activation coverage are present.
- `PARTIAL`: most behavior exists, but a stated contract or named activation proof is missing or contradictory.
- `NOT_STARTED`: no material implementation or tests exist.

| Doc | Status | Current source and test evidence | Remaining issue |
|---|---|---|---|
| `060_compact_response_hardening.md` | `ALREADY_DONE` | The 32 MiB constant, declared-length precheck, incremental chunk cap, cancellation, 499/502 mapping, and buffered relay are in `src/server/responses.ts:1196-1244`; compact identity/routing is in `src/server/responses.ts:1247-1346`; single final-log ownership is in `src/server/index.ts:304-329`. Success, upstream 4xx/5xx, connect/body errors, both overflow modes, both abort modes, local 400, one `/api/logs` row, and one JSONL row are exercised in `tests/openai-api-virtual-models.test.ts:157-345`. | None beyond final consolidated rerun/status evidence. |
| `070_virtual_model_validator.md` | `PARTIAL` | Error class, pure validator, fail-closed matched resolution, returned resolution, compact resolution, and idempotent second apply are implemented in `src/providers/openai-virtual-models.ts:7-82`. Resolver/apply/reasoning tests are in `tests/openai-api-virtual-models.test.ts:24-155`. | The malformed table at `tests/openai-api-virtual-models.test.ts:141-154` has nine rows but omits the explicitly required self-reference case (`wireModelId === selectedModelId`) and does not snapshot `PROVIDER_REGISTRY` around malformed calls. Production code rejects self-reference at `src/providers/openai-virtual-models.ts:33`, so this is an activation-proof gap, not a missing implementation. |
| `080_exact_eight_catalog.md` | `ALREADY_DONE` | Trusted-signature normalization, process-wide warning dedupe/reset, exact registry reconstruction, API absent/disabled no-op, lower-only caps, and replacement of all live API rows are in `src/codex/catalog.ts:1379-1448`. Exact-eight, live omission/replacement, Direct/Multi isolation, lower-only metadata, no-op, and semantic warning tests are in `tests/codex-catalog.test.ts:1308-1423`. | None beyond final consolidated rerun/status evidence. |
| `090_max_input_validation.md` | `PARTIAL` | Type ownership exists at `src/types.ts:561-601`; plain positive-integer validation and disk rejection are in `src/config.ts:342-415`; management admission uses the same validator at `src/server/auth-cors.ts:196-221`; helper/disk/management tests are in `tests/config.test.ts:320-352` and `tests/server-auth.test.ts:375-473`. | The decade doc says `safeConfigDTO` exposes `modelMaxInputTokens`, but the Cycle-040 security-review diff intentionally removes it from the allowlist at `src/server/auth-cors.ts:257-293`, and `tests/server-auth.test.ts:165-200,468-473` requires redaction. Cycle 040 itself says max-input internals are omitted. The docs must select the later security contract (recommended: keep it persisted/validated but not returned by `/api/config`) rather than re-expose it accidentally. The router's non-API merge issue is tracked under 160. |
| `100_key_login_metadata_clone.md` | `ALREADY_DONE` | `DerivedKeyLoginProvider`, `providerConfigSeed`, and `deriveKeyLoginMap` independently clone max-input metadata without registry virtual maps in `src/providers/derive.ts:4-15,74-147`; `KeyLoginProvider` extends the derived shape at `src/oauth/key-providers.ts:10-12`; CLI config cloning is in `src/oauth/login-cli.ts:65-88`. Clone isolation and virtual-map absence are tested in `tests/provider-registry-parity.test.ts:72-87` and `tests/umans-provider.test.ts:84-91`. | None beyond final consolidated rerun/status evidence. |
| `110_auto_compact_max_input_cap.md` | `ALREADY_DONE` | `applyCatalogModelMetadata` uses `min(floor(context*0.9), maxInputTokens)` at `src/codex/catalog.ts:771-779`; provider hints thread configured max input at `src/codex/catalog.ts:1084-1110`. The 922K and 315K cases are asserted at `tests/codex-catalog.test.ts:1388-1394`. | None beyond final consolidated rerun/status evidence. |
| `120_transport_identity_proof.md` | `ALREADY_DONE` | Virtual rewriting occurs immediately after routing at `src/server/responses.ts:492-514`; selected/base/log identity ownership is in `src/providers/openai-virtual-models.ts:52-74`. All three Pro aliases are covered over HTTP JSON, SSE, and real WebSocket with base upstream/client model, virtual log/usage model, API key, and absent Codex account headers at `tests/openai-api-virtual-models.test.ts:348-495`. Scalar/array reasoning is rejected before fetch at `tests/openai-api-virtual-models.test.ts:479-488`. | None beyond final consolidated rerun/status evidence. |
| `130_usage_summary_pro_isolation.md` | `ALREADY_DONE` | Usage rows group by normalized provider plus selected `entry.model`, explicitly excluding `resolvedModel` from identity, at `src/usage/summary.ts:210-247`. Three Pro rows remain distinct in `tests/usage-summary.test.ts:115-130`. | None beyond final consolidated rerun/status evidence. |
| `140_request_log_three_identities.md` | `ALREADY_DONE` | Request log fields and usage propagation are in `src/server/request-log.ts:52-66,98-106,371-416`; persisted usage includes and normalizes `requestedModel` at `src/usage/log.ts:9-16,74-104`. End-to-end Pro HTTP/SSE/WS and compact assertions cover `model`, `requestedModel`, and `resolvedModel` in both log stores at `tests/openai-api-virtual-models.test.ts:240-329,348-495`; the generic JSONL shape is also covered at `tests/usage-log.test.ts:34-68`. | The named unit assertion is integrated in the transport suite rather than duplicated in `tests/request-log.test.ts`; coverage is stronger than the document's file-placement suggestion, so no extra duplicate test is needed. |
| `150_config_virtual_map_rejection.md` | `ALREADY_DONE` | Disk `superRefine` rejects own `virtualModels` at `src/config.ts:363-379`; management rejects it as a runtime field at `src/server/auth-cors.ts:184-203`. Disk fallback and management 400 coverage are at `tests/config.test.ts:340-352` and `tests/server-auth.test.ts:375-407`. | None beyond final consolidated rerun/status evidence. |
| `160_router_max_input_lowering.md` | `PARTIAL` | API context windows use conditional min-wins at `src/router.ts:106-108`, and API max-input lowering plus route virtual-map absence are tested at `tests/provider-registry-parity.test.ts:107-125`. | `src/router.ts:110` currently calls `mergePositiveNumberCaps` for every registry provider, while the doc requires API-only min-wins and `mergeRecordFill` for others. Today only `openai-apikey` has registry max-input metadata (`src/providers/registry.ts:393-411`), so the defect is latent but the source contract is still wrong and has no non-API regression. |
| `170_gpt56_alias_registration.md` | `ALREADY_DONE` | `gpt-5.6` is in `OPENAI_GPT56_MODELS` with shared API context/max-input/modality/reasoning metadata at `src/providers/registry.ts:99-121`; the API registry builds exactly eight ids at `src/providers/registry.ts:393-411`. Registry and key-login exact-eight assertions are at `tests/provider-registry-parity.test.ts:72-87`. | None beyond final consolidated rerun/status evidence. |
| `180_reasoning_merge_contract.md` | `ALREADY_DONE` | Raw reasoning is spread and `mode: "pro"` wins at `src/providers/openai-virtual-models.ts:66-74`; request parsing requires a nullable object at `src/responses/schema.ts:125-143`; compact strips reasoning at `src/server/responses.ts:1331-1340`. Omitted/null, conflicting mode, effort/summary/generate-summary preservation, idempotence, compact stripping, and invalid shape/no-fetch behavior are covered at `tests/openai-api-virtual-models.test.ts:65-116,157-345,465-488`. | None beyond final consolidated rerun/status evidence. |

Summary: `ALREADY_DONE` 10, `PARTIAL` 3, `NOT_STARTED` 0.

## Cycle 040 remaining audit

Commit `1085ddf7` landed only the icon mapping and preset seed projection
(`gui/src/provider-icons.ts`, `src/providers/derive.ts`). Commit `9bba3605` has now
landed the remainder of Cycle 040 that was uncommitted at audit start:

- canonical reserved POST construction and mutation-resistant payload tests:
  `gui/src/components/AddProviderModal.tsx`, `gui/src/provider-payload.ts`,
  `tests/provider-payload.test.ts`;
- localized Direct/Multi/API cards, API-key empty state, and Multi navigation:
  `gui/src/pages/Providers.tsx`, `gui/src/i18n/{en,ko,de,zh}.ts`;
- absent/enabled/disabled Multi ownership state:
  `gui/src/pages/CodexAuth.tsx`, `gui/src/codex-multi-state.ts`,
  `tests/codex-multi-state.test.ts`;
- namespaced model presentation and selected-id round trips:
  `gui/src/pages/Models.tsx`, `tests/server-auth.test.ts`,
  `tests/provider-registry-parity.test.ts`;
- safe DTO redaction refinement: `src/server/auth-cors.ts`,
  `tests/server-auth.test.ts`;
- implementation/browser evidence and four inspected screenshots:
  `040_management_gui_and_sidecars.md`, `evidence/040_*.png`.

The functional requirements are complete, the fresh automated gates pass, and there is
no remaining Cycle-040 production diff. The browser evidence records Direct/Multi POST
bodies, localized desktop and
mobile states, API-key empty state, selected Pro id, stopped/restarted management API,
responsive overflow checks, image inspection, and an empty console; rerun only if the
final integration/runtime cycle changes rendering or behavior. Cycle 050 still requires
the documented post-restart recheck against the landed runtime.

## Cycle 050 missing gates

Despite commit `e9b6df29` mentioning “final integration verification,” it changed only
`README.md` and `030_openai_api_models_and_pro_aliases.md`. The Cycle-050 document itself
has no appended evidence, and these required gates remain open:

1. `tests/openai-three-tier-e2e.test.ts` does not exist. The mandatory one-config,
   canonical-URL-deny-by-default matrix for HTTP, sequential WS, compact, account
   eligibility/failover, migration/idempotence/backup, selected-id sidecars, log/usage
   identities, and reverse insertion order is absent.
2. The temporary-`CODEX_HOME` client-history activation turn and redacted rollout/session
   metadata excerpt are absent.
3. `README.md:161-191` has the tier table and headline metadata, but the exact selection
   examples, hidden legacy `chatgpt` note, migration restore instruction in this section,
   and explicit no-push/release statement are incomplete.
4. `docs/codex-app-model-catalog.md` is still a dated archive and does not document bare
   Direct versus namespaced Multi/API, official 1.05M/922K API ownership, virtual picker
   identity, or compact base-only behavior. `docs/README.md` does not link the catalog.
5. OpenAI-facing chase notes remain stale, especially
   `devlog/_chase/_model/005_upstream_delta_backlog.md:21`,
   `006_jawcode_import_matrix.md:15`, and
   `007_model_id_delta.md:88-97`, which still describe API-key GPT-5.6 as 372K/research.
6. No current Cycle-050 full `bun test` receipt exists. The `e9b6df29` commit message
   records 14 failures rather than a passing full-suite gate.
7. There are no recorded real-proxy PID/version/port receipts or restarted Direct,
   Multi, and API runtime smokes in `050_integration_verification.md`.
8. The Cycle-040 screenshots have not yet been rechecked against the final landed and
   restarted runtime.
9. The final adversarial review, terminal status sweep, and `_plan` to `_fin` move have
   not occurred.

## Consolidated dependency-ordered cycle map

### Cycle A — Close the real 060–180 gaps and run one hardening sweep

**Diff boundary**

- `tests/openai-api-virtual-models.test.ts`: add an explicit self-referencing virtual
  definition case and snapshot/assert `PROVIDER_REGISTRY` unchanged across malformed
  validation calls. Do not add a second validator or mutate the registry in production.
- `src/router.ts`: make `modelMaxInputTokens` use `mergePositiveNumberCaps` only when
  `providerName === OPENAI_API_PROVIDER_ID`; use `mergeRecordFill` for other registry
  providers, matching the existing context-window branch.
- `tests/provider-registry-parity.test.ts`: retain the API 1M→922K and 300K lowering
  cases and add a non-API registry-backed regression proving user fill/override semantics.
  If the test temporarily installs synthetic max-input metadata on an existing registry
  fixture, restore it in `finally` so global registry state cannot leak between tests.
- `090_max_input_validation.md`: correct the stale DTO sentence to the superseding
  Cycle-040 security contract: management admission accepts validated max-input maps,
  disk persists them, routing consumes them, but `safeConfigDTO` omits them.
- Append fresh implementation evidence to `070`, `090`, and `160`. Do not create
  separate implementation cycles for the ten already-complete documents.

**Acceptance criteria**

- All validator rejection branches named by 070 are activated, including self-reference,
  and validation leaves registry state byte-for-byte unchanged.
- API context/max-input caps remain min-wins; non-API registry providers retain normal
  user fill/override semantics.
  Scope note (audit fold-back): this is a **routed-provider configuration latent
  contract defect** — no production consumer currently reads the merged routed
  `modelMaxInputTokens` (the effective catalog consumer operates separately in
  `src/codex/catalog.ts`), and today only `openai-apikey` carries registry max-input
  metadata. Closure evidence must claim the routed-config contract only, not
  effective non-API auto-compaction behavior. The 070 malformed table becomes ten
  cases after the self-reference addition (070 doc updated accordingly).
- Disk and management validation remain fail-closed, while the safe DTO stays redacted.
- The entire 060–180 focused matrix passes as one closeout sweep.

**Verification**

```sh
bun test tests/config.test.ts tests/server-auth.test.ts tests/provider-registry-parity.test.ts tests/umans-provider.test.ts tests/codex-catalog.test.ts tests/openai-api-virtual-models.test.ts tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts
bun x tsc --noEmit
git diff --check
```

Close with one gap-repair commit and captured pass totals.

### Cycle B — Execute Cycle 050 integration, history, runtime, and GUI proof

**Diff boundary**

- Add `tests/openai-three-tier-e2e.test.ts` exactly as required by Cycle 050. Its
  `globalThis.fetch` interceptor must allow only the two canonical upstream bases and
  declared loopback management URLs, throw on every other URL, and restore fetch/home
  state after every case.
- Cover Direct/Multi/API/three Pro HTTP, sequential Direct→Multi→API→Direct WS ownership,
  compact identities, main/added-account behavior, cooldown/failover, migration plus
  restart idempotence and backup/restore, selected-id sidecars, request log/usage
  identities, and reverse provider insertion order.
- Run one temporary-`CODEX_HOME` API-Pro Codex turn against a local capture upstream;
  append only a redacted selected-id/session excerpt to
  `050_integration_verification.md`, then delete the temporary home.
- Runtime proof uses ISOLATED cold-start child instances on ephemeral ports with
  temporary homes (audit fold-back: the live proxy PID on 127.0.0.1:10100 carries THIS
  session's traffic — restarting it is self-destructive and is forbidden; 050's
  isolated runtime proof section is authoritative). Append child PID/version/port plus
  Direct and Multi receipts.
  Inspect API-key presence without printing it. If present, run one base and three Pro
  prompts within the existing budget (SUPERSEDED by 050's two-call contract: exactly
  one base plus one representative Pro call; all three Pro aliases stay covered by the
  mock E2E); otherwise write exactly
  `NOT RUN (credential unavailable)` and rely on the mandatory mock proof.
- GUI recheck runs against the isolated child instance (or, if the final UI is
  byte-identical to the Cycle-040 build, explicitly accept Cycle-040 screenshot reuse
  with a recorded rationale). Regenerate screenshots only if the final UI differs.
- If the matrix discovers a production defect, keep its fix and regression within this
  cycle only when it is necessary to satisfy an already-locked criterion; otherwise
  stop and amend the plan before expanding scope.

**Acceptance criteria**

- The mandatory test exists and passes every fixed scenario with no public-network
  fallback.
- Selected virtual identity survives catalog, management, history, logs, and usage;
  only outbound API/compact payloads use base ids.
- Direct never touches pool state, Multi proves main eligibility and Multi-only outcomes,
  and API sends no Codex account credentials.
- Migration is idempotent and its backup restore is demonstrated.
- Full automated gates pass; every credential-gated omission is explicit.
- Restarted runtime and GUI evidence is appended to 050.

**Verification**

```sh
bun test tests/openai-three-tier-e2e.test.ts
bun x tsc --noEmit
bun test --isolate tests   # exit-zero gate; plain `bun test` baseline (2734 pass / 14 pre-existing fail) recorded non-gating in 050
cd gui && bun run lint:i18n && bun run build
git diff --check
```

Close with the E2E/evidence commit only after reading the full outputs and runtime
receipts; a passing focused test does not substitute for the full or live gates.

### Cycle C — Documentation/status sweep and archive

**Diff boundary**

- Complete the Cycle-050 SoT edits in `README.md` only (exact selection examples,
  hidden legacy `chatgpt`, backup restore instruction — largely present in the
  working tree; commit them). The no-push/release statement requirement is STALE:
  release scope is owned by 050's terminal rule, not README (audit fold-back R1-2).
  Do NOT refresh `docs/codex-app-model-catalog.md` or add it to `docs/README.md` —
  it is an explicitly dated archive; the maintained SoT owners are
  `docs-site/src/content/docs/guides/codex-app-models.md` and
  `structure/08_openai-provider-tiers.md`. Cycle C verifies those two owners are
  accurate against the landed contract and patches THEM if stale.
- Update only stale OpenAI claims under `devlog/_chase/_model/`, with the known stale
  claims: `005_upstream_delta_backlog.md:21` and `006_jawcode_import_matrix.md:15`
  (API-key GPT-5.6 mislabeled 372K/RESEARCH — correct to Direct/Multi 372K vs API
  1.05M/922K, tier contract implemented, cost still rejected). The working-tree
  corrections already present in `007_model_id_delta.md` and `008_logic_delta.md`
  are preserved and committed as-is.
- Append fresh evidence and terminal status to `040–180`; for the ten
  `ALREADY_DONE` documents, use one consolidated verification receipt rather than
  inventing ten implementation histories. The sweep is COMPLETE only when: all
  thirteen 060–180 `## Status` lines flip from `pending` to their true terminal
  status; 010/020/030/040/050 gain terminal closeout pointers; 050 gains its
  criterion ledger and the `051` final audit artifact; and `000_plan.md` points to
  the consolidation with its start-state instructions marked historical.
- Archive-safety scope expansion (audit fold-back R1-5): update hardcoded `_plan`
  paths that survive the move — `scripts/openai-three-tier-runtime-smoke.ts`
  evidence-dir default, `scripts/openai-hardening-final-gates.ts` doc-path checks
  and default evidence dir — to resolve the unit under `_fin` (or accept an
  explicit `--evidence-dir`/unit-root argument). In-doc `_plan` path mentions in
  040/050/190 get a one-line archive note rather than rewriting history.
- Staging manifest (audit fold-back R1-6, completed R2-2): `devlog/` is gitignored;
  tracked unit files move with `git mv`, but `019_audit_wp020.md`, all 060–190
  docs, the NEW `051_audit_wp050_implementation.md`, and every 050 evidence
  artifact are UNTRACKED-ignored and require explicit `git add -f` after the
  move. Verify the archive commit with `git diff --cached --name-status` compared
  against the FULL Cycle C path list: the unit's own `000_plan.md` map,
  `evidence/`, 051, plus the out-of-unit edits (README.md, the docs-site models
  guide, `structure/08_openai-provider-tiers.md`, chase notes 005–008, and the
  two archive-safety scripts).
- Final gate rerun (audit fold-back R1-1) with EXPLICIT ORDERING (fold-back R2-1):
  (i) make all docs/status/script edits, with the scripts accepting an explicit
  unit-root/evidence-dir argument rather than a flipped hardcoded default;
  (ii) run the 13-command gate owner `bun scripts/openai-hardening-final-gates.ts`
  AGAINST THE `_plan` LOCATION and regenerate `evidence/050_gate_summary.txt`
  (the nine-command receipt is stale and must not certify);
  (iii) create and review `051_audit_wp050_implementation.md` (final audit
  artifact); (iv) only then `git mv` to `_fin`; (v) post-move, run a
  no-`_plan`-reference/link/path check against the moved unit. The gate must
  never create `_fin` before step (iv).
- Update `000_plan.md` so the historical 18-cycle map points to this consolidation and
  all criteria reflect their actual terminal evidence.
- Run a final adversarial diff/contract review. Only after every non-credential-gated
  item is met, move the whole directory from
  `devlog/_plan/260717_openai_hardening/` to
  `devlog/_fin/260717_openai_hardening/` in one archive commit.
- Preserve all unrelated working-tree changes; use path-scoped status and staging.

**Acceptance criteria**

- The maintained SoT owners (README.md, docs-site codex-app-models guide,
  `structure/08_openai-provider-tiers.md`) describe Direct bare ids, namespaced
  Multi/API ids, exact-eight API catalog, official context/max-input ownership,
  Pro selected-versus-wire identity, compact base-only behavior,
  migration/restore, and hidden legacy `chatgpt`. Release scope is owned by 050's
  terminal rule, not README (fold-back R2-3).
- No decade document remains falsely `pending`; evidence distinguishes mock, real, and
  credential-unavailable gates.
- No stale chase note claims API-key GPT-5.6 is 372K or still unimplemented.
- Relative links continue to resolve after the directory move.
- The unit exists only under `_fin`, with no in-scope uncommitted diff.

**Verification**

```sh
rg -n "Status|pending|NOT RUN|openai-multi|openai-apikey|gpt-5.6.*pro|1,050,000|922,000" devlog/_plan/260717_openai_hardening README.md docs-site/src/content/docs/guides/codex-app-models.md structure/08_openai-provider-tiers.md devlog/_chase/_model scripts/openai-three-tier-runtime-smoke.ts scripts/openai-hardening-final-gates.ts
bun test tests/openai-three-tier-e2e.test.ts
bun x tsc --noEmit
bun test --isolate tests   # exit-zero gate; plain `bun test` baseline (2734 pass / 14 pre-existing fail) recorded non-gating in 050
cd gui && bun run lint:i18n && bun run build
git diff --check
git status --short -- README.md docs-site structure devlog/_chase/_model scripts devlog/_plan/260717_openai_hardening devlog/_fin/260717_openai_hardening
```

Run the first `rg` before the move and the path-scoped `git status` both before and
after it. Close only when the archive commit contains the intended unit move and doc
edits, not the unrelated pre-existing deletions elsewhere in the worktree.

## Residual risks

- The present worktree contains many unrelated devlog deletions. Every implementation
  cycle must stage explicit paths and inspect `git diff --cached --stat` before commit.
- Cycle-040 evidence corresponds to the tree committed as `9bba3605`; Cycle 050 still
  requires the explicit post-restart GUI recheck, and any later visual change requires
  refreshed browser proof.
- Live OpenAI API proof is credential-dependent; mock proof is mandatory regardless,
  and missing credentials may skip only the paid live API sub-gate.
- A full suite was not run during this planning audit. The fresh focused and build gates
  are green, but Cycle B owns the definitive full-suite result.
