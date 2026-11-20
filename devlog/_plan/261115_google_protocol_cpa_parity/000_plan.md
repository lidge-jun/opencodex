# 000 — Google protocol parity with CLIProxyAPI: plan

## Objective

Bring opencodex's Google protocol support to parity with CLIProxyAPI (CPA,
`router-for-me/CLIProxyAPI`) where parity helps users, and deliver it as one branch
(`feat/google-protocol-cpa-parity`) with ordered commits and one pull request to `dev`.
"Google protocols" means the three native APIs Google ships (generateContent, the Interactions API, the
Live API; [002](002_google_docs_notes.md)) on both sides of the proxy: what clients may send to opencodex
(inbound) and what opencodex sends to AI Studio, Vertex and Antigravity (outbound).

## Baseline and dependency

- `dev` at d842c1352e has no Gemini-shaped inbound surface; outbound Google runs over raw HTTP
  generateContent, with the Cloud Code Assist envelope for Antigravity.
- PR #8742 (head d21ed22ea8, owner-accepted, pending security review) adds generateContent inbound
  and the Antigravity/agy connectors. Phases 010–030 build on it. Until it lands, the branch carries
  a merge of its head as its first commit, and the PR says so; every later commit is separable.
  Phases 040–060 do not touch #8742's files.

## Scope boundaries

In scope: the gap rows selected in [001](001_parity_matrix.md), their tests, `structure/` ownership and
docs, the English `docs-site` page and locale consistency.

Out of scope: the Live API (L-01, neither side has it), a native Interactions upstream provider
(INT-16/17), background execution, the deferred rows in 001 (each lists its reason), anything in
`src/lab/`, releases, merging, force-pushing and `ci.yml lane=all` dispatches.

## Decisions

| id | decision | why |
| --- | --- | --- |
| D1 | Interactions inbound translates onto the internal Chat Completions path through a new codec, like #8742 does for generateContent | one routing path for every provider; reuses admission, logging, refusal vocabulary and the stream pump in `native-chat-bridge.ts` |
| D2 | `previous_interaction_id` is served from a bounded, process-local, owner-scoped store of Chat history | CPA silently drops it for translated targets (A-I14), which loses the conversation; refusing it breaks the documented default flow (`store` defaults to true) |
| D3 | Requests opencodex cannot honor are 400, never silently changed: `agent`, `background:true`, hosted tools on the new Interactions surface, non-text response modalities | follows #8742's codec rule and Google's semantics |
| D4 | Interaction usage uses Google's `total_*` names in both buffered and streamed bodies | the reference names them so; CPA's buffered `input_tokens` naming is a CPA quirk |
| D5 | Google output tokens include thinking tokens on the internal usage model | every other adapter's `outputTokens` includes reasoning; telemetry already clamps reasoning to output (`src/telemetry/aggregate.ts:185`) |
| D6 | Structured `ErrorInfo.reason` outranks prose needles when classifying Google errors; prose stays as the fallback | reasons are Google's stable contract; prose changes |
| D7 | Implementation order follows the owner's priority: Interactions inbound, then outbound translation, then streaming and tool fidelity | stated by the owner |

## Phase map (dependency order)

| phase | doc | rows | depends on | class |
| --- | --- | --- | --- | --- |
| 010 | [010_phase1_interactions_inbound.md](010_phase1_interactions_inbound.md) | INT-01..12, 18, 19 | #8742 merge | C4 (new public wire surface) |
| 020 | [020_phase2_interactions_state.md](020_phase2_interactions_state.md) | INT-13, 14, 15 | 010 | C4 (new persisted-in-memory caller state, owner binding) |
| 030 | [030_phase3_gemini_inbound_fidelity.md](030_phase3_gemini_inbound_fidelity.md) | IN-09, CW-01, IN-05, IN-12, IN-03, IN-13 | #8742 merge | C3 |
| 040 | [040_phase4_google_error_classification.md](040_phase4_google_error_classification.md) | AG-X1, AG-X2, AG-X3 | — | C3 (credential pause path) |
| 050 | [050_phase5_google_response_fidelity.md](050_phase5_google_response_fidelity.md) | OUT-V38, AG-R7, OUT-V42, OUT-V40, OUT-V43 | — | C3 (usage is shared) |
| 060 | [060_phase6_google_request_fidelity.md](060_phase6_google_request_fidelity.md) | AG-M1, OUT-V04, OUT-V27, OUT-V29 | — | C2 |
| 070 | [070_phase7_docs_review_delivery.md](070_phase7_docs_review_delivery.md) | docs-site, structure, full suite, review, PR | 010–060 | C4 gate |

## Per-phase verification floor

Failing test first, deterministic (no sleeps). Then, wrapped with `/usr/bin/lockf -k /tmp/ocx-test.lock`:
the focused test files, `bun run test:changed`, `bun run typecheck`, `bun run structure:check`,
`bun run privacy:scan`. New test files are registered in `scripts/test-layout/layout*.json` and a
`tests/fixtures/test-layout-expected*.json` shard. The file-size ratchet is respected by moving code into
new files, never by raising a cap. The full `bun run test` runs once, in 070.

Ratchet facts (d842c1352e): files over 2,000 lines must be in `tests/fixtures/file-size-baseline.json`
(`scripts/file-size-ratchet.ts:5`). Near that line: `src/oauth/index.ts` 1,980, `src/server/responses/adapter-dispatch.ts`
1,970, `src/server/index/serve-options.ts` 1,957 on #8742, `src/adapters/google.ts` 1,850 — edits there stay
net zero or move code out. `src/server/index.ts` is capped at 893 (882 with #8742).

Base drift: `origin/dev` moved to 4cbe4beb00 during cycle 1 (test-layout registry files only); the branch
merges `dev` before phase 010 and resolves the registry by keeping both sides' entries.

## Outcomes

DONE: every selected row shipped with a test that failed before, all gates green on the final head, an
independent review folded, the PR open and reported. NEEDS_HUMAN: a deferred row turns out to need a
public-contract decision. BLOCKED: #8742 conflicts that cannot be resolved without the owner.

## Status (branch `feat/google-protocol-cpa-parity`)

- 000 roadmap and matrix: b662d4d788.
- 010 Interactions inbound: 9c48809348. 020 Interactions state: baa5dfbadb.
- 030 Gemini inbound fidelity on #8742: 3374a52e28 (plus 7464b83dd7, the Spanish mirror of #8742's connector docs,
  and b2738d88fe, #8742's GUI headless-parity gap).
- 040 Google error classification and TOS quarantine: c07d7cc259.
- 050 Google response fidelity: 3dccfa700f. 060 Google request fidelity: 430882ffa3 (6a, AG-M1, deferred).
- 070 user docs (`reference/proxy-formats.md` Gemini section, `reference/adapters.md`, `reference/cli/providers-accounts.md`,
  English and Spanish), review and delivery: in progress. The unit moves to `devlog/_fin/` after the PR merges.
