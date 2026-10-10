# 010 — Context and requirements

Source: three in-app browser comments left on `http://localhost:10100/#providers`
with the add-provider modal open (2026-09-12), plus the follow-up instruction to
co-design R1 with `xai/grok-4.6` through Aside and land the work as a manual
stacked PR chain.

## The surface today

`gui/src/components/provider-catalog/ProviderCatalog.tsx` renders, in order:

1. a tablist of three tiers — Accounts / Free / Paid;
2. an Accounts-only hint line;
3. a search input **below** the tabs;
4. one scrolling `.provider-catalog-rows` list for the active tier;
5. a footer with the "not listed? add a custom one" link.

View state is local: `tier` and `query` in `useState`. Switching tiers resets the
query to `""`. `filterPresets` (in `provider-presets.ts`) matches case-insensitively
on `label` and `id` only, and is applied to `buckets[tier]` — one tier at a time.

Tier assignment is delegated: `presetTier` calls `providerTier` in
`gui/src/provider-workspace/catalog.ts`, which is a three-way classifier shared with
the providers workspace (rail sort modes, badges, section binning). `isFreeProvider`
there folds `authMode === "local"` and loopback base URLs into **free**.

## R1 — unified search (highest priority)

> 이거 검색을 상단에 통합할수 는없나 검색창을 통합검색으로 바꾸기

Move the search to the top and make it search every tab at once. The user asked the
design question explicitly: when a match lives in a tab that is not selected, what
does the tab strip do? Candidate behaviours are compared in `40_r1_unified_search.md`
against the grok-4.6 co-design recorded in `15_codesign_grok.md`.

## R2 — long notes

> 이런 설명 너무 긴거 두줄 잘림 클릭하면 팝업에서 보이기

The `.sub` line is `<code>{adapter}</code> · {note}`. `opencode-free` carries a
~900-character note that renders as ~20 lines and consumes the entire 360px scroll
viewport, so the row it belongs to is the only row a user can see. Clamp to two lines;
reveal the rest on demand.

## R3 — local providers

> 로컬 쪽은 확실하게 새로운탭으로 구분하기

Ollama, vLLM, LM Studio and any loopback-base-URL preset currently sit in **Free**,
interleaved with hosted free tiers. They have a different setup story (nothing to sign
up for, a runtime to install) and deserve their own tab.

## Constraints carried from the request

- No local test suite, typecheck, or build runs in this worktree. Verification is
  remote CI on each PR head. Local checks are reported as NOT RUN.
- Every push uses `--no-verify`.
- Delivery is a manual dependent PR chain: each PR is based on the previous PR's head
  branch, retargeted to `dev` after its parent lands.
