# Lane E — enhancement issues and stale/large PRs

**Scope:** 31 enhancement issues + 25 stale/large PRs, triaged READ-ONLY for CLOSE candidates and DEFER confirmation.
**Research worktree:** `/tmp/ocx-249.xGQnxl/wt`, detached at `7dc7dc99e65268bc8764e19840952256b030bce9` = `origin/dev` (verified at report time; `git status --porcelain` empty, index untouched).
**Remote:** `https://github.com/lidge-jun/opencodex.git`.
**Date:** 2026-09-09. All PR head SHAs and check states captured this session.

## Headline

Only **4 CLOSE** candidates exist in this lane, and none of them is the "already shipped on dev" case the brief hoped for. I searched dev for every capability claimed by the 31 issues; **not one enhancement issue is fully implemented on dev**. The two partial-landing issues (#3379, #3774) were already correctly annotated as partial by the maintainer and explicitly kept open. The realistic closes are two duplicate/superseded issues, one issue whose own reporter's corrected measurements withdraw the premise, and one abandoned PR.

The two lidge-jun PRs **#3915 / #3914 are the best merge candidates in the entire lane**: both are green at head (25 pass / 2 skipping, no failures) and their CONFLICTING status is **only** the two test-layout registry files. That is a mechanical regeneration, not a rebase.

**Sponsor-mechanism warning:** #3914 and #3915 each contain the *same* sponsor mechanism commit. They are not independent. Landing one requires rebasing the other onto the post-merge dev or the second will conflict across ~20 shared files.

## Summary table

| item | verdict | one-line reason | head SHA | CI at head | conflicts |
| --- | --- | --- | --- | --- | --- |
| PR #3915 | LAND_WITH_FIX | Sponsor mechanism + PackyCode preset, fully green; conflict is only the 2 test-layout registry files | `95253b8f0b355b7e4d42190f89782e70d980ead9` | 25 pass / 2 skipping, 0 fail | `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` only |
| PR #3914 | LAND_WITH_FIX | Same sponsor mechanism + OrcaRouter placement, fully green; identical 2-file conflict | `713ce6b028b07b9570c96d49f7e7d06144c255b5` | 25 pass / 2 skipping, 0 fail | same 2 files; **plus overlaps #3915 on ~20 files — serialize** |
| PR #2805 | CLOSE | Abandoned 12 days, 1724 commits behind, 3196/-3060 refactor of a registry that has since been rewritten | `2e1a0a9d6b7314f24e6e48e898f113c9d8a7b81b` | 29 pass / 1 skipping | DIRTY; unrebasable in practice |
| PR #3389 | DEFER | Mid-stream socket-reset refetch is green and small but changes retry semantics on a shared error path | `12501543a10b751f72c3cbebdcc6ba6ac4edf1c8` | 5 pass (contributor subset only) | MERGEABLE, 1198 behind |
| PR #3833 | DEFER | Command Code client integration; green subset but adds a new client surface needing product direction | `6605ed19cebc66960c57cb5e4ed95dc7aeede479` | 5 pass (subset) | MERGEABLE, 261 behind |
| PR #3463 | DEFER | Pre-adapter transform hook (#3459) is a new public extension contract | `3e0439cfe618fa0713806e7ff20b0ae03b0d4900` | 3 pass / 2 fail (enforce-target, hygiene) | MERGEABLE, 222 behind |
| PR #3639 | DEFER | EntraID auth for Azure Foundry — security-boundary review required per MAINTAINERS.md | `6a9fde4ecf0ef9815ad91c7ce0c1e898060958f4` | 3 pass / 2 fail | MERGEABLE, 985 behind |
| PR #3709 | DEFER | Priority failback for ongoing tasks; small but product-policy on account routing | `81787552ae09613d1d3a69d2737abece57fc6a7b` | 3 pass / 2 fail | MERGEABLE, 704 behind |
| PR #3952 | DEFER | openai-chat freeform tool compat + Moonshot Responses; freshest contributor PR (86 behind) but adapter-semantics judgment | `210e311d70d19031bd21225679cbe96c16aeced1` | 5 pass (subset) | MERGEABLE, 86 behind |
| PR #4020 | DEFER | Per-account auto-switch thresholds, 56 files, overlaps luvs01 train on `src/codex/auth-context.ts` | `fece6ddda9ab47da0ae1d2ff26c48e47c9d4e553` | 3 pass / 2 fail | MERGEABLE, 22 behind; **luvs01 overlap** |
| PR #4022 | DEFER | Guardrails, +35574/-340; reviewer already asked for a 4-part split stack | `e54048a11ef3cf97e37a4138ddb05d1ed3dfd73e` | 3 pass / 2 fail | MERGEABLE, 22 behind |
| PR #3810 | DEFER | Go runtime line +69403 across 100 files; contradicts the Bun-native branch policy in AGENTS.md | `d61d16ea7a2042940751acd7f8eb7353f9f7a72f` | 3 pass / 2 fail | DIRTY, 1131 behind |
| PR #3458 | DEFER | Hub-mediated remote workspaces, +15547 / 99 files — largest feature surface in the lane | `ba6f822cae53fcc4c91575a4c78f86f9944b6644` | 29 pass / 1 skipping | DIRTY, 1105 behind |
| PR #3025 | DEFER | Dashboard UI + batch testing + launcher, +3461 / 27 commits, stale since 2026-08-31 | `7d392541d11017e261227f32b8cf51ac020db5e1` | 3 pass / 2 fail | DIRTY, 1499 behind |
| PR #2562 | DEFER | Google quota-aware pool +4031/46 files; superseded in direction by #3283 | `4bab2fbbc8830bf18c28e04132d434314c09566d` | 21 pass / 2 fail | DIRTY, 1933 behind |
| PR #2881 | DEFER | Reset-window account routing, 51 files; belongs to the #3376 design that is still unsettled | `9487879e7766f567905be11853d37433a26ebd9e` | 3 pass / 2 fail | DIRTY, 1274 behind |
| PR #2921 | DEFER | Real SOCKS5 transport; CHANGES_REQUESTED and blocked on upstream oven-sh/bun#40461 | `54e315b8217333b63d91ffdeb5d305d4cab88abf` | 5 pass (subset) | DIRTY, 1211 behind |
| PR #3080 | DEFER | Persistent origin-scoped dashboard sessions — auth/session security boundary, CHANGES_REQUESTED | `3e8b06e26de259a956ffbae35f21944b2d43723d` | 3 pass / 2 fail | DIRTY, 1466 behind |
| PR #3282 | DEFER | GitHub Copilot context tier across 39 files; needs the #3377 capability model first | `351d8ce04c14620f77c4276a82a86db998da389e` | 3 pass / 2 fail | DIRTY, 1121 behind |
| PR #3283 | DEFER | Antigravity pool routing + Gemini 3.8 Flash; CHANGES_REQUESTED, overlaps #2562 | `34b1f4a4af85626a29dce9a20dd722db5b1989c8` | 3 pass / 2 fail | DIRTY, 1050 behind |
| PR #3652 | DEFER | Opt-in drop of Codex safety-buffering hints — changes streaming behavior, needs product call | `13fb263778e9036e66ae86d41e29f9f47bbbed92` | 5 pass (subset) | DIRTY, 954 behind |
| PR #3663 | DEFER | Relay experimental context history/notes, 19 files; overlaps luvs01 train on `src/codex/inject.ts` | `8e0b53b0f96ae840c0ce836c043174aac98816a2` | 5 pass (subset) | DIRTY, 831 behind; **luvs01 overlap** |
| PR #3738 | DEFER | Quota-aware switching + resumable pool waits, +2505; same unsettled #3376 design | `4e7ea19036e1ce52f5f54b18b38c5b35a3703e3e` | 3 pass / 2 fail | DIRTY, 502 behind; **luvs01 overlap** |
| PR #3741 | DEFER | Opt-in Antigravity TLS profile — transport fingerprinting needs a maintainer position | `0d38947ed2a46cd59c4cf1f8b582fa4250cbe56a` | 3 pass / 2 fail | DIRTY, 499 behind |
| PR #3901 | DEFER | Per-provider HTTP proxy overrides; sits on the same config surface as #2921 SOCKS5 | `7fd3a1c899708dd449b3f55ba518270f9c9c7749` | 3 pass / 2 fail | DIRTY, 173 behind |
| Issue #3266 | CLOSE | Reporter's own twice-corrected data shows 19 stalls in 134,716 attempts (0.141/1000) and failover already rescued them | — | — | — |
| Issue #4001 | CLOSE | Tier-2 Cockpit import: the 1st-party ask already closed via #3998/#3999, and file import already exists on dev | — | — | — |
| Issue #3255 | CLOSE | Reporter conceded it is not a bug and the axes are already separate at `src/codex/catalog/effort.ts` | — | — | — |
| Issue #2495 | DEFER | Tracking item for plaintext V2 rewrite; implementation PR #2496 closed, design rides on undocumented upstream behavior. |
| Issue #2511 | DEFER | Refusal half landed via #3196; downscale-then-prune mutates request content and needs a product call. |
| Issue #2730 | DEFER | `/v1/alpha/search` ChatGPT-forward-only gate is real and intentional; decoupling is a product decision. |
| Issue #2811 | DEFER | Provenance-aware Codex CLI update manager is a new workflow surface, not a defect. |
| Issue #2834 | DEFER | Relay model diagnostics — new diagnostic surface, lowest priority score in lane (36/80). |
| Issue #2894 | DEFER | SOCKS5 support blocked on upstream oven-sh/bun#40461, still unmerged. |
| Issue #3191 | DEFER | Muse Code subscription routing; reporter agreed to hold as `needs-design`. |
| Issue #3375 | DEFER | OAuth pool lifecycle umbrella — large multi-part design, actively referenced. |
| Issue #3376 | DEFER | Quota history as scheduling input; blocks #2881/#3738 and needs the storage design settled first. |
| Issue #3377 | DEFER | Per-model capability declarations — foundational catalog model, prerequisite for #3282. |
| Issue #3379 | DEFER | Two of three slices landed (#3477, #3905); account-selector rename remains, correctly kept open. |
| Issue #3417 | DEFER | Native main login profiles in WebUI — agreed phase 2 of #863, not yet scheduled. |
| Issue #3459 | DEFER | Pre-adapter hook is a public extension contract; implementation PR #3463 is open. |
| Issue #3494 | DEFER | VS Code agent integration needs an extension lifecycle owner that does not exist yet. |
| Issue #3573 | DEFER | 256 MiB inbound cap is real at `request-decompress.ts:22`, but the remedy is a product choice. |
| Issue #3630 | DEFER | Periodic catalog auto-refresh — no `catalogRefreshInterval` on dev; needs scheduling design. |
| Issue #3666 | DEFER | Free-model filter is cross-layer (pricing must reach `CatalogModel`); contributor Sfrui claimed it. |
| Issue #3705 | DEFER | Guardrails RFC; reviewer requested a split stack and #4022 stays a reference draft. |
| Issue #3729 | DEFER | Remote catalog pull into local Codex state; phase-1 contract still being negotiated. |
| Issue #3774 | DEFER | Drag-and-drop landed via #3887; native/featured row reordering remains, correctly kept open. |
| Issue #3777 | DEFER | Anthropic subscription tier exposure needs an upstream field that may not be available. |
| Issue #3859 | DEFER | Email-mask toggle is a privacy-policy decision against `src/lib/privacy.ts:1`. |
| Issue #3894 | DEFER | Import cycle is real at `router.ts:13` ↔ `api-key-selection.ts:6`; PR #3897 open, defer to that PR. |
| Issue #3898 | DEFER | Headless-hub native-main reauth is a real product gap (62/80) but needs deviceauth scope design. |
| Issue #3958 | DEFER | 900k synthetic context aliases — catalog-alias policy call, lowest priority (32/80). |
| Issue #3978 | DEFER | Client compaction opt-in without disabling V2; PR #3987 open, defer to that PR. |
| Issue #4024 | DEFER | OpenRouter key rotation + free-tier failover; bounded-cost design not settled. |
| Issue #4038 | DEFER | Decode tok/s in Logs; PR #4040 open and mergeable, defer to that PR. |

---

## PR #3915 — feat(sponsors): PackyCode preset, placement and overview links — LAND_WITH_FIX

**URL:** https://github.com/lidge-jun/opencodex/pull/3915
**Head SHA:** `95253b8f0b355b7e4d42190f89782e70d980ead9` (committed 2026-09-07T16:21:16Z)
**Base:** `dev` · **Author:** lidge-jun · ready (not draft) · +505/-20 across 36 files
**Merge base with dev:** `17d2a1715dab44e1f9a24d27c534f44279ab93c4` — 116 commits behind, 7 ahead.

### CI at head — fully green

`gh pr checks 3915` returns **25 pass, 2 skipping, 0 fail**. Passing includes `ci`, `gates`, `hygiene`, `enforce-target`, `storage policy`, `api usage`, `react-doctor`, `docker smoke`, `test 1/4` through `test 4/4`, `npm-global` on all three OSes, and `keyring` on macos/ubuntu/windows. The two skipping are `macos control` and `windows ${{ matrix.shard }}/6`.

This is the only PR in the lane with `hygiene` and `enforce-target` **passing** — every contributor draft in this lane fails exactly those two because they are the draft-readiness gates.

### Conflict scope — 2 files, both generated registries

`git merge-tree origin/dev refs/laneE/p3915` reports exactly two conflicts:

```
CONFLICT (content): Merge conflict in scripts/test-layout/layout.json
CONFLICT (content): Merge conflict in tests/fixtures/test-layout-expected.json
```

Everything else auto-merges, including all nine i18n files, `README.md`, `docs-site/src/content/docs/guides/providers.md`, `gui/src/provider-icons.ts`, `src/providers/registry.ts`, and `tests/providers/provider-registry-parity.test.ts`.

The conflict is not semantic. The diff against dev shows the branch reordering existing keys and dropping entries that dev has since added — `aside-profile-identity.test.ts`, `cli-models-price.test.ts`, `codebuddy-adapter.test.ts`, `codebuddy-protocol.test.ts`. Those are the fixture-train additions that landed on dev after this branch forked (`769e4208f test(providers): place CodeBuddy tests in their layout domain`).

### Bounded fix

Rebase onto current dev, then take dev's version of both registry files wholesale and re-add only this branch's own entry (`tests/providers/sponsor-presets.test.ts` → `providers`) plus, for #3915 only, `tests/providers/provider-registry-parity.test.ts` if it is new. Both files are enforced by `tests/test-layout.test.ts` and `tests/test-layout-tooling.test.ts`, which name the missing entry on failure, so the fix is self-verifying.

### Verbatim anchors — the feature does not exist on dev

```
$ rg -ni "packycode" /tmp/ocx-249.xGQnxl/wt/src /tmp/ocx-249.xGQnxl/wt/gui/src /tmp/ocx-249.xGQnxl/wt/README.md
(no matches)

$ rg -n "sponsor" /tmp/ocx-249.xGQnxl/wt/src/providers/registry.ts
(no matches)

$ rg -rn "Sponsor" /tmp/ocx-249.xGQnxl/wt/gui/src -l
(no matches)

$ ls /tmp/ocx-249.xGQnxl/wt/assets/sponsors
(directory does not exist)
```

The README sponsor slots exist but are empty placeholders:

- `README.md:107` — `<!-- sponsors:main — one banner, model developers only; empty until a Main sponsor signs -->`
- `README.md:109` — `<!-- sponsors:standard — one row per sponsor, in order of signing. Uncomment the table with the first row:`

So this PR fills a slot the repository already reserved.

---

## PR #3914 — feat(sponsors): OrcaRouter placement, overview introduction and links — LAND_WITH_FIX

**URL:** https://github.com/lidge-jun/opencodex/pull/3914
**Head SHA:** `713ce6b028b07b9570c96d49f7e7d06144c255b5` (committed 2026-09-07T16:18:58Z)
**Base:** `dev` · **Author:** lidge-jun · ready · +470/-19 across 33 files
**Merge base:** `17d2a1715dab44e1f9a24d27c534f44279ab93c4` — 116 behind, 6 ahead.

### CI at head — fully green

`gh pr checks 3914`: **25 pass, 2 skipping, 0 fail** — identical check set to #3915.

### Conflict scope — identical 2 files

```
CONFLICT (content): Merge conflict in scripts/test-layout/layout.json
CONFLICT (content): Merge conflict in tests/fixtures/test-layout-expected.json
```

### The coupling that matters

Both PR bodies state the mechanism is shared. #3915: *"It shares the sponsor mechanism with #3914 and adds the preset itself, since PackyCode had no registry entry."* #3914: *"Mechanism (shared with the PackyCode branch)."*

They both touch, among others, `src/providers/registry.ts`, `src/providers/derive.ts`, `src/cli/provider-runtime.ts`, `gui/src/components/provider-catalog/ProviderCatalog.tsx`, `gui/src/components/provider-catalog/provider-presets.ts`, `gui/src/components/provider-workspace/ProviderSponsor.tsx` (new in both), `gui/src/components/provider-workspace/ProviderOverview.tsx`, `gui/src/components/provider-workspace/ProviderDetails.tsx`, `gui/src/pages/Providers.tsx`, `gui/src/styles/provider-workspace-shell.css`, all nine i18n files, `README.md`, `docs-site/src/content/docs/guides/providers.md`, `structure/05_gui-and-management-api.md`, `devlog/_plan/260908_sponsor_overview/010_overview.md`, and `tests/providers/sponsor-presets.test.ts`.

**Order:** land #3914 (OrcaRouter — the *first* Standard sponsor per its body, agreement completed 2026-09-07) first, then rebase #3915 onto the result. #3915 adds a genuinely new registry preset on top of the shared mechanism, so it is the natural second. Landing them in parallel will conflict.

Note `gui/src/provider-icons.ts` is in #3915's file list but not #3914's, consistent with OrcaRouter already having icon entries on dev:

- `gui/src/provider-icons.ts:70` — `orcarouter: "orcarouter.svg",`
- `gui/src/provider-icons.ts:133` — `orcarouter: "OrcaRouter - API",`
- `gui/src/i18n/en.ts:76` — `"provider.name.orcaRouterApi": "OrcaRouter - API",`

---

## PR #2805 — refactor: tighten type boundaries and split provider registry — CLOSE

**URL:** https://github.com/lidge-jun/opencodex/pull/2805
**Head SHA:** `2e1a0a9d6b7314f24e6e48e898f113c9d8a7b81b` (committed 2026-08-28T03:06:17Z — **12 days stale**)
**Author:** Ingwannu · ready · +3196/-3060 across 23 files · `CONFLICTING` / `DIRTY`
**Position:** 1724 commits behind dev, 2 ahead.

### Why CLOSE

This is a pure refactor with no user-visible behavior change, sitting 1724 commits behind, that rewrites `src/providers/registry.ts` — a file that has been continuously modified since. The lane data shows five other open PRs (#2805, #3639, #3914, #3915, #3952) all touching `src/providers/registry.ts`, and dev has landed multiple provider additions since this branch forked (`615c5c62c feat(provider): add Qoder CN PAT provider`, `124c57b1f feat(provider): add Qoder Global PAT provider`, CodeBuddy).

A 3196-line refactor against a 1724-commit-old base cannot be rebased; it must be rewritten. Its CI (29 pass / 1 skipping) is green but measured against a base from 2026-08-28 and proves nothing about current dev.

It also overlaps the luvs01 fixture train on `structure/01_runtime.md`.

### Closing comment to post

> Closing this as unrebasable rather than unwanted.
>
> The head commit `2e1a0a9d6b7314f24e6e48e898f113c9d8a7b81b` is now 1724 commits behind `dev`, and this is a 3196-line refactor of `src/providers/registry.ts` — a file that has changed repeatedly since the branch forked, including the Qoder Global (`124c57b1f`), Qoder CN (`615c5c62c`) and CodeBuddy provider additions. The green CI on this head was measured against a late-August base and does not describe current `dev`.
>
> A behavior-preserving refactor of that size cannot be carried forward by rebase; it would have to be re-derived against the current registry, at which point it is a new change rather than this one.
>
> The underlying goal — tighter type boundaries and a split provider registry — is still welcome. If you would like to pursue it, please open a fresh PR against current `dev` and scope it to one seam at a time so each piece can be reviewed and landed before the next drifts. Thank you for the work that went into this.

---

## Issue #3266 — per-combo attempt first-byte deadline — CLOSE

**URL:** https://github.com/lidge-jun/opencodex/issues/3266 · Author: Veritas-7 · labels `enhancement`, `proxy`

### Why CLOSE — the reporter's own corrected data withdraws the premise

The reporter posted measurements, then **corrected them twice**. The final comment (2026-09-05T10:52:19Z, "Second correction") reports, on a 134,716-attempt sample:

> "The file-order prefix of the first 134,716 attempts — the same sample size as the original post — yields 19 timeout-shaped stalls."

and, in the correction table:

> "| Timeout-shaped stalls | 23 attempts (0.17 per 1000); 4 of 6 days | 19 (status 502 = 18, status 504 = 1); 0.141 per 1000; 3 of 6 days | all attempts |"

The original 23-count is explicitly disowned:

> "the 23-count is 20 successful (status 200) attempts and 3 with status 502, and 19 of the 23 recorded a first byte — 14 of them under 60 seconds, the earliest at 1,178 ms — so that set is not 'timeout-shaped stalls' under any reading."

And existing failover already handles the residue:

> "What does line up is the rescue count: both the 28 band and the tight window contain exactly 5 attempts whose parent request still ended 200, matching the 'failover rescued 5' I published."

So: 0.141 stalls per 1000 attempts, and the existing combo failover already rescued the affected requests. The proposed `attemptFirstByteTimeoutMs` / `requestBudgetMs` do not exist on dev (`rg -n "attemptFirstByteTimeoutMs|requestBudgetMs" /tmp/ocx-249.xGQnxl/wt/src` → no matches), and adding a second timeout axis to the combo path is not justified by a 0.014% event that failover already covers.

Dev's existing timeout vocabulary is deliberate about this distinction:

- `src/types/config.ts:672` — `connectTimeoutMs?: number;`
- `src/types/config.ts:1058` — `* request budget — deliberately NOT connectTimeoutMs, which is a header-arrival budget.`

### Closing comment to post

> Closing on the strength of your own corrected measurements — and thank you for correcting them publicly twice rather than letting the first numbers stand. That is unusually careful reporting.
>
> The final figures put timeout-shaped stalls at 19 in 134,716 attempts (0.141 per 1000, across 3 of 6 days), down from the 23 in the original post — and you established that the original 23 were not stalls at all, since 19 of them recorded a first byte, 14 within 60 seconds. More decisively, the tight window contains exactly 5 attempts whose parent request still ended 200, which matches the "failover rescued 5" count. The existing combo failover already covered every affected request.
>
> On that evidence a second per-attempt timeout axis is not warranted. `connectTimeoutMs` is documented as a header-arrival budget precisely so it is not confused with a whole-request budget (`src/types/config.ts:1058`), and adding `attemptFirstByteTimeoutMs` alongside it would give operators two interacting deadlines to reason about for a 0.014% event that already self-heals.
>
> If the stall rate changes materially — a provider that regularly holds connections without sending headers, or a case where failover does not rescue — please reopen with the new sample and we will revisit. The measurement methodology you built here would make that a quick decision.

---

## Issue #4001 — Cockpit Tools Antigravity import as Tier-2 support — CLOSE

**URL:** https://github.com/lidge-jun/opencodex/issues/4001 · Author: lidge-jun · label `account-pool`

### Why CLOSE

This is a maintainer's own scratch item asking whether to formalize Tier-2 (unofficial) support for Cockpit Tools Antigravity import. Its own review comment records that the 1st-party version already closed:

> "바로 앞에서 1급으로 보이던 요청·구현은 이미 닫혔습니다. feature #3998과 PR #3999(클립보드 붙여넣기 + 통합 auth 선택)입니다. 본문 메모도 '공식 지원 아님. 2급은 별도로 생각해보겠다'입니다."

and that file-based import already exists on dev. That is confirmed — the account-import subsystem is present with a dedicated Antigravity adapter:

```
$ ls /tmp/ocx-249.xGQnxl/wt/src/oauth/account-import
google-antigravity-adapter.ts
index.ts
parser.ts
registry.ts
service.ts
types.ts
```

The only remaining ask from the community commenter (agentHits) is clipboard paste rather than file import — and that is exactly what closed PR #3999 covered. There is no decision left that this issue can carry; a Tier-2 tier definition, if wanted, is a docs/policy change rather than an open engineering item.

### Closing comment to post

> Closing this as resolved by what already shipped and what was already decided.
>
> File-based Antigravity import exists on `dev` today — `src/oauth/account-import/` carries a dedicated `google-antigravity-adapter.ts` alongside the shared parser, registry and service. The 1st-party clipboard-paste variant was considered and closed as #3998 / #3999, and this issue's own note records the position: official 1st-party OAuth stays separate from community tool integrations in the main UI.
>
> @agentHits — thank you for the detailed context on why token import and multi-account workflows matter in daily use; it was genuinely useful and it is recorded here. The practical answer for now is that file import works and is supported, and native multi-account pool rotation for Antigravity is being pursued directly in #3283 / #2562 rather than through a community-tool bridge.
>
> If a Tier-2 support tier is later formalized, it will be a documentation and policy change rather than an open engineering item, so there is nothing further to track here.

---

## Issue #3255 — decouple model capability and response speed — CLOSE

**URL:** https://github.com/lidge-jun/opencodex/issues/3255 · Author: str0203 · labels `enhancement`, `needs-info`, `catalog`

### Why CLOSE

Filed as a bug claiming capability and speed are "one setting". The maintainer's review established the axes are already separate at `src/codex/catalog/effort.ts`, and the reporter **agreed**, in the last substantive comment (2026-09-04):

> "Thank you for the detailed review. I agree that this should be classified as an enhancement rather than a bug. The catalog already has separate reasoning/capability and service-tier axes; the requested change is to expose those existing axes independently in the ChatGPT Desktop integration and define the compatibility ..."

So the reported defect does not exist, the label was corrected from `bug` to `enhancement`, and what remains is a different request: surface an existing axis in the Codex Desktop integration. That residual overlaps #3377 (per-model capability declarations), which is the foundational catalog work. The issue still carries `needs-info` and has been open since 2026-09-02 without the compatibility matrix the reporter said they would define.

I flag this as the softest of the four closes: a maintainer who prefers to keep it as a tracking item for the Desktop-surface slice has a defensible position. The case for closing is that the filed defect was disproved and the residual is already owned by #3377.

### Closing comment to post

> Closing this, with the reasoning rather than as a tidy-up — and thank you for engaging with the review so directly.
>
> The filed defect was that model capability and response speed are represented by a single coupled setting. That turned out not to be the case: reasoning effort and service tier are already separate axes in the catalog at `src/codex/catalog/effort.ts`, which is why the label moved from `bug` to `enhancement`, and you agreed with that reclassification.
>
> What remains is a different and narrower request — exposing those existing axes independently in the ChatGPT Desktop integration, plus a compatibility matrix for which combinations are actually valid. That work depends on per-model capability declarations, which is tracked in #3377, and it is better pursued there than in a thread whose original premise was disproved.
>
> If you would like to drive the Desktop-surface slice specifically, please open a focused issue with the capability/speed combinations you expect to be selectable and what each should do when the upstream does not support the pairing. That is the missing piece that would let it move.

---

## Confirmed DEFER — PRs

The 21 deferred PRs fall into four groups. All contributor drafts fail exactly `enforce-target` and `hygiene` (the draft-readiness gates in `.github`), which is a checklist state rather than a code failure — do not read those as broken builds.

**Too large for a single review** — #3810 (+69403/100 files, Go runtime line, and AGENTS.md states "Bun-native TypeScript on `dev` is the only runtime line"), #3458 (+15547/99 files), #4022 (+35574/340, where reviewer Ingwannu already asked for a 4-part split and the author has prepared a smaller core-only branch), #2562 (+4031/46), #3025 (+3461/27 commits).

**Blocked on an unsettled design** — #2881 and #3738 both implement reset-window/quota-aware account routing, which depends on #3376 (quota history as a scheduling input) being decided first; #3282 needs the #3377 capability model; #3283 has CHANGES_REQUESTED and overlaps #2562's direction; #2921 is blocked on upstream oven-sh/bun#40461, which commenter Ingwannu verified is "currently open, unmerged, and blocked on review".

**Security or policy boundary** — #3639 (EntraID auth for Azure Foundry) and #3080 (persistent origin-scoped dashboard sessions) both touch authentication and require explicit security review per MAINTAINERS.md; #3741 (TLS fingerprint profile) needs a maintainer position on transport impersonation.

**Small and green but product-shaped** — #3389 (mid-stream socket-reset refetch, MERGEABLE, all 5 subset checks pass), #3833 (Command Code integration, MERGEABLE, 5 pass), #3952 (freshest at only 86 behind, MERGEABLE, 5 pass), #3463 (the #3459 extension hook), #3709, #3652, #3663, #3901, #4020. Of these, **#3952, #3389 and #3833 are the most tractable** if the maintainer wants additional merge volume: all are MERGEABLE, all have their subset checks green, and #3952 is only 86 commits behind. They are DEFER here because each embeds a product decision (retry semantics, a new client surface, adapter tool-call compatibility), not because of mechanical risk.

## Confirmed DEFER — issues

No enhancement issue in this lane is fully implemented on dev. Specific dev-state anchors for the ones most likely to look shipped:

**#3573** — the 256 MiB inbound cap is real and hard-coded:
`src/server/request-decompress.ts:22` — `export const MAX_DECOMPRESSED_BODY_BYTES = 256 * 1024 * 1024;`
`src/server/index.ts:1045` — `maxRequestBodySize: MAX_DECOMPRESSED_BODY_BYTES,`
The comment above it explains the cap is an OOM guard, not an anti-bomb measure, which is exactly the tradeoff a fix must re-decide. DEFER.

**#2511** — the refusal half shipped, the remedial half did not:
`src/config.ts:1117` — `maxUpstreamBodyBytes: z.number().int()`
`src/server/responses/core.ts:4058` — `const bodySize = checkOutboundBodySize(rebuilt.body, config.maxUpstreamBodyBytes);`
Downscale-then-prune mutates request content and is unbuilt. DEFER.

**#3894** — the import cycle is real and exactly as described:
`src/router.ts:13` — `import { captureProviderApiKeySelection } from "./providers/api-key-selection";`
`src/providers/api-key-selection.ts:6` — `import { routedProviderConfig } from "../router";`
The helper at `api-key-selection.ts:10` reads only `entryId` / `reference` / `revision`, so it needs neither route resolution nor persistence — the extraction is sound. PR #3897 (parkjs101, MERGEABLE) implements it. DEFER to that PR rather than closing the issue.

**#3859** — masking is unconditional, with no toggle anywhere:
`src/lib/privacy.ts:1` — `export function maskEmail(value: string | null | undefined): string | null {`
`src/lib/privacy.ts:10` — returns the masked template form yielding `n***d@example.com` for any local part longer than two characters.
`rg -ni "unmaskEmail|showFullEmail|maskEmails|emailMasking" src gui/src` → no matches. DEFER (privacy policy call).

**#2730** — the ChatGPT-forward-only gate is intentional:
`src/server/search.ts:104` — `const candidates = listOpenAiForwardSidecarCandidates(config);`
`src/server/search.ts:108-110` — `"Built-in web search needs a ChatGPT forward provider, but none is configured in opencodex. " + "Routed and OpenAI API-key providers cannot serve /v1/alpha/search."` DEFER.

**#3630** — no auto-refresh exists: `rg -n "catalogRefreshInterval|autoRefreshCatalog" src` → no matches. DEFER.

**#3958** — no synthetic context aliases: `rg -n "900k|extendedContext|contextTier" src/codex/catalog/metadata.ts` → no matches. DEFER.

**#4038** — dev already has per-request throughput plumbing (`gui/src/pages/logs-filter.ts:14-15`, `minTokPerSec` / `maxTokPerSec`, and `logs-filter.ts:47` `tokPerSecond?: { kind: "value"; value: number } | { kind: "unavailable" }`), but the *decode-only* estimate the issue asks for is what PR #4040 adds. #4040 is MERGEABLE and not a draft. DEFER to #4040.

**#3379 and #3774 are partial and correctly annotated.** #3379: rollback-entry deletion shipped (`413227888 feat(integrations): let an operator delete one rollback journal entry (#3477)`) and custom usage ranges shipped (`da707ccb6 Merge pull request #3905`); only account-selector renaming remains, and `rg -n "renameAccount|accountLabel|selectorLabel" src/server/management/oauth-account-routes.ts` returns nothing. #3774: drag-and-drop shipped (`1e188b787 Merge pull request #3887`, with `gui/src/model-picker-order.ts` and `gui/src/pages/Models.tsx` on dev); native/featured row reordering remains. Both should stay open.

**#3666** — the free-model filter is genuinely cross-layer, not a GUI toggle. `gui/src/pages/Models.tsx` has only manual pricing overrides (lines 1712, 1717, 1723) and no free/pricing filter. Contributor Sfrui traced the same conclusion and claimed the issue. DEFER.

---

## Shared files / stack order

### Overlap with the luvs01 fixture train (#4004 #4012 #4014 #4015 #4039 #4034 #4041 #4036 #4043 #4025 #4006 #3997)

The luvs01 train touches 52 files. Lane E PRs that collide with it:

| Lane E PR | Files shared with luvs01 train |
| --- | --- |
| #3663 | `src/codex/inject.ts`, `tests/codex-integration/codex-auth-context.test.ts`, `docs-site/src/content/docs/guides/codex-integration.md`, `docs-site/src/content/docs/ko/guides/codex-integration.md` |
| #3709 | `src/codex/auth-context.ts`, `structure/08_openai-provider-tiers.md`, `tests/codex-integration/codex-auth-context.test.ts` |
| #3738 | `src/codex/auth-context.ts`, `tests/codex-integration/codex-auth-context.test.ts`, `docs-site/src/content/docs/reference/cli/providers-accounts.md`, `.../ko/reference/cli/providers-accounts.md` |
| #4020 | `src/codex/account-lifecycle.ts`, `src/codex/auth-context.ts`, `structure/08_openai-provider-tiers.md`, `tests/codex-integration/codex-auth-context.test.ts` |
| #2921 | `docs-site/src/content/docs/reference/cli/lifecycle.md`, `.../ko/reference/cli/lifecycle.md` |
| #2562, #2881, #3282 | `docs-site/src/content/docs/reference/cli/providers-accounts.md` |
| #2805 | `structure/01_runtime.md` |
| #3463 | `structure/02_config-and-codex-home.md` |

**`src/codex/auth-context.ts` and `tests/codex-integration/codex-auth-context.test.ts` are the hot spot** — shared by the luvs01 train and four Lane E PRs (#3663, #3709, #3738, #4020). Since all four are DEFER, the luvs01 train can proceed on those files without contention. If any of them is later revived, sequence it **after** the luvs01 train lands.

### Contention inside Lane E

Ranked by how many Lane E PRs touch the same file:

- `src/config.ts` — 11 PRs (#2562, #2921, #3282, #3463, #3652, #3709, #3738, #3741, #3901, #4020, #4022)
- `src/types/config.ts` — 10 PRs (#2562, #2881, #2921, #3080, #3283, #3463, #3652, #3709, #3738, #4020)
- each `gui/src/i18n/*.ts` — 9 PRs (#2881, #3025, #3282, #3458, #3639, #3914, #3915, #4020, #4022)
- `src/server/responses/core.ts` — 8 PRs (#2562, #3282, #3283, #3389, #3463, #3652, #3663, #3738)
- `docs-site/src/content/docs/reference/configuration/providers.md` — 8 PRs
- `scripts/test-layout/layout.json` — 7 PRs (#3663, #3738, #3741, #3901, #3914, #3915, #4022)
- `tests/fixtures/test-layout-expected.json` — 6 PRs (#3663, #3738, #3741, #3901, #3914, #3915)
- `structure/05_gui-and-management-api.md` — 6 PRs
- `src/providers/registry.ts` — 5 PRs (#2805, #3639, #3914, #3915, #3952)
- `src/cli/registry.ts` — 5 PRs · `src/server/index.ts` — 5 · `src/server/auth-cors.ts` — 5 · `README.md` — 5

The two test-layout registry files are the single most reliable source of mechanical conflict across the whole repository's open-PR surface. Any parallel stack should land them one at a time and regenerate rather than merge.

### Recommended stack order for the actionable items

1. **#3914** (OrcaRouter) — regenerate the two test-layout files against current dev, land first. It is the first Standard sponsor and carries the shared mechanism.
2. **#3915** (PackyCode) — rebase onto post-#3914 dev. Roughly 20 shared files with #3914 including the new `ProviderSponsor.tsx`, so this must be strictly sequential. Its extra surface is the new `packycode` registry preset, `gui/src/provider-icons.ts`, `gui/public/provider-icons/packycode.svg`, and `tests/providers/provider-registry-parity.test.ts`.
3. **#2805** — close, no landing.

Both sponsor PRs conflict with the luvs01 train only through `scripts/test-layout/layout.json` (7-way) and `tests/fixtures/test-layout-expected.json` (6-way), so whichever train runs second regenerates those two files. There is no source-code contention between the sponsor pair and the luvs01 fixture work.

---

## Verification notes

- Repository research worktree `/tmp/ocx-249.xGQnxl/wt` remained detached at `7dc7dc99e65268bc8764e19840952256b030bce9` throughout; `git status --porcelain` was empty before and after, and the index was never written. PR heads were fetched into `refs/laneE/*` refs only, and `git merge-tree` was used for conflict detection so no working tree was modified.
- No tests were run. `node_modules` is absent in the research worktree and was deliberately not created, since every finding here rests on source inspection, `gh` metadata, and merge-tree analysis rather than execution. The two sponsor PRs already carry full green CI at their exact heads, which is stronger evidence than any local focused run.
- CI states were read with `gh pr checks <N>` at the head SHAs recorded in the table. The recurring "3 pass / 2 fail" shape on contributor drafts is `enforce-target` + `hygiene` — the draft-readiness gates described in AGENTS.md — and reflects an incomplete review-readiness checklist rather than a code failure.
- No GitHub state was mutated: no comments, closes, merges, or pushes. All closing comments above are drafts for the maintainer to post.
