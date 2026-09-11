# 000 — Backlog disposition program: objective, inventory, and work-phase map

Unit opened 2026-08-22 against `dev@ced9a85c5` (`origin/dev` identical at open).
Mode: HOTL goal loop, session `01a0287a-f569-7612-982a-f17c7c33d1fe`,
goalplan slug `clear-the-opencodex-open-pr-issue-backlog-by-dis`.

## Objective

Give every one of the 45 open pull requests and the 4 named PR-less priority issues an
explicit terminal disposition, and land everything accepted on `dev`. A disposition is
one of:

| Code | Meaning |
|------|---------|
| **MERGE** | squash-merge the PR head as-is after verification |
| **REBUILD** | the intent is right but the diff is not landable; re-derive it on a fresh `codex/` branch |
| **REIMPLEMENT** | no usable PR exists (issue-only, or the PR is unsalvageable); write it from the spec |
| **CLOSE** | close with a recorded reason (wrong branch, superseded, duplicate, rejected-by-evidence) |

## Scope boundary

IN: the working tree, `codex/` branches, `origin/dev`, and GitHub PR/issue state.
OUT: `main` promotion, npm publication, releases and tags, credential/auth files,
security triage written into `devlog/` (scratch space only, per AGENTS.md).

## Open pull request inventory (45, captured at unit open)

| PR | State | Base | Head | Mergeable | Review | Size | Author | Title |
|----|-------|------|------|-----------|--------|------|--------|-------|
| #2359 | ready | `dev` | d587a4b4 | MERGEABLE | REVIEW_REQUIRED | 12+/0- (2f) | chilung-cgu | fix(catalog): exclude uncallable OpenCode Go and Zen models |
| #2357 | draft | `main` | 9a5115ad | MERGEABLE | REVIEW_REQUIRED | 81+/5- (3f) | mdwsk88 | [WRONG BRANCH] Add `__omit__` reasoning-effort wire sentinel for per-e |
| #2355 | ready | `dev` | 29e8d7b2 | MERGEABLE | REVIEW_REQUIRED | 427+/4- (20f) | harryzhou2000 | feat(status): warn when config.json diverges from the running proxy (C |
| #2352 | draft | `dev` | 7b07ba60 | MERGEABLE | REVIEW_REQUIRED | 860+/59- (8f) | luvs01 | fix(native): start owned lifecycle after ownership reprobe |
| #2351 | ready | `dev` | 916fc9f2 | MERGEABLE | REVIEW_REQUIRED | 845+/75- (22f) | harryzhou2000 | feat(config): audit persisted config mutations (source, fields, redact |
| #2350 | ready | `dev` | b1b5b071 | MERGEABLE | REVIEW_REQUIRED | 287+/4- (8f) | harryzhou2000 | feat(adapters): annotate present-but-empty tool outputs (DeepSeek defa |
| #2339 | ready | `dev` | e646ad6e | MERGEABLE | REVIEW_REQUIRED | 69+/10- (2f) | luvs01 | fix(google): preserve streaming thought-signature order |
| #2335 | ready | `dev` | 29acc673 | MERGEABLE | REVIEW_REQUIRED | 184+/29- (8f) | luvs01 | perf(tools): resolve tool-choice catalogs in linear time |
| #2326 | draft | `dev` | 794abac4 | MERGEABLE | REVIEW_REQUIRED | 398+/7- (14f) | JasonSujaya | feat(gui): add frontier model shortcuts |
| #2313 | ready | `dev` | befb4df5 | MERGEABLE | REVIEW_REQUIRED | 571+/11- (8f) | olddonkey | fix(responses): scope reasoning replay by conversation and remember pr |
| #2311 | ready | `dev` | 9fbfa19b | MERGEABLE | CHANGES_REQUESTED | 3348+/59- (37f) | goodwilliam0126 | fix(grok): translate native edit tools for Codex |
| #2310 | ready | `dev` | 1acf7343 | MERGEABLE | CHANGES_REQUESTED | 940+/59- (12f) | goodwilliam0126 | fix(responses): repair apply_patch envelopes |
| #2309 | ready | `dev` | 1d5d935b | MERGEABLE | REVIEW_REQUIRED | 63+/4- (4f) | Ingwannu | fix(kiro): accept Codex parallel tool permission |
| #2304 | ready | `codex/bun14-followup-memory-docs` | 9c7f42f8 | MERGEABLE | CHANGES_REQUESTED | 147+/0- (2f) | lidge-jun | test(scripts): smol-worker A/B gate harness (verdict: FAIL, flags not  |
| #2303 | ready | `codex/bun14-mem-diagnostics` | 3ee558a2 | MERGEABLE | CHANGES_REQUESTED | 658+/0- (5f) | lidge-jun | feat(scripts): Bun.gc relief evaluation harness (SIGUSR2 GC channel, m |
| #2302 | ready | `codex/bun14-followup-memory-docs` | cac21afb | MERGEABLE | CHANGES_REQUESTED | 56+/5- (4f) | lidge-jun | feat(memory): expose JSC extraMemorySize in system memory API, watchdo |
| #2301 | ready | `dev` | 7a0fb255 | MERGEABLE | CHANGES_REQUESTED | 612+/0- (10f) | lidge-jun | devlog: Bun 1.4 follow-up memory roadmap (research + decade docs) |
| #2299 | draft | `dev` | 48326fc5 | MERGEABLE | CHANGES_REQUESTED | 860+/3- (9f) | abhisheksharma2411 | feat(catalog): operator display labels for live-discovered models |
| #2298 | draft | `dev` | 38888e3d | MERGEABLE | CHANGES_REQUESTED | 74+/0- (3f) | ppvia | fix(claude): warm empty Desktop-3P alias registry on first /v1/message |
| #2280 | ready | `dev` | b857561a | CONFLICTING | CHANGES_REQUESTED | 556+/15- (17f) | cristph | feat(catalog): allow per-model synthetic max suppression |
| #2257 | draft | `dev` | 510f1044 | MERGEABLE | CHANGES_REQUESTED | 1289+/29- (20f) | yansigit | feat(agent): named subagent role catalog |
| #2244 | draft | `dev` | 67acb331 | MERGEABLE | CHANGES_REQUESTED | 913+/0- (9f) | ZSN12 | feat(workbuddy): add experimental desktop OAuth provider |
| #2230 | draft | `dev` | 154fe3be | CONFLICTING | CHANGES_REQUESTED | 1637+/61- (33f) | ppvia | feat(oauth): add Gemini OAuth (Google account) accounts with Code Assi |
| #2222 | draft | `dev` | d54acacd | CONFLICTING | CHANGES_REQUESTED | 1390+/168- (15f) | MarcTCruz | fix(codex): refresh native main account tokens |
| #2215 | draft | `dev` | d85cf057 | MERGEABLE | CHANGES_REQUESTED | 126+/41- (8f) | parkjs101 | docs(sub-agents): describe v2 fork override rule as a prompt conventio |
| #2213 | draft | `dev` | a5afe351 | CONFLICTING | CHANGES_REQUESTED | 494+/101- (18f) | louis-tepe | feat: add Grok direct-first tool projection |
| #2123 | draft | `dev` | 701b51f9 | MERGEABLE | CHANGES_REQUESTED | 495+/32- (3f) | chilung-cgu | feat(quota): add per-account Gem/Cla quota probing for Google Antigrav |
| #2122 | draft | `dev` | fd6e53de | MERGEABLE | CHANGES_REQUESTED | 607+/41- (15f) | chilung-cgu | feat(catalog): config-level retainModels allowlist for authoritative d |
| #2113 | ready | `dev` | 3e17fe58 | MERGEABLE | CHANGES_REQUESTED | 2184+/112- (63f) | cb8010d6 | feat(providers): allow trusted encrypted V2 task passthrough |
| #2083 | draft | `dev` | 06c8d936 | MERGEABLE | APPROVED | 645+/57- (14f) | zhou-zhichao | feat(images): relay Codex image_gen to xAI Imagine with Grok OAuth |
| #2071 | draft | `dev` | e365907b | MERGEABLE | CHANGES_REQUESTED | 2789+/124- (25f) | yansigit | feat(antigravity): CCA host failover and non-retryable image POST |
| #2070 | draft | `dev` | f276d325 | MERGEABLE | CHANGES_REQUESTED | 1608+/76- (14f) | yansigit | feat(antigravity): Claude CCA wire fidelity |
| #2069 | draft | `dev` | e61e2b2e | CONFLICTING | CHANGES_REQUESTED | 1650+/41- (20f) | yansigit | feat(antigravity): process-local account cooldowns |
| #2068 | ready | `dev` | 9dceb40f | MERGEABLE | CHANGES_REQUESTED | 954+/31- (7f) | yansigit | feat(antigravity): live quota RPC and geoblock classification |
| #2050 | draft | `dev` | 52324cef | MERGEABLE | CHANGES_REQUESTED | 528+/72- (46f) | x3M3x | feat(combos): add random, least-used, and reset-window routing strateg |
| #2041 | draft | `dev` | e2460240 | CONFLICTING | REVIEW_REQUIRED | 26+/1- (3f) | yzxcj797 | feat(catalog): durable auto_review_model config override |
| #2033 | draft | `dev` | 6505a525 | MERGEABLE | REVIEW_REQUIRED | 14+/0- (2f) | louis-tepe | Expose web search sidecar enabled status |
| #1905 | ready | `dev` | 0be75f29 | MERGEABLE | CHANGES_REQUESTED | 781+/80- (27f) | luvs01 | feat(codex): add per-model ChatGPT compaction budgets |
| #1829 | ready | `dev` | bf5e67f9 | MERGEABLE | CHANGES_REQUESTED | 2878+/2- (4f) | luvs01 | feat(codex): add durable reset-credit operation ledger |
| #1794 | draft | `dev` | 179a6a31 | CONFLICTING | REVIEW_REQUIRED | 1759+/8- (50f) | riique | feat: recover routed V2 subagents and select OpenRouter endpoints |
| #1769 | draft | `dev` | f87c4acb | MERGEABLE | CHANGES_REQUESTED | 963+/36- (19f) | dbc-hbin | feat(gui): add manual paste fallback for OAuth add-account |
| #1756 | ready | `dev` | e9a04d1e | MERGEABLE | CHANGES_REQUESTED | 850+/116- (17f) | takltc | feat(grok): inject per-model reasoning effort into Grok Build config |
| #1704 | draft | `dev` | c8c4358a | CONFLICTING | REVIEW_REQUIRED | 181+/7- (16f) | lidge-jun | feat(gui): surface per-target quota state in combo workspace (#1702) |
| #1645 | draft | `dev` | 2a760080 | CONFLICTING | CHANGES_REQUESTED | 1425+/151- (68f) | waw4303 | feat(vision): add chat and Google sidecars |
| #1557 | draft | `dev` | 5586e4e0 | CONFLICTING | REVIEW_REQUIRED | 2545+/69- (28f) | LeoWang331 | feat(server): add least-privilege data-plane catalog endpoint |

## Disposition classes derived from the inventory

| Class | Count | PRs |
|-------|-------|-----|
| Ready, no changes requested, base `dev` | 8 | #2359 #2355 #2351 #2350 #2339 #2335 #2313 #2309 |
| Changes requested, mergeable | 19 | #2311 #2310 #2301 #2299 #2298 #2257 #2244 #2215 #2123 #2122 #2113 #2071 #2070 #2068 #2050 #1905 #1829 #1769 #1756 |
| Conflicting with `dev` | 10 | #2280 #2230 #2222 #2213 #2069 #2041 #1794 #1704 #1645 #1557 |
| Draft, other | 4 | #2352 #2326 #2083 #2033 |
| Wrong base | 4 | #2357 (`main`) #2304 #2303 #2302 (stack-internal bases) |

## PR-less priority issues

| Issue | Priority | Disposition | Decade doc |
|-------|----------|-------------|------------|
| #2316 Grok `wait_agent` `timeout_ms` rejected as `120000.0` | 73 | REIMPLEMENT | `030` |
| #2292 Windows model picker stale after `ocx sync --restart-codex` | 72 | REIMPLEMENT | `040` |
| #2221 native main pool does not refresh expired `auth.json` tokens | 70 | REIMPLEMENT (disposes #2222) | `050` |
| #1049 adopt pre-substrate Codex homes into the write coordinator | 73 | DEFERRED — see `060` | `060` |

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

Ordering is by build dependency, not by effort. The shared-type surface
(`src/types/tools.ts`, `src/server/responses/collaboration.ts`) is touched by both WP1
(#2335) and WP3 (#2316), so WP1 lands first and WP3 re-verifies its pre-written doc
against the landed tree at its own P. The auth surface (WP5) sits after the catalog and
tool-plumbing phases because a token-refresh regression is only diagnosable on a tree
whose routing layer is already settled.

| WP | Title | Decade doc | Depends on |
|----|-------|-----------|------------|
| wp0 | Docs-only inventory + roadmap (this cycle) | `000` | — |
| wp1 | Green-and-ready merges | `010` | wp0 |
| wp2 | Changes-requested rebuilds | `020` | wp1 |
| wp3 | #2316 wait_agent timeout_ms | `030` | wp1 (shares tool-choice surface) |
| wp4 | #2292 Windows picker | `040` | wp1 |
| wp5 | #2221 native main token refresh | `050` | wp1 |
| wp6 | #1049 pre-substrate home adoption | `060` | wp5 (auth/coordinator surface) |
| wp7 | Bun 1.4 memory stack retarget | `070` | wp1 |
| wp8 | Conflicting + remaining PR disposition | `080` | wp1–wp7 |

## Verifier reality check (PLAN-VERIFIER-REAL-01)

Commands named by the decade docs were run at unit open:

| Command | Exit | Reads the change target? |
|---------|------|--------------------------|
| `bun test tests/tool-argument-integers.test.ts` | see `001` | yes — imports `src/lib/tool-argument-integers.ts` and `src/bridge.ts` |
| `bun x tsc --noEmit` | see `001` | yes — `tsconfig` includes `src/` |
| `bun test <focused files>` per WP | recorded per phase | verified per decade doc |

Full-suite runs may execute on remote host `lidge` (`~/Developer/opencodex`, bun 1.3.14,
16 cores) when a local run would block the loop; the merge evidence records which host
produced the output.



---

# AMENDMENT (A-phase round 1) — corrections to this document

**Verifier reality table (B5).** The table above overclaimed. Corrected findings, all
re-run against the tree:

| Command | Real result | Reads target? |
|---------|-------------|---------------|
| `bun test tests/tool-argument-integers.test.ts` | 24 pass / 0 fail, exit 0 | yes |
| `bun x tsc --noEmit` | exit 0 | yes |
| `bun test tests/dispatch-sync.test.ts` | **file does not exist**; real file is `tests/cli-dispatch.test.ts` | n/a |
| `bun test <missing> <existing>` | **exits 0 while silently skipping the missing file** | dangerous |

Every phase's C step therefore prepends `test -f <path>` for each required new suite and
runs each mandatory regression as its own invocation. A combined invocation is not
accepted as evidence.

**Work-phase ordering rationale (auditor additional finding).** This document justified
running WP1 before WP3 as a shared-surface dependency on `src/types/tools.ts` /
`src/server/responses/collaboration.ts`. That is factually wrong and is withdrawn:
#2335 touches `src/adapters/anthropic.ts`, `src/adapters/command-code.ts`,
`src/adapters/google.ts`, `src/responses/parser.ts`, `src/types.ts`,
`src/types/tools.ts` — not `collaboration.ts` — and WP3 after its own amendment touches
only `src/lib/tool-argument-integers.ts`. **There is no file overlap.** WP1 still runs
first, for the plain reason that landing already-verified green work before opening new
work keeps the baseline clean and every later phase's evidence interpretable.

**Disposition coverage (B3).** The 16 changes-requested PRs that had no lane
(#2299 #2298 #2257 #2244 #2215 #2123 #2122 #2113 #2071 #2070 #2068 #2050 #1905 #1829
#1769 #1756) are dispositioned in `020`.

