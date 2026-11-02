# 261102 — Request-owned bearer conversation affinity (#8080)

**Reader summary.** When Codex CLI signs in with ChatGPT and talks to a pool-mode proxy, its own
bearer makes `main` one more round-robin candidate (#5019), but the request gets no affinity key, so
every turn re-runs the strategy and a conversation hops between main and the stored accounts. The
request log then labels each of those unbound picks `new_bind/healthy`, which claims a binding that
was never stored. This unit makes the label honest for everyone and adds an opt-in,
`codexPool.requestOwnedAffinity` (default off), that keeps one account per conversation for a
request-owned bearer under a key only that exact bearer can address. Research: `010_research.md`.

## Loop spec

- Archetype: satisfy-spec, one work-phase (wp1).
- Trigger: issue #8080 (re-report of #6998), Lane D of four parallel lanes.
- Goal: (a) no `new_bind/healthy` row without a stored binding; (b) opt-in per-conversation
  binding for request-owned bearer traffic in pool mode.
- Non-goals: Lane B persistence (`thread-affinity.ts` storage), Lane C round-robin eligibility
  (`selection.ts`), Lane A Claude identity; labelling caller-owned `main` rows (they carry no
  decision today); the pre-existing `lineage_parent`/`lineage_sibling` whitelist gap in
  `src/usage/log.ts` (reported as follow-up); merging.
- Verifier: focused tests below; `bun run typecheck`; `bun run structure:check`;
  `bun run privacy:scan`; `bun scripts/test.ts --changed=dev --parallel=1`; PR CI.
- Stop: PR against dev green with Codex/CodeRabbit findings addressed; not merged.
- Memory: this unit + `.codexclaw` goalplan; security review text in `.tmp/` only.
- Outcomes: DONE as above; UNSAFE if review finds cross-principal steering the design cannot close;
  BLOCKED if CI/review cannot be resolved within lane authority.
- Escalation: coordinator decides; ownership decision delegated to this lane by the owner.
- Resource bounds: none stated; host limits apply.

## Ownership invariant

**Before.** A request-owned main bearer exists for one request and owns no Pool affinity, lineage,
durable account state or shared-active state; stored Pool credentials may still serve it under
ordinary unbound selection (#5019, structure/providers/openai-tiers.md).

**After.** Unchanged by default. With `codexPool.requestOwnedAffinity: true`, the request may own a
process-local binding from `(exact Authorization value, conversation key)` to the serving account
id. The bearer never enters Pool credential, health, lineage, persistence or shared-active state; the
binding names only which account served, and every turn re-checks that account's eligibility.

**Why a caller's key cannot steer another principal's credentials.**
1. The key is `request-owned:v1:<HMAC-SHA256(process-random key, domain ‖ Authorization ‖ 0x00 ‖
   conversationKey)>`. Two requests share a binding only if they present the byte-identical
   Authorization header and the same conversation key. Without the bearer and the process key, a
   key cannot be forged; a stored-credential request's raw conversation key cannot collide.
2. A binding to `__main__` is always served from the presenting request's own bearer (request-owned
   main context, no stored-main read, generation fixed at 0). Equality of the key implies the same
   bearer, so no caller is ever served with another caller's credential.
3. A binding to a stored Pool account names an account ordinary unbound selection could already
   give this caller; reuse re-runs `isCodexAccountSelectable` with the request's own options.
4. An account-id claim is NOT used as principal: it is header-suppliable and shared across workspace
   members (research D1). Token rotation therefore starts a new binding (one rebind), by design.
5. Process-local: the HMAC key is random per process, so a restart makes old keys unreproducible.
   Persistence (Lane B) must skip keys for which `isRequestOwnedAffinityKey(key)` is true; until Lane B
   lands nothing is persisted.
6. No raw account id, email, token or conversation id appears in the key or in any log line.

## Decisions

- D1 honest label: new move `unbound` and reasons `no_conversation` / `request_owned`.
  `affinityAfterRelease(null, undefined)` returns `{unbound, no_conversation}`; a release reason with
  a null key keeps `rebound`'s current semantics only when a key exists — with a null key there is no
  binding, so it returns `{unbound, no_conversation}` too (pending reasons are keyed by thread and
  cannot exist for null). auth-context relabels to `request_owned` when the key was withheld because
  the credential is request-owned (opt-in off). `unbound` is not a move, so `requestSpendRecord`
  excludes it from `moveReasons`.
- D2 opt-in: `codexPool.requestOwnedAffinity?: boolean`, default false, config-file/`ocx config set`
  only (same surface as `startIdleWindows`), no GUI control.
- D3 key: leaf module `src/codex/request-owned-affinity.ts` derives the key (D1 of invariant) and
  exports `isRequestOwnedAffinityKey`. Conversation keys over the existing 512-byte affinity
  component bound produce no key (parity with stored traffic).
- D4 lineage stays off for request-owned traffic even when keyed: lineage is gated on
  `poolStateEligible`, not on `affinityKey !== undefined`.
- D5 preview parity: request preview (subagent fallback, request-prepare) uses the same derivation as
  final auth via one exported function, so preview and resolution read the same binding (#4850).
  Today preview uses the raw key for a request-owned bearer while final uses none; after this change
  both use the derived key (none when off).
- D6 conversation-state issuer: unchanged code; pool contexts already prefer `authCtx.affinityKey`,
  which becomes the namespaced key when the opt-in is on.

## File change map (PLAN-FIELD-CHAIN-01)

| Stage | File | Change |
|---|---|---|
| creation | src/codex/routing/thread-affinity.ts | union: move `unbound`, reasons `no_conversation`, `request_owned`; `affinityAfterRelease` null-key branch |
| creation | src/codex/request-owned-affinity.ts (new) | key derivation, `isRequestOwnedAffinityKey`, relabel helper |
| creation | src/codex/auth-context.ts | key from shared function; lineage gate D4; relabel; exported preview key fn; stays < 2000 lines |
| config | src/types/config.ts (≤ 1999 lines), src/config/schema/leaf-validators.ts | `requestOwnedAffinity?: boolean` |
| serialization | src/usage/log.ts | add values to `KNOWN_AFFINITY_MOVES` / `KNOWN_AFFINITY_REASONS` |
| consumer | src/server/request-log.ts | `requestSpendRecord` skips `unbound` |
| consumer | src/server/responses/request-prepare.ts | preview key via shared function (D5); issuer fallback unchanged |
| consumer | management request-history, cache-diagnostic | pass strings through; N/A, no switch on values (research A) |
| deserialization | src/usage/log.ts normalizer | same sets (round-trip test) |
| docs | docs-site/.../guides/codex-integration.md (+ locales if they mirror the startIdleWindows section) | opt-in section + label meaning |
| structure | structure/providers/openai-tiers.md (request-owned section) and the doc owning auth-context; manifest entry for the new file | invariant after |
| tests | tests/codex-integration/codex-request-owned-affinity.test.ts (new, registered in scripts/test-layout + tests/fixtures/test-layout-expected shard); update existing expectations that assert `new_bind/healthy` for null keys | |

File-size: routing.ts must not grow (cap 1626, now 1623); auth-context.ts 1990 and types/config.ts
1994 against the 2000 threshold — move code byte-for-byte to the new sibling if needed, never delete
comments to fit.

## Acceptance (with activation scenarios)

1. Off (default), request-owned bearer, round-robin over main + stored accounts, same conversation,
   several turns: every Pool selection reports `{unbound, request_owned}`; no thread-affinity entry is
   created. Fails on old code (reports `new_bind/healthy`).
2. Stored-credential request with no conversation identity: `{unbound, no_conversation}`. Fails on
   old code.
3. On, same scenario as 1: the conversation is served by one account on every turn (first
   `new_bind/healthy`, then `reused/healthy`), including when that account is main. Fails on old code
   (account alternates).
4. On, two different Authorization values with the same conversation key: bindings are independent
   (the second caller's first turn is `new_bind`, never `reused`); a stored-credential request with the
   same raw conversation key does not see the request-owned binding.
5. On: no lineage record is written for request-owned traffic.
6. On: bound account becomes ineligible (pause/cooldown) → ordinary release path, request never
   sent to an ineligible account.
7. Preview parity: request preview with the opt-in on reads the binding final auth uses; off → no key.
8. usage.jsonl round-trip keeps `unbound`/`request_owned`/`no_conversation`; spend `moveReasons` excludes
   `unbound`.
9. Request-owned main binding performs no physical-main auth-file read (existing read-fence pattern).
10. Config schema accepts `codexPool.requestOwnedAffinity: true`, rejects a non-boolean.

## Bypass record (PLAN-BYPASS-NAMED-01)

- Tier E3 (runtime code path), surface: auth-context resolution. Known bypass: none for steering —
  key requires the exact bearer. Residual: a caller who shares its bearer with another process shares
  its bindings (same principal by definition). Lane B persistence could serialize namespaced keys if it
  ignores `isRequestOwnedAffinityKey`; residual risk low because keys are unreproducible after
  restart. Wording: "scoping", not "enforcement against the bearer holder".

## Architect consultation

- Proposal: Terra research task (thread `thread:delegated-task:...a1a1de03...`), sections A–F +
  recommendation, recorded in `010_research.md`. Accepted: label fix, default-off process-local
  namespace, no account-id principal, preview parity, Lane B exclusion. Amended: token-scoped
  principal chosen over an authenticated stable principal (none exists without verifying JWTs).
  Rejected: always-serve-main (contradicts #5019/#3166).
- Reflection: MISALIGNED (9 points); dispositions in Revision 2.


## Revision 2 — reflection dispositions (reflection: MISALIGNED, same Terra thread, 2026-11-02)

D1 is REPLACED, D5/D6 amended, acceptance 3 amended, new D7–D9.

- R1 (issuer for caller-owned main) ACCEPTED, opt-in path only. When the request-owned key exists,
  the caller-owned `main` context returned by the request-owned main selection carries `affinityKey`
  and `affinityDecision`. `conversationStateBindingFromAuth` accepts a `main` context that carries an
  `affinityKey` and reports issuer `__main__`. Because the key is scoped to the exact bearer, `__main__`
  under that key means "this caller's own credential". Regular responses and compact already commit
  through this helper, so Pool→main and main→Pool moves both scrub carried state. With the opt-in off
  nothing changes (main records no issuer, as today).
- R2 (main rows) ACCEPTED: `noteCodexSelectionAffinity` copies a decision from a `main` context when
  present. Acceptance 3 now asserts the decision on the returned context for main and Pool alike.
- R3 (headers) NARROWED: final auth derives the key inside `resolveCodexAuthContext` from the headers
  and `requestScopedMainCredential` it already receives; `codexRouteCredentialOwnership` already
  excludes substituted admission bearers and injected Claude-main bearers from request ownership, and
  retries re-enter the same function. Preview derives from `previewAuthHeaders` +
  `previewRequestScopedMainCredential`, the same inputs the existing lineage preview uses; a reroute that
  changes headers changes preview exactly as it does for lineage today. Preview is read-only, so a
  divergence cannot grant a credential.
- R4 ACCEPTED: tests for fixed stored account, fixed main and Reserve (no key in preview and final).
  Independent quota scopes and model detours reuse the existing scope machinery unchanged (no new
  code path); one test that a gated-model detour under the namespaced key keeps the ordinary binding.
- R5 ACCEPTED → D1': honest label at one boundary. After resolution, auth-context calls
  `honestAffinityDecision` (new module): a `new_bind` or `rebound` decision is kept only if an
  ordinary or model-detour entry for the key now names the selected account; otherwise
  `new_bind` → `{unbound, reason}` and `rebound` → `{cleared, reason}`. Reason for `unbound`:
  `request_owned` when the key was withheld for a request-owned credential (opt-in off),
  `no_conversation` when no key exists for any other reason, and the original reason when a key existed
  but no binding was stored (oversized key, credential-removal race, non-binding selection branches).
  `affinityAfterRelease` is unchanged; `routing.ts` is untouched.
- R6 ACCEPTED: the 512-byte remark is dropped; the derived key is fixed length.
- R7 ACCEPTED as policy: derivation may READ only the caller's own lineage scope (HMAC of the same
  Authorization), which request-owned traffic never writes; no recording. Documented limitation:
  session-less multi-generation subagent chains of request-owned traffic key per thread.
- R8 PARTIAL: upload retention needs no new code — it applies to any bound conversation, which the
  opt-in now creates; involuntary-move refusal keys on the issuer, which R1 now records for main.
  Test: a Pool→main move under the namespace triggers the account-change scrub. Full compact/retry
  file matrices remain covered by existing suites.
- R9 ACCEPTED: `requestSpendRecord` keeps explicit `affinityMoveReasons`; in the fallback branch it
  includes `affinityReason` only when `affinity !== "unbound"`. Lane B contract (structure doc +
  `isRequestOwnedAffinityKey`): never serialize or restore entries or issuer records under a
  request-owned key, any scope. If Lane B lands first, this lane applies the filter on rebase.

Added acceptance:
11. Boundary label: a non-binding selection branch with a valid key reports `unbound` (fails on old code).
12. Opt-in on: Pool→main→Pool sequence records issuer `__main__` and the account-change scrub fires on
    each move.
13. Spend: a row with `{unbound, request_owned}` has no `moveReasons`; a row with an earlier real move
    keeps it.


## Revision 3 — audit round 1 dispositions (verdict FAIL, 4 blockers, 6 findings)

- B1 ACCEPTED. Both previews derive the key with the same exported function final auth uses:
  first preview from `previewAuthHeaders` + `previewRequestScopedMainCredential` + route/policy; recovery
  preview (request-prepare ~1160-1230) from `recoveryAuthHeaders` + `recoveryRequestScopedMainCredential`
  + the current route/policy, recomputed inside the recovery block. `poolAffinityKey` (raw) stays only
  as the issuer fallback for stored-credential traffic. Test: a reroute between first preview and
  recovery that flips ownership yields different keys and each preview reads its own binding.
- B2 ACCEPTED. Every caller-owned main return after key derivation (auth-context ~1483 pool selection,
  ~1502 no-selectable fallback, ~1669 stored-account cooldown fallback; the excludeAccountId retry path
  reaches the same returns) goes through one local wrapper that attaches `affinityKey` (when the
  request-owned key exists) and an honest decision for the account actually served (`__main__`).
  Returns BEFORE key derivation (direct mode, fixed main, Reserve, manual pin preserve) stay keyless.
  Issuer identity for a keyed main context is `__main__`: one helper maps a context to its
  conversation-state account id (pool/main-pool → accountId, keyed main → `__main__`, else none), used by
  `conversationStateBindingFromAuth` and by the `priorAccountId` of the retry scrub. The retry fallback
  (core-codex-account ~913) and the compact alternate fallback (compact ~1428) read `affinityKey` from
  the first context whenever it carries one, not only for pool kinds. Tests: regular retry Pool→main
  and compact Pool→main under the opt-in record issuer `__main__` and scrub `previous_response_id`;
  main→Pool scrubs on the next turn; a file-bearing turn whose issuer differs triggers the existing
  file-reference refusal.
- B3 PARTIAL, with a stated contract. Lane B (#8091, plan only, no code yet in its worktree) persists
  live `threadAccountMap` and issuer entries as `sha256(key)` digests and restores a row only when a
  request looks up the same digest. This lane's namespace uses its OWN process-random HMAC key (never
  Lane B's durable secret), so after a restart no request-owned key can be re-derived and no row can be
  restored: the binding never survives a restart in either landing order. What can remain is an inert
  digest row on disk until TTL/LRU drops it. To close even that, this lane exports
  `isRequestOwnedAffinityKey`, documents in structure/providers/openai-tiers.md that persistence must
  skip such keys on write and restore (entries in every scope and issuer records), and the PR states the
  merge-order dependency: if Lane B lands first, this PR adds the filter and a regression before review;
  if this PR lands first, the coordinator carries the contract into Lane B. A combined-branch test is
  impossible today because Lane B has no code; that gap is reported, not hidden.
- B4 ACCEPTED. Every opt-in test first establishes a namespaced binding (asserts `new_bind` then
  `reused` on the second turn), then exercises isolation (other bearer, same conversation: `new_bind`
  on a different-or-same account but never `reused`, and the first caller's next turn is still
  `reused`), stored-credential isolation (raw key sees no entry), lineage (no write AND the caller's
  lineage scope stays empty after bound turns), ineligibility release, and the read fence while bound
  to main. Negative ownership tests: an admission-substituted bearer and an injected Claude-main bearer
  with the opt-in on get the ordinary raw key (stored-credential semantics), never the namespace.
  Default-off regression kept separately. Feature tests are run against old code and their failure
  recorded.
- F1 ACCEPTED with semantics: label means "the selected account is bound under this request's key at
  the moment selection returns". The check runs synchronously right after
  `resolveCodexAccountForThreadDetailed` returns, before any await (auth-context ~1439-1473 has no await
  in between), so no other request can interleave. Stated in a comment; no selection.ts change.
- F2 ACCEPTED: acceptance and docs say "one account per conversation within one quota scope, absent
  a release or a model detour"; test two quota scopes bind independently.
- F3 ACCEPTED: file map updated below.
- F4 ACCEPTED: header-component limits in lineage.ts still apply before derivation; tests for missing
  and oversized `session-id` give no key (and `{unbound, no_conversation}` / `request_owned`).
- F5 ACCEPTED: dedicated Terra security review of the implementation is a delivery criterion (c-4).
- F6 ACCEPTED: `tests/lab/core-lab-boundary.test.ts`, file-size ratchet test and test-layout guards run
  explicitly in C.

### File change map (rev 3, supersedes the table above)

| File | Change |
|---|---|
| src/codex/request-owned-affinity.ts (new, leaf: imports lineage + thread-affinity only) | key derivation, `isRequestOwnedAffinityKey`, `honestAffinityDecision`, conversation-state account id helper if it fits better here |
| src/codex/routing/thread-affinity.ts | union additions only (`unbound`; `no_conversation`, `request_owned`) |
| src/codex/auth-context.ts | key via shared fn; lineage gate on `poolStateEligible`; honest decision after resolution; keyed caller-main wrapper; exported preview key fn; main context type gains optional `affinityKey`/`affinityDecision`; < 2000 lines (move code byte-for-byte to the new module if needed) |
| src/server/responses/account-change-state.ts | `conversationStateBindingFromAuth` accepts keyed main |
| src/server/responses/core-codex-account.ts, src/server/responses/compact.ts | retry/compact fallback key + priorAccountId mapping |
| src/server/responses/request-prepare.ts | first and recovery preview keys |
| src/server/request-log.ts | `noteCodexSelectionAffinity` accepts main decision; spend fallback skips `unbound` |
| src/usage/log.ts | KNOWN sets |
| src/types/config.ts, src/config/schema/leaf-validators.ts | opt-in field |
| docs-site guides/codex-integration.md (+ locales that mirror startIdleWindows) | opt-in + label meanings + scope limits |
| structure/providers/openai-tiers.md (+ any doc mapped to the touched files by structure/manifest.json) | invariant after, Lane B contract |
| tests/codex-integration/codex-request-owned-affinity.test.ts (+ responses-level test file if needed), layout registration | acceptance 1-13 + B1/B2/B4 cases |


## Revision 4 — audit round 2 dispositions (verdict FAIL, 1 blocker, 3 findings)

- B3 (round 2) ACCEPTED, grounded in Lane B's CURRENT design (goat-lane-b .../020_plan_revision.md §B-C):
  Lane B keeps `CODEX_LINEAGE_KEY` process-local, registers a one-slot observer in
  `codexConversationKeyFor` that maps each derived `app:` key to its anchor, derives durable row keys from
  the anchor with its own store secret, and treats keys with no recorded anchor as memory-only; it never
  persists `__main__` pins. A `request-owned:v1:<hmac>` key is not produced by `codexConversationKeyFor`, so
  under that design it never receives an anchor and its thread rows and issuer rows stay memory-only. The
  underlying `app:` key IS observed while this lane derives the wrapper, but nothing binds under it for
  request-owned traffic with the opt-in on (auth carries only the wrapper).
  Contract (structure/providers/openai-tiers.md + PR description), stated as requirements on persistence:
  (1) never register an anchor for a key where `isRequestOwnedAffinityKey(key)` is true; (2) never serialize
  a thread row (any scope, including model-detour scopes) or issuer row for such a key; (3) never adopt a
  restored row into such a key. Delivery dependency: whichever of Lane B / Lane D lands second adds a
  combined restart regression (bind a request-owned conversation, flush, restart, assert no row and no
  reuse). If Lane B lands before this PR is ready, this lane adds it on rebase; otherwise the coordinator
  carries it into Lane B. This lane's own test asserts the wrapper never equals the observed `app:` key
  and that `isRequestOwnedAffinityKey` recognises every key this lane binds.
- F4 (round 2) ACCEPTED: no-key tests name the header combinations — no `session-id`/`thread-id`/parent →
  no key; oversized `session-id` with no parent → no key; oversized `session-id` plus a VALID parent thread
  → key derived from the parent (existing fallback preserved, wrapped for request-owned).
- F1 (round 2) ACCEPTED: comment, docs and tests describe the label as selection-time ("bound when
  selection returned"); no claim about the binding at upstream dispatch.
- F3 (round 2) ACCEPTED: extraction candidate is the request-owned pin block
  (`requestOwnedMainPinHasQuotaHeadroom` + `requestOwnedMainPinState`, auth-context ~110-160), moved
  byte-for-byte into a sibling `src/codex/request-owned-main-pin.ts` and re-exported from auth-context so
  existing importers (request-prepare) are unchanged; the new modules must not import auth-context
  (acyclic). Implementation verifies with the ratchet and Lab boundary tests.


## Revision 5 — audit round 3 disposition (verdict FAIL, 1 blocker)

- F3 extraction (round 3 blocker) ACCEPTED. The sibling `src/codex/request-owned-main-pin.ts` receives,
  byte-for-byte, `requestOwnedMainPinHasQuotaHeadroom`, `requestOwnedMainPinState` AND their private
  dependencies `mainCreditsHoldResetAt` (auth-context ~789) and `callerMatchesObservedMain` (~811), with
  their imports. auth-context imports both helpers back (they are used elsewhere in it) and re-exports
  `requestOwnedMainPinState`, so request-prepare.ts:60 and codex-account-threshold-auth.test.ts:27 are
  unchanged. `CodexAuthPolicyConfig` reaches the sibling through `import type` from auth-context, which is
  erased at runtime; the sibling has no runtime import of auth-context. Verification: typecheck, the Lab
  boundary test, the file-size ratchet, and `rg -n "from \"./auth-context\"" src/codex/request-owned-main-pin.ts`
  showing only an `import type` line. If the implementer finds a smaller byte-for-byte block that frees
  enough lines with all its dependencies, it may use that instead and must report which.


## Revision 6 — audit round 4 disposition (verdict FAIL, 1 mechanical blocker, 1 verification note)

- R4-1 ACCEPTED: auth-context imports `requestOwnedMainPinState` (it is called locally at ~1190) together
  with `mainCreditsHoldResetAt` and `callerMatchesObservedMain`, and separately re-exports
  `requestOwnedMainPinState` (`export { requestOwnedMainPinState } from "./request-owned-main-pin"` or an
  import plus `export { ... }`).
- R4-2 ACCEPTED as a verification gate: the extraction frees about 69 lines; additions to auth-context are
  limited to wiring (key call, lineage gate, honest-decision call, caller-main wrapper, preview export,
  two optional fields on the main context type) and the logic lives in the new modules. If the result
  still reaches 2000 lines, extract a further byte-for-byte block with its dependencies (same rules).
  The file-size ratchet test and `wc -l` are C-phase gates.
