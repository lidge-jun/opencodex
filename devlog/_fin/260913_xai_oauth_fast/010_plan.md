# xAI Grok OAuth fast tier (service_tier: "priority") — plan

## Loop spec (HOTL wp1)

- Tool/credential scope: local proxy management (ocx CLI, /api/providers/reload probe only, already applied), GitHub via gh/MCP for this PR only. No other accounts, no release/deploy, no service restart.
- Write scope: branch codex/xai-oauth-fast-tier in this worktree; the live ~/.opencodex config keeps the probe override (modelSupportsServiceTier for the 7 honored models) — user asked to keep working models enabled; PR + merge to dev per MAINTAINERS.md self-integration policy.
- Budget: unlimited read-only subagents on xai/grok-4.6 (user-granted); probe calls already completed.
- Wall-clock: bounded by hosted CI; if CI cannot reach a terminal state within ~90 minutes of the final push, report BUDGET_EXHAUSTED rather than DONE.
- Certification: hosted exact-head CI only. Full local suite and local typecheck NOT RUN (standing rule); focused tests below are development feedback, not certification.

## Context

xAI documents Priority Processing: `service_tier: "priority"` on /v1/responses and /v1/chat/completions, echoed in the response, billed 2x on API keys. hermes-agent#89440 verified it live on SuperGrok Heavy OAuth; there is no grok-*-fast slug. ocx's xai registry entry declares keyAuthServiceTier (API-key lane only) and deliberately leaves OAuth unclassified (src/providers/registry.ts:1367-1376), with modelWireDefaults pinning forwardCallerServiceTier:false on grok-4.6/4.5 OAuth. That classification is now stale: the live probe (020_probe-evidence.md) shows the user's own Grok OAuth account accepts and honors priority on 7 of 8 catalog models.

## Decision table

- D1 Include set: grok-4.6, grok-4.5, grok-4.3, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-build-0.1, grok-composer-2.5-fast. Exclude grok-4.20-multi-agent-0309 — upstream consistently answers service_tier "default" when sent priority (ocx log: fastOutcome downgraded, confirmation downgraded).
- D2 Registry shape: xai entry gains `modelSupportsServiceTier: {<7 ids>: true}` (OpenRouter precedent: provider stays unclassified, per-slug map, tests/service/service-tier-capability.test.ts) and `chatServiceTier: true`. No provider-wide supportsServiceTier; future/undiscovered ids stay unclassified. enrichProviderFromRegistry backfills both into saved configs at load (tests/service/service-tier-capability.test.ts:46-57), so existing installs get the lane without config edits; explicit config still wins.
- D2a (audit fold, scope honesty): `chatServiceTier: true` is provider-wide for the caller-forwarding gate (service-tier.ts:106-110 reads provider config first), so caller-sent tiers also forward verbatim on UNCLASSIFIED xai chat-wire models (future liveModels ids), not just the 7. Accepted: this matches the established unclassified-route forwarding contract pinned at tests/service/service-tier-capability.test.ts:444, `--fast` publication and proxy-owned fast injection stay capability-scoped per D2, and the probe showed the gateway accepts the field on every current model. Key-auth lane unchanged (backfilled true shadows the identical keyAuthServiceTier value).
- D3 Caller-tier parity: remove `forwardCallerServiceTier: false` from the grok-4.6/4.5 modelWireDefaults (rationale "unclassified route" is stale once D2 lands) so a caller-sent service_tier:"priority" on the OAuth responses lane forwards — the Codex fast-toggle path OpenAI native models already use. Chat-wire models forward caller tiers via the new chatServiceTier:true (fastwire.ts forwardCallerTier chain).
- D4 Echo relay: today the upstream service_tier echo reaches attempt telemetry but not the client on chat-wire paths (probe: 4.3/4.20/build/composer client bodies lack the field; 4.6/4.5 responses-wire bodies carry it). SHIPPED (b): the chat-inbound relay on every Chat Completions delivery shape — `responsesJsonToChatCompletion` (src/chat/outbound.ts:887), `collectChatCompletion` (src/chat/outbound.ts:969, 1095), `jsonCompletionSse` (src/server/chat-native-sse.ts:64-103), and the live Responses-SSE translator `responsesSseToChatCompletionsSse` (src/chat/outbound.ts:374, 541). SPLIT per the sizing rule: (a) the responses-lane assembly for chat-wire upstreams (adapter-event → bridge plumbing across the shared adapter contract) stays a follow-up in this unit; those turns keep the echo in attempt telemetry only.
- D5 Tests: registry pins in tests/providers/xai/xai-transport.test.ts; policy/backfill in tests/service/service-tier-capability.test.ts; fast-row publication/routing in tests/codex-integration/fast-row*.test.ts or tests/providers/fast-row-ingress.test.ts; relay tests beside the touched relay code.
- D6 Docs/SoT: structure/providers/xai-grok.md owns the xai provider surface — update it (structure/AGENTS.md ownership rule). docs-site configuration/providers docs only if they contradict the new lane (check at B).
- D7 Evidence: probe matrix recorded in 020_probe-evidence.md; PR Verification cites it (summarized, no secrets).
- D8 Failure semantics: no new recovery code. If upstream later rejects or downgrades priority, existing tierOutcome records fastOutcome/confirmation (downgrade path proven live by multi-agent) — documented in the PR, no silent fallback added.
- D9 (audit fold, revert residue): enrich backfill is fill-only in memory, but a config save while this change is live persists chatServiceTier:true and the 7-id map as EXPLICIT values, which then win every later merge — a revert commit cannot clear installs that saved in between. Accepted residue, recorded in the PR: the lane is upstream-verified behavior (not a hazard), the operator removal path is deleting the two keys, and the probe install (020 §4) deliberately keeps exactly this state at user request. No migration code.

Architect consultation gap: the native spawn schema in this session has no architect role (registered in cxc config but native type rejected; registration requires a Codex restart, which would abandon this session's goal). Main wrote this plan from direct source reads; the A phase uses an independent reviewer subagent (role registered, xai/grok-4.6). Recorded per delegation contract; completion claims carry this note.

## File change map

1. src/providers/registry.ts — xai entry: add modelSupportsServiceTier (7 ids), chatServiceTier: true; drop forwardCallerServiceTier:false on grok-4.6/4.5; refresh the two stale comments (keyAuthServiceTier "OAuth unclassified", modelWireDefaults caller-tier note). No multi-agent entry.
2. Relay (D4, shipped): src/chat/outbound.ts:887, 969, 1095 and src/server/chat-native-sse.ts:64-103 (chat-inbound relay on all delivery shapes). Follow-up: adapter-event → bridge plumbing for the responses lane (audit note: no adapter event/result carries service_tier today — openai-chat.ts:1778-1781, 2080-2082 observe it into attempt telemetry only; AdapterTierMetadata is telemetry per src/adapters/base.ts:118).
3. Tests (D5 files above).
4. structure/providers/xai-grok.md — lane classification + probe date.
5. devlog: this unit moves to devlog/_fin/260913_xai_oauth_fast/ in the same PR after merge evidence exists.

IN scope: the 7 models, both wires' caller-tier forwarding, echo relay, tests, xai-grok.md. OUT: multi-agent and future ids, provider-wide declarations, fastMode defaults (unchanged; operators opt in), recovery code, GUI changes, releases.

## Accept criteria (activation in parentheses)

- C1 fastPolicyForModel(xai-oauth, grok-4.6, "xai", "responses").eligibility === "eligible" (unit test constructs the xai provider with authMode oauth).
- C2 grok-4.20-multi-agent-0309 stays unclassified: capability undefined, no --fast row (unit test + catalog listing test).
- C3 caller service_tier:"priority" on the OAuth responses lane for grok-4.6 reaches the wire (policy test: before D3 the pin dropped it — activate by asserting forwardCallerTier true and decideTier output).
- C4 --fast rows publish for the 7 models on the catalog listing (catalogFastRowEligible path; test feeds an oauth xai config).
- C5 enrichProviderFromRegistry backfills chatServiceTier/modelSupportsServiceTier into a saved xai config missing them; explicit config values win (NEW capability tests — derive.ts:523 and derive.ts:552 via applyServiceTierModelDefaults:390-397 have no existing coverage for these two fields; do not lean on test:46-57). Existing pins that FLIP and must be rewritten, called out in the PR: tests/service/service-tier-capability.test.ts:108-160 and 424-445.
- C6 relay: a chat-upstream response carrying service_tier surfaces it in the chat-inbound client body on every delivery shape — tests/responses/chat-json-sse-fallback.test.ts:256-342 (JSON body, synthesized SSE, folded stream, endpoint, live SSE translator). The responses-lane half moved to the follow-up per D4.
- C7 PR template complete; hosted CI green on the exact head with no cancelled/skipped required jobs counted; merged to dev with maintainer decision recorded.

## Verifiers (run pre-plan, exit 0, reads-target noted)

- `bun test tests/providers/xai/xai-transport.test.ts` — exit 0, 47 tests; imports getProviderRegistryEntry (reads registry.ts).
- `bun test tests/service/service-tier-capability.test.ts` — exit 0, 35 tests; imports fastPolicyForModel/enrichProviderFromRegistry (reads service-tier.ts/derive.ts).
- `bun test tests/routing/fastwire-policy.test.ts` — exit 0, 236 tests; imports resolveFastPolicy (reads fastwire.ts + registry wire defaults).
- `bun test tests/providers/fast-row-ingress.test.ts` — exit 0, 9 tests; parseSyntheticRowId ingress (reads fast-row.ts).
- `bun test tests/codex-integration/fast-row.test.ts` — exit 0, 38 tests; fast-row grammar/listing.
- Hosted PR CI — certification gate (typecheck + full suite on 3 OS).

## Enforcement/bypass note (PLAN-BYPASS-NAMED-01)

This PR adds capability classification, not enforcement: it enables a wire field xAI already accepts. Bypass/residual: an operator can force supportsServiceTier for any model via config today (that is how the probe ran) — accepted, documented behavior; the registry change only makes the probed set native. Final layer: hosted CI + review on the PR. No bypass claim is made for upstream honesty: a silent upstream downgrade is observable via tierOutcome.confirmation in request logs, not prevented.
