# 260723 Issue Triage — Overnight Issue Sweep (2026-07-22 12:41Z ~ 20:39Z)

## Objective

Classify the 10 issues opened overnight (#287-#300, plus the overnight-resolved
#280) into three buckets, investigate the "act now" bucket with parallel Sol
workers, and document everything in this unit. No production code changes in
this work-phase — investigation and documentation only.

## Loop spec

- Loop archetype: spec-satisfaction (one docs/investigation work-phase, one PABCD cycle)
- Trigger: user request 2026-07-23 — overnight issue triage, 3 buckets, parallel Sol dispatch
- Goal: every overnight issue has an evidence-backed bucket + investigation doc where required
- Non-goals: fixing code, replying to/closing issues on GitHub (external mutation — needs explicit user approval), PR creation, push
- Verifier: every bucket-2 issue has a numbered investigation doc with `path:line` anchors verified against `origin/dev`; main session spot-checks each claim in C
- Stop condition: all 11 issues classified, all 6 investigation docs written and verified
- Memory artifact: this unit folder (`devlog/_plan/260723_issue_triage/`)
- Expected terminal outcomes: DONE / BLOCKED (worker failure) / NEEDS_HUMAN (classification conflict)
- Escalation: upward — main reclaims a lane after a worker fails its packet (DISPATCH-RETIRE-01)

## Issue inventory (11 issues)

| # | Title (short) | Reporter | Bucket (proposed) |
|---|---|---|---|
| 280 | Codex 통신 불가 (설정 오류) | rushidea | 1 — answer + close |
| 287 | Linux Claude auto-connect 미적용 | jhste102lab | 2 — investigate (lane 5) |
| 288 | spawn_agent 커스텀 모델 거부 | Kling0012 | 2 — investigate (lane 6) |
| 289 | Ark Agent Plan `/v1` 중복 | lijianmac | 2 — investigate (lane 4) |
| 290 | V2 custom parent empty spawn args | brunoflma | 2 — investigate (lane 6) |
| 291 | Providers 페이지 edit 버튼 | str0203 | 1 — answer + close |
| 292 | allowPrivateNetwork discovery 무시 | str0203 | 2 — investigate (lane 3) |
| 294 | Claude account pool | str0203 | 3 — long-term |
| 295 | guidance가 거부 모델 광고 | mihneaptu | 2 — investigate (lane 2) |
| 297 | catalog clamp이 max/ultra 제거 | Wibias | 2 — investigate (lane 1) |
| 300 | guidance kill switch 요청 | ildunari | 2 — investigate (lane 2, with #295) |

## Bucket rationale (grounded anchors)

### Bucket 1 — answer + close

- **#280**: reporter confirmed resolution after owner walkthrough;
  root cause was missing enabled `openai` provider, not a proxy regression.
  Action: post final confirmation answer + close. (Draft reply in 008 doc; NOT posted in this phase.)
- **#288**: DEMOTED from bucket-1 candidate after A-phase audit. OpenCodex's
  injected catalog DOES influence the spawn_agent allowlist: Codex advertises
  the first 5 featured (lowest-priority) picker-visible catalog entries to
  spawn_agent (src/config.ts:556, src/codex/catalog.ts:1091,
  MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5). Whether the reporter's custom models
  were excluded by OpenCodex featuring or by app-side filtering is unresolved →
  lane 6 must determine the enforcement boundary before any close.
- **#291**: RECLASSIFIED bucket 3 → bucket 1 after A-phase audit. The edit
  capability already exists: `ProviderSettings` form edits
  adapter/baseUrl/defaultModel/authMode/note/allowPrivateNetwork
  (gui/src/components/provider-workspace/ProviderSettings.tsx:115), saved via
  `onUpdateProvider` → `PATCH /api/providers`
  (src/server/management-api.ts:631+). Action: answer pointing at the provider
  workspace Settings tab, ask reporter to confirm, close.

### Bucket 2 — investigate now

- **#297**: `clampCatalogModelsToCodexSupport` (src/codex/catalog.ts:954) runs as
  the last sync step (catalog.ts:2205) after `ensureGpt56ReasoningLevels` /
  `ensureUltraReasoningLevel` (catalog.ts:866/885). Regression from b7ce5aad.
  Highest-confidence opencodex-side bug; contributor-reported with root cause.
- **#295 / #300**: `multiAgentGuidanceText` (src/server/responses.ts:201) claims
  schema-visible args are "hidden"; `subagentRosterText` (responses.ts:254)
  advertises catalog-resolved models the runtime allowlist may reject. #300 asks
  for a supported off switch in the same function. Same code area → one lane.
- **#292**: `allowPrivateNetwork` is honored in the data plane (router/destination
  policy) but reporter shows discovery throws. Guard lives in
  src/lib/destination-policy.ts; discovery path needs tracing.
- **#289**: key-auth branch builds `${base}/v1/responses`
  (src/adapters/openai-responses.ts:443-444), breaking versioned bases like
  `/api/plan/v3`.
- **#287**: system-env injection is darwin-only by construction
  (src/server/system-env.ts:210 and 3 sibling guards). Question: implement Linux
  support vs GUI honesty (hide/disable the toggle on Linux).
- **#290**: empty `spawn_agent` args from a custom-model parent — determine
  opencodex-side translation vs upstream (#92 family) vs model capability.

### Bucket 3 — long-term

- **#294**: Claude AUTOMATIC pool routing — corrected framing after A-phase
  audit: multi-account Claude support already exists (ProviderAuthPanel.tsx:149/192
  account list + add; management-api.ts:1567 active-account selection), but
  Anthropic requests use only the active account (src/oauth/index.ts:215). The
  real gap is quota-aware automatic routing, affinity, cooldown, failover.
  Architecture-scale → roadmap.

## Lane map (B phase — 6 Sol workers, parallel, model=gpt-5.6-sol, tier=priority, effort=high)

| Lane | Issues | Write scope (exactly one file) | Read scope |
|---|---|---|---|
| 1 | #297 | `002_investigation_297_catalog_clamp.md` | src/codex/catalog.ts, src/reasoning-effort.ts, b7ce5aad diff, tests |
| 2 | #295 #300 | `003_investigation_295_300_guidance.md` | src/server/responses.ts, src/config.ts, management-api guidance surface |
| 3 | #292 | `004_investigation_292_private_network.md` | src/lib/destination-policy.ts, discovery callers, src/router.ts, src/providers/registry.ts |
| 4 | #289 | `005_investigation_289_responses_url.md` | src/adapters/openai-responses.ts, provider config types, tests |
| 5 | #287 | `006_investigation_287_linux_autoconnect.md` | src/server/system-env.ts, GUI claude page, CLI claude launcher |
| 6 | #290 #288 | `007_investigation_290_288_spawn_agent.md` | src/server/responses.ts spawn surface, src/config.ts, src/codex/catalog.ts (featuring/priority → spawn_agent allowlist), #92 devlog history, tests/multi-agent-compat.test.ts |

Each worker: read-only on `src/`, verifies the reporter's claims against
`origin/dev` code, classifies opencodex-side vs upstream, and writes one
investigation doc with VERBATIM `path:line` anchors + a recommended fix
direction + effort estimate. Bucket reclassification proposals are returned as
judgments; the main session decides.

Additionally the main session writes:

- `001_issue_inventory.md` — full per-issue summaries + evidence (000_plan.md holds the classification table)
- `008_bucket1_draft_replies.md` — draft GitHub replies/close rationale for bucket 1 (NOT posted)

## Scope boundary

- IN: `devlog/_plan/260723_issue_triage/**` only.
- OUT: any `src/`, `tests/`, `gui/` change; GitHub comments/closes/labels; push; PR.

## Accept criteria

1. All 11 issues carry a bucket with a stated reason; bucket-1 candidates verified or demoted.
2. Docs 002-007 exist, each with >= 3 verbatim `path:line` anchors that the main session re-verified against the tree.
3. Each investigation doc ends with: verdict (opencodex-bug / upstream / feature / needs-repro), recommended direction, effort estimate.
4. No production code touched (`git diff --stat` shows only devlog).
5. Unit committed on `codex/issue-triage-260723`; no push.

---

## Amendment 2026-07-23 (cycle 2) — fix roadmap for bucket 2

Bucket-1 actions executed: replies + closes posted for #280, #288, #291, #297
(URLs recorded in 009 addendum). This cycle is the docs-first roadmap pass for
the four remaining fixable work items (#290 stays needs-repro, no fix planned).

### Work-phase map (each = one future PABCD cycle, its own branch + PR)

| WP | Issue(s) | Decade doc | Scope summary | Branch (planned) |
|---|---|---|---|---|
| 2 | #289 | `010_fix_289_responses_path.md` | optional relative `responsesPath` on provider config; absent = current behavior | `codex/fix-289-responses-path` |
| 3 | #292 | `020_fix_292_discovery_guard.md` | destination-policy parity on model discovery + content-type-aware diagnostics | `codex/fix-292-discovery-guard` |
| 4 | #287 | `030_fix_287_linux_autoconnect.md` | disable Auto-connect toggle on non-Darwin with localized explanation + server capability field | `codex/fix-287-linux-autoconnect` |
| 5 | #295 | `040_fix_295_300_guidance.md` | neutral guidance wording + runtime-consistent roster + exclusion diagnostics (bug fix only; split per A-audit) | `codex/fix-295-guidance-accuracy` |
| 6 | #300 | `041_fix_300_guidance_kill_switch.md` | `multiAgentGuidanceEnabled` kill switch + absent-key preservation in PUT /api/injection-model (dependency: none on WP5, but same handler area) | `codex/fix-300-guidance-kill-switch` |

Dependency order: all four are independent; sequence follows the routing
pipeline (adapter URL contract → discovery path → GUI/server platform surface →
guidance/config/API surface), not effort. #297 Option B (version-gated clamp)
is NOT scheduled — it is gated on reporter evidence of a parser/catalog
mismatch binary.

### This cycle's loop spec (docs-only)

- Loop archetype: spec-satisfaction; deliverable is the four decade docs at
  diff-level precision (paths, NEW/MODIFY, before/after, tests, activation
  scenarios) + 009 addendum with the posted-reply record.
- Verifier: each decade doc re-verified against the current tree (anchors
  re-read, no stale references); A-gate reviewer audits diff-level
  completeness; no production code touched.
- Non-goals: implementing any fix, opening PRs, push.
- Terminal outcomes: DONE (4 docs pass audit) / BLOCKED.

### B-phase dispatch (4 Sol workers, parallel, gpt-5.6-sol/priority/high)

Each worker reads its investigation doc (002/004/005/006/003) and writes ONE
decade doc to diff-level precision. Write scopes disjoint (one file each).
Main session integrates, writes the 009 addendum, commits.
