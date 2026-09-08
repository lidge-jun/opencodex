# 010 — Next-release landing recommendations (dev after v2.46.0)

Snapshot: 2026-09-07, `origin/dev@ece556a6e` (package 2.47.0). Latest exact-head Cross-platform CI on dev: success
(run 34091933836; Windows full suite dispatch-only by policy). No open 2.46 regression issue found; #3782 is the only
open 2.45-tagged report and predates 2.45.

Method: eight read-only astra-high explorer lanes (L1–L8 in 000_plan.md) over every open PR (59) and issue (57),
plus devlog/_plan 2609xx residuals and devlog/_fin/260907_release_246. All evidence below was gathered this session
from live GitHub/git; behind-dev counts are exact-SHA comparisons against `ece556a6e`. Dispositions are
maintainer-facing judgments, not merge approvals. Carrying any contributor PR requires `cherry-pick -x` plus a
surviving `Co-authored-by` trailer (AGENTS.md "Landing another author's work").

Ranking criteria: user impact × inverse risk class × inverse effort × contributor-credit cost of waiting.
Effort: S ≤ half day, M ≤ 2 days, L > 2 days.

## Ranked list (27 items)

| # | Source | What | Cat. | Disposition | Risk / Effort | Rationale | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | PR #3862 → #3861 (Ingwannu) | Admit reasoning-envelope allocations before materialization | bug | LAND_WITH_FIX (security sign-off + Windows-shard evidence) | C4 / M | Availability hardening, maintainer-authored, exact-head `ci: SUCCESS` (run 34098616286); 9 behind; draft. Highest-priority review. | `src/responses/reasoning-envelope.ts:70` at head `9bcb7748f`: `activeBudget.reserveTransient(8 * encryptedContent.length, …)`; #3861 "The unchanged base fails nine admission regressions" |
| 2 | PR #3858 → #3857 (makesomethingshit) | Pi/OpenCode Go session affinity through native Chat and bridges | bug | LAND_WITH_FIX (reconcile readiness contradiction, classify residual failures) | C3 / M | 0 behind, review-ready, strong header-capture tests. Body still says "Readiness remains blocked" while boxes are 4/4 — verify before merge. | `src/server/chat-completions.ts:174` (dev) `return handleNativeChatCompletions({`; PR diff `compat: { sendSessionAffinityHeaders: true }` |
| 3 | PR #3840 (chilung-cgu) | Route Responses-only Copilot GPT/Grok/MAI models correctly | bug | LAND_AS_IS (after ancestry refresh + head CI) | C2 / S | 13 behind, all 4 threads resolved, endpoint-capture tests 5 models × 3 inbound formats. | `src/providers/registry.ts:3084` at head: `"gpt-6-astra": "openai-responses",` |
| 4 | PR #3863 (x3M3x) | Dashboard settings load no longer blocks on Windows health probe | bug | LAND_WITH_FIX (keep fresh cache non-stale; handle probe rejection; controlled timing test) | C2 / S | 0 behind; mechanism substantiated; one CodeRabbit finding open. Windows user pain. | head `startup-health-cache.ts:66`: `return cached ? markStartupHealthDiagnosticStale(cached.value) : conservativeFallback(config);`; discussion_r3948034138 |
| 5 | PR #3837 (luvs01) | Gate Kiro request diagnostics behind debug check | bug | LAND_WITH_FIX (isolate `OCX_DEBUG` in test) | C1 / S | 25 behind; CHANGES_REQUESTED by Ingwannu with one concrete test fix. | pullrequestreview-5127337985 "One test correction is needed before approval."; discussion_r3945935220 |
| 6 | PR #3843 (luvs01) | Bound streaming citation-marker span | bug | LAND_WITH_FIX (same-delta malformed text must be emitted verbatim + regression) | C2 / S | 25 behind; one unresolved major finding contradicts findings-resolved box. | head `src/responses/citation-markers.ts:78`: `MAX_STREAMING_MARKER_SPAN_LENGTH = 4_096`; discussion_r3946034145 |
| 7 | PR #3845 (luvs01) | Refuse keychain restore across provider ownership | bug | LAND_AS_IS (explicit credential-security review) | C4 / S | 25 behind; small, tests cover foreign-ref rejection and own-account restore. | head `src/providers/key-store.ts:202`: `const foreign = refs.filter(ref => !keychainReferenceBelongsToProvider(ref, name));` |
| 8 | PR #3839 + #3841 (luvs01) | Bound Anthropic web-search and vision sidecar SSE/error bodies (pair) | bug | LAND_WITH_FIX (error-body cap + cancellation tests; pin partial-description behavior) | C4 / S each | Same 64 KiB policy, disjoint files; land as a pair. #3841 is draft 0/4, #3839 review-ready. | `src/web-search/anthropic-executor.ts:226` `readBoundedText(res)`; `src/vision/anthropic-describe.ts:14` `MAX_SIDECAR_RESPONSE_BYTES = 64 * 1024` |
| 9 | PR #3860 (RobinBially) | Opt-in Codex Desktop sign-in toggle in GUI | feature | LAND_AS_IS (security review; default OFF) | C4 / S | Became review-ready 4/4 during this session, 0 behind, screenshot present, replaces #3689. | PR body "an explicit opt-in, default **OFF**"; issuecomment-5567316521 |
| 10 | PR #3849 → #3781 (hualiny) | Admit Mihomo IPv6 fake-IP under TUN transparency exception | bug | LAND_WITH_FIX (IPv6-only path + `NO_PROXY` negative tests; SSRF boundary review) | C4 / S | 11 behind (over 10-commit readiness tolerance), 0/4 boxes; narrow patch; complements landed #3799. | head `src/lib/provider-outbound.ts:147`: `const allowMihomoIpv6FakeIp = (effectiveProxy !== null && !noProxyMatches(parsed))` |
| 11 | PR #3856 → #3855 (terrytan95) | Sustain quota window activation after reset | bug | LAND_WITH_FIX (maintainer sponsorship clears `unsponsored_surface`; serial with #3848) | C4 / M | 0 behind, 3/4 boxes, hygiene-blocked only by sponsorship gate; overlaps #3848 in `auth-api.ts`/`quota-auto-refresh.ts`. | dev `src/codex/quota-auto-refresh.ts:103`: `await warmCodexAccount(await getValidCodexToken(accountId));`; issuecomment-5565953215 "hygiene: unsponsored_surface" |
| 12 | PR #3838 (jpierrevd) | Lower Codex-private input items Console Go rejects | bug | LAND_WITH_FIX (parent-namespace child identity; keep nameless built-ins; two regressions) | C3 / M | 25 behind, 0/4; author reports 400→200 on 70-item replay. Complements #3858. Commit author identity generic — resolve before carry. | head `src/adapters/opencode-go.ts:83`: `const kept = (tool.tools as unknown[]).filter(child => claim(child));`; issuecomment-5564388455 |
| 13 | PR #2033 (louis-tepe) | Expose web-search sidecar enabled status in GET/PUT | bug | REIMPLEMENT (two serialization lines + regression; Co-authored-by) | C1 / S | 1364 behind but omission confirmed on dev; cheapest credit-preserving carry in the backlog. | PR #2033 (draft, gates PASS); L7 confirmed omission on `origin/dev` management routes |
| 14 | PR #3532 (Ingwannu) | Make CI completion audit fail closed (devlog docs) | hygiene | LAND_WITH_FIX (refresh onto dev; verify current gate names) | C0 / S | Non-draft, two doc files, 829 behind but docs-only. | PR #3532 head CI SUCCESS (runtime jobs skipped) |
| 15 | Issue #3817 (rrmlima) | Apply base-provider price overlays to all account log labels | bug | LAND_WITH_FIX (implement: use account→provider identity, no suffix stripping) | C2 / M | Cost-reporting correctness for pool users; bounded in `src/usage/cost.ts`. | dev `src/usage/cost.ts:193` comment on suffix/base-provider pricing boundary |
| 16 | Issue #3719 residual (lidge-jun) | Streaming reverses signed/redacted thinking order vs JSON | bug | REIMPLEMENT (ordering parity + tests incl. preceding deltas) | C4 / M | Concrete, explicitly deferred in release-246 review; separate from the larger replay/cache acceptance work (DEFER). | `devlog/_fin/260907_release_246/020_progress.md:9` "explicit deferral, not a fix"; dev `src/claude/outbound.ts:569` `closeOpenBlock();` before red loop at 575; JSON emits red first at 823 |
| 17 | release-246 follow-up | Display-name editor unknown-receipt recovery guard | bug | REIMPLEMENT (bounded recovery guard) | C2 / M | P2 label-only follow-up recorded at release; reversible. | `devlog/_fin/260907_release_246/090_delivery.md:29`; `ModelDisplayNameDialog.tsx:140` `disabled={saving}`; discussion_r3946496126 |
| 18 | release-246 follow-up | Publication-aware registry-smoke recovery in release.yml | hygiene | REIMPLEMENT (no republish; treat accepted publish + smoke timeout as recoverable) | C4 / M | Both 2.45/2.46 release runs hit the 5-minute smoke timeout; manual recovery each time. Release-surface → security review. | `.github/workflows/release.yml:355` `for attempt in $(seq 1 30); do`, `:363 sleep 10`; 090_delivery.md:27 |
| 19 | release-246 follow-ups (bundle) | Raycast unsupported-platform copy + CLI text assertions + 7 provider-locale editor sections + French integrations prose | hygiene | REIMPLEMENT (one docs/CLI PR) | C1 / S–M | All named at release close; zero runtime risk. | 090_delivery.md:29; discussion_r3946497677, r3946496225, r3946496426, r3946496024; `raycast-detect.ts:108` |
| 20 | 260907_code_mode_host_contract + #3782 docs | Append `040_delivery_record.md` for #3854; qualify Claude Desktop `/model` workaround; translate new code-mode paragraph (7 locales) | hygiene | LAND_WITH_FIX (docs only) | C0 / S | Closes the open unit and answers #3782 honestly (client-owned failure). | `devlog/_plan/260907_code_mode_host_contract/030_docs_and_delivery.md:80` and `:55`; `docs-site/src/content/docs/guides/claude-code.md:312`; #3782 issuecomment-5565317534 |
| 21 | Issue #3667 (nordz0r) | Manual price override editor/CLI over existing `modelCosts` | feature | REIMPLEMENT (expose existing store; resolve explicit-zero semantics) | C2 / M | Backend already exists; UI/CLI gap only. Pairs with #15. | dev `src/usage/user-cost-overlays.ts:240-250` `const costs = provider?.modelCosts;` |
| 22 | Issue #1533 (Zbyy0311) | Explain native-parent/routed-child V2 compatibility state in GUI | feature | REIMPLEMENT (state-aware guidance near preferred worker; no routing change) | C2 / S | Long-open UX ask, small, reads existing agent-settings API. | dev `src/server/management/agent-settings-routes.ts:248` |
| 23 | PR #3252 (x3M3x) | GUI editor for existing sub-agent fallback API | feature | LAND_WITH_FIX (repair JSON-encoded body; drop roster-switch claims; keep unavailable configured models; focused GUI tests) | C2 / M | 175 behind, hygiene-blocked by body format; overlaps #22's surface — land #22 guidance inside this panel. | PR #3252 gates FAIL (body) |
| 24 | Issue #3774 (leonclab) | Drag-and-drop `modelPickerOrder` | feature | REIMPLEMENT (on top of landed presets #3801) | C3 / M | Presets landed; DnD residual; define native/featured row behavior first. | dev `gui/src/model-picker-order.ts:56`; `gui/src/pages/Models.tsx:1823` |
| 25 | Issue #3379 usage-range slice ← PR #2956 (Manson2438) | Custom usage time ranges (slice only; not offline reports/picker) | feature | REIMPLEMENT slice with Co-authored-by | C2 / M | #2956 is 1304 behind/DIRTY; the range slice is small on current code. | dev `src/usage/summary.ts:15` `USAGE_RANGES = ["today", "7d", "30d", "all"]`; `gui/src/pages/Usage.tsx:14` |
| 26 | PR #3769 residual (ideabib) | Native compact 404 → routed compaction fallback (quota half already landed via #3791) | bug | REIMPLEMENT residual only (canonical-forward streaming test) | C4 / M | 180 behind, DIRTY, 3 unresolved threads; do not re-land the quota classifier. | discussion_r3943911361 "Add a canonical-forward streaming fallback test."; #3795 closed against v2.46.0 |
| 27 | PR #3336 (Liang-Psych) | Per-model pinned reasoning-effort overrides | feature | LAND_WITH_FIX (carry; adapt to current tests/docs) | C3 / M | 980 behind, 3/4 boxes, earlier cap/key findings fixed. Strongest older contributor carry; last in this batch because of drift. | head `src/server/chat-native.ts:165` `applyChatEffortCap(...)` |

Suggested batching: items 1–8 first (bug fixes, all S/M, mostly review-ready), then 9–13 (C4 small + carries), then
14–20 (docs/release hygiene, can run in parallel), then 21–27 (feature slices as capacity allows). Serialize #11 → #3848
(item in DEFER) on `src/codex/auth-api.ts`; serialize #2 → #12 on OpenCode Go adapter; land #22 inside #23's panel.

## Overlap pairs recorded

#3861↔#3862; #3857↔#3858; #3855↔#3856; #3846↔#3848 (both touch `auth-api.ts`, `quota-auto-refresh.ts`);
#3781↔#3849; #3459↔#3463; #2894↔#2921↔#3741; #3376↔#2881↔#3856; #3375↔#2562↔#3283↔#3738; #3377↔#3282;
#3379↔#2956; #1533↔#3252; #3667↔#3817↔#3666; #3630↔#3729; #2279↔#2280↔#3336; #3839↔#3841 (pair);
#3858↔#3838 (OpenCode Go); #3840↔#2805↔#3838 (registry); #3765↔#3433↔#3719 (cache/replay).

## DEFER (needs evidence, sponsorship, or a dedicated train — not for this release)

Issues awaiting reporter/field evidence: #3807 (raw synthetic repro), #3782 (client-owned; docs only in #20), #3775
(gateway capability), #3765/#3433 (matched cache identity evidence), #3657 (transport boundary), #3644 (categorized
TUN/system-proxy A/B), #3522 (same-process ACL evidence), #3661 (encrypted multipart contract), #3320/#3245 (needs-info).
PRs needing security review or coordination: #3848 (61 files, LAND_WITH_FIX after #3856 and sponsorship), #3742 (Cursor
pool kernel, stale verification SHA), #3748 (telemetry ledger, 221 behind), #3833 (Command Code credential refs),
#3463, #3389, #3652, #3635 (REIMPLEMENT later), #2921, #2280, #2366, #2362, #2355, #2213, #2230, #1645, #3741, #3738,
#3709, #3663, #3639, #3451, #3350/#3349/#3340 (provider train), #3282, #3080, #2562, #2956 (beyond the #25 slice).
Issues DEFER: #3666, #3630, #2279, #1711, #3777, #3859, #3573, #3266, #3729, #3417, #3459, #2894, #3761, #3506.
devlog residuals DEFER: #3719 replay/cache acceptance, #3348-B cooldown persistence, #3383 Windows temp proposal,
split-train 840/850 evidence, image roundtrip remote/OCR, macOS client-connect stall instrumentation.

## NOT_NOW (explicit)

#3810 (Go runtime line; AGENTS.md "New work does not go here"), #2805 (1488 behind, CONFLICTING → REIMPLEMENT as scoped
carries later), #3458, #3025, #3010, #2881, #2527, #2462, #2351, #2244, #3283, #3648; issues #3705, #3494, #3377,
#3376, #3375, #3255, #3191, #2834, #2811, #2730, #2511, #2495, #2455, #2358, #1811, #1782, #1416, #1213, #95, #3464,
#3675, #3506; devlog: #3348-C/quota cooldown/raw-key signature, split-train modularization debt, apply-patch envelope
quotation tradeoff, Windows full-suite gate restoration (#1059 closed policy).

## Verification (main session, live)

Anchor spot-check on `origin/dev@ece556a6e` via `git show origin/dev:<file> | sed -n <line>p`:

| Anchor | Result |
|---|---|
| `src/server/chat-completions.ts:174` | match: `return handleNativeChatCompletions({` |
| `src/codex/quota-auto-refresh.ts:103` | match: `await warmCodexAccount(await getValidCodexToken(accountId));` |
| `src/usage/summary.ts:15` | match: `USAGE_RANGES = ["today", "7d", "30d", "all"]` |
| `src/web-search/index.ts:223` | match: `if (!parsed._webSearch || isPassthrough) return undefined;` |
| `.github/workflows/release.yml:355` | match: `for attempt in $(seq 1 30); do` |
| `src/claude/outbound.ts:569` | match: `closeOpenBlock();` |
| `src/server/request-decompress.ts:22` | match: `MAX_DECOMPRESSED_BODY_BYTES = 256 * 1024 * 1024` |
| `src/usage/cost.ts:193` | near: line is the comment block the lane paraphrased |
| `src/responses/citation-markers.ts:78`, `src/server/relay.ts:462` | PR-head anchors (#3843, #3652), not dev; dev line differs as expected |

GitHub state re-read: #3860 draft=false labels enhancement,review-ready head 0f21769f3; #3837 reviewDecision
CHANGES_REQUESTED head d5d711a7b; #3858 draft=false review-ready head 23d869350; #3862 draft=true head 9bcb7748f;
#3856 labels bug, intake: hygiene-blocked; #2033 draft, title "Expose web search sidecar enabled status".

`bun run privacy:scan` on the report commit: see 000_plan.md acceptance; result recorded in the D attest.

## Appendix A — open PR inventory (59) with lane and disposition

| PR | Lane | Disposition |
|---|---|---|
| 3863 | L2 | LAND_WITH_FIX (#4) |
| 3862 | L2 | LAND_WITH_FIX (#1) |
| 3860 | L2 | LAND_AS_IS (#9) |
| 3858 | L1 | LAND_WITH_FIX (#2) |
| 3856 | L2 | LAND_WITH_FIX (#11) |
| 3849 | L2 | LAND_WITH_FIX (#10) |
| 3848 | L2 | DEFER (after #3856; sponsorship) |
| 3845 | L1 | LAND_AS_IS (#7) |
| 3843 | L1 | LAND_WITH_FIX (#6) |
| 3841 | L2 | LAND_WITH_FIX (#8) |
| 3840 | L1 | LAND_AS_IS (#3) |
| 3839 | L1 | LAND_WITH_FIX (#8) |
| 3838 | L2 | LAND_WITH_FIX (#12) |
| 3837 | L1 | LAND_WITH_FIX (#5) |
| 3833 | L4/L7 | DEFER (credential refs review) |
| 3810 | L4/L7 | NOT_NOW |
| 3769 | L2 | REIMPLEMENT residual (#26) |
| 3748 | L1 | DEFER |
| 3742 | L1 | DEFER |
| 3741 | L7 | DEFER |
| 3738 | L7 | DEFER |
| 3709 | L7 | DEFER |
| 3663 | L7 | DEFER |
| 3652 | L4 | DEFER |
| 3648 | L7 | NOT_NOW |
| 3639 | L7 | DEFER |
| 3635 | L4 | REIMPLEMENT later (DEFER) |
| 3532 | L7 | LAND_WITH_FIX (#14) |
| 3463 | L4/L7 | DEFER |
| 3458 | L7 | NOT_NOW |
| 3451 | L7 | DEFER |
| 3389 | L4 | DEFER |
| 3350 | L7 | DEFER |
| 3349 | L7 | DEFER |
| 3340 | L7 | DEFER |
| 3336 | L4 | LAND_WITH_FIX (#27) |
| 3283 | L7 | NOT_NOW |
| 3282 | L7 | DEFER |
| 3252 | L7 | LAND_WITH_FIX (#23) |
| 3080 | L7 | DEFER |
| 3025 | L7 | NOT_NOW |
| 3010 | L7 | NOT_NOW |
| 2956 | L5/L7 | DEFER (slice via #25) |
| 2921 | L4/L7 | DEFER |
| 2881 | L7 | NOT_NOW |
| 2805 | L1 | NOT_NOW (REIMPLEMENT as carries later) |
| 2562 | L7 | DEFER |
| 2527 | L7 | NOT_NOW |
| 2462 | L7 | NOT_NOW |
| 2366 | L7 | DEFER |
| 2362 | L7 | DEFER |
| 2355 | L7 | DEFER |
| 2351 | L7 | NOT_NOW |
| 2280 | L4 | DEFER |
| 2244 | L7 | NOT_NOW |
| 2230 | L7 | DEFER |
| 2213 | L7 | DEFER |
| 2033 | L7 | REIMPLEMENT (#13) |
| 1645 | L7 | DEFER |

## Appendix B — open issue inventory (57) with lane and disposition

| Issue | Lane | Disposition |
|---|---|---|
| 3861 | L3 | via PR #3862 (#1) |
| 3859 | L4 | DEFER |
| 3857 | L3 | via PR #3858 (#2) |
| 3855 | L3 | via PR #3856 (#11) |
| 3846 | L3 | via PR #3848 (DEFER) |
| 3817 | L4 | LAND_WITH_FIX (#15) |
| 3807 | L3/L5 | DEFER (repro) |
| 3782 | L3/L6 | DEFER; docs in #20 |
| 3781 | L3 | via PR #3849 (#10) |
| 3777 | L4/L8 | DEFER |
| 3775 | L3/L5 | DEFER |
| 3774 | L4/L8 | REIMPLEMENT (#24) |
| 3765 | L3 | DEFER |
| 3761 | L3/L5 | DEFER |
| 3729 | L4 | DEFER |
| 3719 | L3/L5 | REIMPLEMENT ordering (#16); rest DEFER |
| 3705 | L8 | NOT_NOW |
| 3675 | L3 | NOT_NOW |
| 3667 | L4/L8 | REIMPLEMENT (#21) |
| 3666 | L4/L8 | DEFER |
| 3661 | L3 | DEFER |
| 3657 | L3 | DEFER |
| 3644 | L3/L5 | DEFER |
| 3630 | L4 | DEFER |
| 3573 | L4 | DEFER |
| 3522 | L3/L5 | DEFER |
| 3506 | L3/L5 | DEFER |
| 3494 | L8 | NOT_NOW |
| 3464 | L3 | NOT_NOW |
| 3459 | L4/L8 | DEFER (via #3463) |
| 3433 | L3/L5 | DEFER |
| 3417 | L4/L8 | NOT_NOW |
| 3379 | L8 | REIMPLEMENT slice (#25) |
| 3377 | L8 | NOT_NOW |
| 3376 | L8 | NOT_NOW |
| 3375 | L8 | NOT_NOW |
| 3320 | L5/L8 | NOT_NOW (needs-info) |
| 3266 | L4 | DEFER |
| 3255 | L8 | NOT_NOW (needs-info) |
| 3245 | L5/L8 | NOT_NOW (needs-info) |
| 3191 | L8 | NOT_NOW |
| 2894 | L4/L8 | DEFER |
| 2834 | L8 | NOT_NOW |
| 2811 | L8 | NOT_NOW |
| 2730 | L8 | NOT_NOW |
| 2511 | L8 | NOT_NOW |
| 2495 | L8 | NOT_NOW |
| 2455 | L8 | NOT_NOW |
| 2358 | L8 | NOT_NOW |
| 2279 | L4 | DEFER |
| 1811 | L8 | NOT_NOW (needs-info) |
| 1782 | L8 | NOT_NOW (needs-info) |
| 1711 | L4/L8 | DEFER |
| 1533 | L8 | REIMPLEMENT (#22) |
| 1416 | L8 | NOT_NOW |
| 1213 | L8 | NOT_NOW |
| 95 | L8 | NOT_NOW (roadmap) |

