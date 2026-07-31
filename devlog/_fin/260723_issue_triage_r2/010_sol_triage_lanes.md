# Sol triage lanes — open issues except #314

Snapshot verified against `codex/260723-issue-triage-r2` at `af973e545ba3b8def309f6d18cdb75ba2bc98a8e` on 2026-07-23. GitHub was used read-only (`gh issue view`); no issue, label, or comment was changed.

Bucket key: **A** actionable now on `dev`; **B** needs information / not reproducible from the report; **C** upstream-owned tracking; **D** feature or roadmap item to park.

| Issue | Bucket | Verdict | Recommended disposition |
|---|---|---|---|
| #315 | A | Confirmed quota-window classification bug | Fix on `dev`; add duration-aware quota tests |
| #311 | A | Confirmed stale shadow-model matcher | Fix on `dev`; cover old and current helper slugs |
| #294 | D | Claude account pool is a project-scale feature | Park for a dedicated design/project cycle |
| #290 | B | Boundary is still unknown; reporter has not supplied requested capture | Keep `needs-info` |
| #252 | D | Placeholder/display UX enhancement, not a demonstrated routing defect | Park in UX backlog |
| #241 | C | Desktop picker filters an otherwise valid catalog | Keep `upstream-tracking` |
| #208 | D | New compatibility endpoint; implementation is tracked by PR #279 | Track PR; close only after merge/verification |
| #201 | D | TRAE International provider lacks a supported upstream contract | Keep roadmap; wait for official auth/transport docs |
| #178 | D | Factory exposes an agent-execution backend, not ordinary inference | Park as separate backend architecture work |
| #177 | D | Warp exposes an agent-execution backend, not ordinary inference | Park as separate backend architecture work |
| #95 | D | Multi-user tenancy/isolation is project-scale | Keep roadmap |
| #92 | C | Codex client encrypts NEW_TASK before the proxy can route it | Keep `upstream-tracking`; V1 remains workaround |
| #42 | D | Phase 1 has landed; destructive cleanup phases remain high-risk roadmap work | Keep roadmap for Phase 2+ |

## #315 — monthly `primary_window` shown as weekly

**Verdict: A, confirmed actionable bug.** The report accurately identifies the current parser behavior.

Evidence:

- `src/codex/quota.ts:10-17` models WHAM windows with only `used_percent` and `reset_at`; `limit_window_seconds` is discarded by the type.
- `src/codex/quota.ts:112-122` unconditionally treats `primary_window` (falling back to `secondary_window`) as weekly and only treats `tertiary_window` as monthly.
- `src/codex/quota.ts:128-135` consequently emits a Team account's 30-day primary value as `weeklyPercent` and `weeklyResetAt`.
- `gui/src/components/QuotaBars.tsx:52-70` already has distinct weekly and monthly rendering paths. The UI is downstream of the incorrect API classification rather than the root cause.
- Existing parser coverage starts at `tests/codex-routing.test.ts:560` and `tests/rate-limit-reset-credits.test.ts:11`, but the production type currently cannot represent the reported duration.

Root-cause hypothesis: WHAM changed/varies the semantic placement of quota windows. OpenCodex infers semantics from field position and a narrow plan-name exception instead of the supplied window duration, so a `primary_window` of 2,628,000 seconds is necessarily classified as weekly.

Fix sketch:

1. Add optional `limit_window_seconds` (and, if useful for fixtures, `reset_after_seconds`) to the shared WHAM window shape.
2. Classify a primary window with an explicit duration of at least 28 days as monthly; retain the current weekly fallback when duration is absent for backward compatibility.
3. If primary is monthly and secondary is present, preserve secondary as the weekly source. Preserve the existing tertiary monthly fallback and define deterministic precedence when both monthly sources exist.
4. Add regression cases for 604,800-second primary, 2,628,000-second primary, monthly primary plus weekly secondary, legacy tertiary, and missing-duration compatibility. The existing GUI should then display the monthly bar without a separate UI rewrite.

## #311 — shadow intercept misses `gpt-5.6-luna`

**Verdict: A, confirmed actionable bug.** Current `dev` only recognizes the previous helper slug.

Evidence:

- `src/server/responses.ts:949-963` gates the intercept on `parsed.modelId.startsWith("gpt-5.4-mini")`; `gpt-5.6-luna` and `gpt-5.6-terra` cannot enter the rewrite path.
- `src/types.ts:485-493` documents the setting exclusively as a `gpt-5.4-mini` redirect, so the public config contract is stale too.
- `src/providers/openai-tiers.ts:101-109`, `src/providers/openai-tiers.ts:120-129`, and `src/providers/openai-tiers.ts:163-173` concern the configured replacement model (`shadowCallIntercept.model`), not source-model recognition. They do not make the intercept match Luna or Terra.
- No focused shadow-call source-matching regression was found in `tests/`; catalog tests containing these slugs do not exercise the request rewrite.

Root-cause hypothesis: source helper identity was embedded as a literal when the feature was introduced. Codex 0.145.0 changed the hidden/helper family, but OpenCodex has no source-model set or compatibility predicate to absorb that change.

Fix sketch:

1. Centralize a conservative predicate/default set for known shadow/helper source models, retaining `gpt-5.4-mini` and adding the verified `gpt-5.6-luna`. Add `gpt-5.6-terra` only if runtime capture confirms it is also a helper call; binary string adjacency alone is weaker evidence than a request capture.
2. Prefer an optional `sourceModels` config override if maintainers want future changes to be user-serviceable, while keeping safe defaults and prefix behavior for variants.
3. Update `src/types.ts` docs and add request-level regression tests proving known helper slugs rewrite, unrelated foreground models do not, and effort remains forced to `low`.

## #294 — Claude account pool parity

**Verdict: D, feature/roadmap.** Current code supports Anthropic OAuth and Claude routing, but not a Claude equivalent of the Codex account-pool control plane.

Evidence:

- `src/oauth/anthropic.ts:1-14` implements one Anthropic OAuth flow and credential contract.
- `src/oauth/index.ts:72-76` registers Anthropic as an OAuth provider; this is provider-account support, not quota-aware pooled selection.
- `src/types.ts:548` explicitly introduces the multi-account pool as the **Codex** pool, and `gui/src/components/CodexAccountPool.tsx:18` describes the global ChatGPT/Codex pool.
- `src/codex/auth-context.ts:50` contains the OpenAI pool selection failure path. No analogous Claude pool coordinator, affinity store, quota scorer, or dashboard was found.

This is not a small reuse patch: Anthropic subscription quota discovery, organization identity, affinity, cooldown semantics, credential safety, and account-risk policy need a dedicated design. Park it rather than classify it as a current regression.

## #290 — custom parent emits empty `spawn_agent` arguments

**Verdict: B, keep `needs-info`.** The issue author has not replied since the maintainer requested a sanitized four-boundary capture on 2026-07-23.

Evidence:

- The latest issue comment requests the incoming `additional_tools` schema, translated provider schema, raw provider arguments, and emitted Responses argument events; there is no later reporter response.
- `tests/multi-agent-compat.test.ts:261-279` covers the real Desktop `additional_tools` input shape and confirms those tool definitions are seen.
- `src/bridge.ts:547-565` creates a function-call item and appends every provider `tool_call_delta` byte to its argument buffer. This supports the maintainer's conclusion that the symptom is compatible with zero bytes arriving from upstream, but does not locate where they disappeared.
- `src/server/responses.ts:268-272` injects schema-agnostic collaboration guidance; it cannot guarantee that a provider/model emits required structured arguments.

The present report cannot distinguish a missing client schema, translation loss, provider structured-tool limitation, or model failure. Keep the label and request unchanged until the boundary capture exists. V1 or inherited-model delegation remains a workaround, not proof of a proxy bug.

## #252 — Sonnet placeholder confusion

**Verdict: D, UX enhancement.** The report describes ambiguous client-visible labeling and explicitly does not demonstrate that the wrong model was routed.

Evidence:

- OpenCodex config does expose explicit Claude tier slots, including Haiku (`src/types.ts:332`) and the GUI/config implementation around `src/types.ts:429` and `gui/src/pages/ClaudeCode.tsx`.
- The reported label is presented by Claude Code's subagent UI. No OpenCodex source was found that generates a generic subagent display label of “Sonnet”.
- The maintainer's latest issue comment correctly asks for a capture showing the executed route differs from the label before treating it as a routing bug.

Park as a display/labeling request. If a future trace shows request-log/provider identity disagrees with the configured tier, reclassify that concrete case as a bug.

## #241 — routed models absent from Desktop picker

**Verdict: C, `upstream-tracking` remains correct.** The issue's diagnostics show the generated catalog, bundled CLI, and app-server all contain the routed models; only the Desktop frontend picker removes them.

Evidence:

- `src/types.ts:475-480` defines OpenCodex visibility control through catalog inclusion/`visibility` and `/v1/models`; there is no Desktop remote-allowlist control.
- `src/config.ts:580-586` and the catalog implementation supply picker-visible model IDs, while `tests/codex-catalog-sync-hardening.test.ts:59-89` verifies current native/routed catalog preservation behavior.
- The issue's direct `model/list` evidence crosses the final OpenCodex-controlled boundary successfully. A client-side `available_models` allowlist applied afterward is not alterable by this proxy.

Keep open for discoverability and upstream tracking. Reassess only if Codex Desktop exposes a supported allowlist/config hook.

## #208 — native `/v1/chat/completions`

**Verdict: D, feature work already tracked by PR #279.** The endpoint is not present in this base checkout.

Evidence:

- A source search finds provider-side outbound chat requests at `src/adapters/openai-chat.ts:561`, but no inbound server route or handler for `POST /v1/chat/completions`.
- The issue's latest maintainer comment says PR #279 implements streaming and tool calls and still had two blockers: preserving non-2xx status and reconciling final tool arguments.

Do not duplicate the implementation from this triage lane. Track and review #279, then verify non-streaming, SSE, tool calls, upstream status propagation, final argument reconciliation, auth, and cancellation before closing the issue.

## #201 — TRAE International provider

**Verdict: D, roadmap blocked on an official upstream contract.** No TRAE adapter or provider registration exists in current source.

Evidence:

- No `trae` integration was found under `src/`, `gui/`, `tests/`, or maintained docs.
- The latest issue comment records that TRAE International has no documented supported token issuance/refresh and inference transport suitable for implementation.
- Existing provider adapters are HTTP inference contracts; depending on private IDE credentials or undocumented endpoints would violate the issue's own security/non-goals.

Keep parked until TRAE International publishes a sanctioned API, OAuth/refresh lifecycle, or supported ACP contract for `trae.ai` accounts.

## #178 — Factory provider

**Verdict: D, roadmap.** The current issue conclusion is that Factory's supported surface is Droid Exec/SDK, an agent-execution backend rather than a model inference endpoint.

Evidence:

- No Factory provider registration or adapter exists in current source (the `factory` matches in tests are generic dependency-injection factories, not the product).
- OpenCodex's current provider adapters translate inference protocols. Hosting another agent runtime requires lifecycle, tool, session, cancellation, and result-translation architecture beyond a normal adapter.

Keep as a separately scoped execution-backend project. A documented plain inference API would allow reevaluation as a conventional provider.

## #177 — Warp provider

**Verdict: D, roadmap.** Warp's public Oz `agent/run` surface is likewise an agent-execution API rather than plain model inference.

Evidence:

- No Warp provider registration or adapter exists in current source.
- The latest issue comment identifies `POST /api/v1/agent/run` as the relevant public surface, which does not match the streaming Responses/chat adapter contracts currently implemented.

Park as separate agent-backend architecture work. Reclassify only if Warp offers a supported inference protocol or the project deliberately adds agent-backend support.

## #95 — multi-user hosting / LiteLLM

**Verdict: D, roadmap.** Pieces of the transport work in a shared deployment, but trustworthy tenancy does not exist.

Evidence:

- Current OpenCodex pool state is global (`src/codex/quota.ts:23` is a process-wide account quota map; `gui/src/components/CodexAccountPool.tsx:18` calls the pool global).
- The issue thread has practical evidence that nginx admission-header injection, passthrough Authorization, provider routing, image generation, and catalog refresh can work.
- The remaining requirements—tenant identity, isolation, authorization policy, attribution, and concurrency/load guarantees—cut across auth, logs, account state, management APIs, and GUI. They are not a single defect with a bounded code pointer.

Keep the roadmap classification. A future project should begin with a tenant/security model and data-isolation inventory before adding user tags or load tests.

## #92 — V2 cross-provider NEW_TASK ciphertext

**Verdict: C, `upstream-tracking` remains correct.** Current source can preserve or decode proxy-owned envelopes, but cannot decrypt backend-owned Fernet ciphertext generated by Codex/native infrastructure.

Evidence:

- `src/responses/parser.ts:193-203` explicitly treats `encrypted_content` as opaque to routed models and substitutes `[encrypted content omitted]`.
- `README.md:237` documents the same native-parent/routed-child V2 limitation and recommends V1 for reliable cross-provider delegation.
- `tests/multi-agent-compat.test.ts` pins the supported plaintext/compatibility shapes, but no proxy code can reconstruct plaintext that never crossed its boundary.

The existing labels match reality. Keep open as upstream tracking; do not promise a proxy-only fix for pure ciphertext. Retest after an upstream Codex change that retains/duplicates `SpawnAgentArgs.message` in plaintext for non-native children.

## #42 — Storage page and cleanup policy

**Verdict: D, roadmap for Phase 2+.** The issue's read-only Phase 1 is already implemented on current `dev`; deletion and automatic cleanup are intentionally outstanding.

Evidence:

- `src/storage/scanner.ts:1-20` implements a read-only scanner and explicitly uses immutable SQLite access to avoid WAL/SHM writes.
- `src/server/management-api.ts:505-515` exposes `GET /api/storage` with graceful failure.
- `gui/src/pages/Storage.tsx:114-171` implements the diagnostics page, and `gui/src/App.tsx:339` routes it.
- The remaining cleanup work must reconcile rollout files, SQLite thread rows, attachments/manifests, locks, quarantine, preview, and confirmation. That is destructive C4-style lifecycle work, not a triage-sized bug.

Keep open for Phase 2 manual cleanup and Phase 3 opt-in policy. Require preview-first behavior, quarantine by default, lock safety, and dedicated destructive-path review before implementation.

## Verification notes

- Read all 13 live issue records with `gh issue view <n> --json title,body,labels,comments`.
- Confirmed branch `codex/260723-issue-triage-r2` and base/HEAD `af973e545ba3b8def309f6d18cdb75ba2bc98a8e`.
- Source inspection only; no tests were run because this task made no code changes.
- No GitHub mutation was performed.
