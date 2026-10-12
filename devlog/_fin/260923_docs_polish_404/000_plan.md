# 260923 docs polish and 404 repair — roadmap

A reader on X reported that https://opencodex.me/guides/macos-menu-bar/ returned 404. The page
existed on `main`; the Deploy Docs run for #5510 (run 35714540735) was cancelled by hand on
2026-09-22, so the live site stayed on the 2.60.0 build. The maintainer approved a redeploy and
run 35778046041 (workflow_dispatch on main 2f8216792f) published it; the reported routes and their
ko/ja/fr variants now answer 200. This unit fixes what the redeploy could not: source links that
404 even when deployed, a macOS guide describing a retired companion app, README claims that
drifted from the code, and 18 English pages missing from some locales. It lands as one PR to
`dev`; the live site changes again only at the next `dev → main` promotion and Deploy Docs run.

## Loop spec

| Field | Value |
| --- | --- |
| Loop archetype | satisfy-spec, multi-cycle HOTL (5 work-phases, one PR) |
| Trigger | User request: fix the reported 404, polish README and docs, open a docs PR, use gpt-6-sol subagents freely |
| Goal | No docs link in the repository points at a route the site does not build; macOS/desktop docs and README match current code; every locale carries the guides, reference and troubleshooting pages English has (`contributing/` excluded: open PR #5593 owns it, so `contributing/pr-quality.md` stays missing in ja/ko/ru/zh-cn) |
| Non-goals | Runtime code, dependencies, CI workflow edits (security-review boundary), file-size cap raises, `devlog/_fin` and ADR history, merge/release/promotion, the memory-inventory README section owned by open PR #5340, contributing pages and `docs-site/public/pr-screenshots` owned by open PR #5593 |
| Verifier | `bun test tests/ci-workflows/docs-link-targets.test.ts` (new; reads every docs content file and the URL surfaces), `bun test tests/ci-workflows/docs-readme-translation-parity.test.ts` (reads README.md, readme/*), test-layout tests, `cd docs-site && bun run build` (reads all content + astro.config.mjs), a scratch rendered-anchor audit over `docs-site/dist`, `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan` |
| Stop condition | PR open against dev with exact-head CI inspected per job and all goalplan criteria met |
| Memory artifact | this unit + the `.codexclaw/goalplans/` goalplan and ledger |
| Expected terminal outcomes | DONE with PR URL and CI evidence; BLOCKED if push/PR refused; UNSAFE if a fix needs runtime or workflow changes |
| Escalation condition | Anything needing `.github/workflows`, a runtime change, or edits overlapping #5340/#5593; a subagent packet that fails with two distinct agents is reclaimed by main |

HOTL resource bounds: repo-local shell, gh (read, push this branch, create the PR), gpt-6-sol
subagents with disjoint write scopes; write scope is the file map in 010-040; no user-set token or
wall-clock budget.

## Work-phase map (dependency order)

| wp | Doc | Outcome |
| --- | --- | --- |
| wp1 | this file + 010-040 | roadmap locked (docs only) |
| wp2 | [010](010_wp2_link_integrity.md) | broken links fixed, guard test landed and driven red |
| wp3 | [020](020_wp3_english_polish_readme_resync.md) | English README + desktop/macOS guides match code; 7 README locales resynced |
| wp4 | [030](030_wp4_locale_coverage.md) | missing locale pages translated, sidebar labels complete |
| wp5 | [040](040_wp5_delivery.md) | gates green, PR open, exact-head CI inspected |

wp3 depends on wp2 (the guard checks the rewritten links). wp4 depends on wp3 (translations are made
from the final English pages). wp5 depends on everything.

## Evidence already gathered

- Live: before the redeploy `guides/macos-menu-bar/`, `guides/desktop-app/` and `ko/guides/macos-menu-bar/`
  returned 404 and the sitemap lacked both pages. After run 35778046041 they return 200.
- Scratch audit `.tmp/link-audit.ts` (gitignored): one root-relative break
  (`guides/desktop-app.md:104` `/opencodex/guides/macos-menu-bar/`) and three relative breaks
  (`reference/configuration/server.md:717-719` `../../guides/codex-integration.md#…`, which resolves to
  `/reference/guides/codex-integration.md`, live 404).
- `lidge-jun.github.io/opencodex/…` 301-redirects to `opencodex.me/…`, so the README links work today.

## Architect consultation (formal P)

- Architect handle `01a0caba-ab24-76c1-a2a6-710fbb3f6d9a` (gpt-6-sol, high effort, `CXC-ROLE: architect`,
  V1 transport). Proposal decisions D1-D6.
- Main dispositions:
  - D1 guard at `tests/ci-workflows/docs-link-targets.test.ts`: ACCEPT, amended to also resolve
    relative links against the page URL, which is where the three real breaks were.
  - D2 English fallback is a valid locale route: ACCEPT.
  - D3 expand `.github/workflows/ci.yml` for rendered-anchor proof: REJECT the workflow edit (a
    security-review boundary, AGENTS.md "Security boundary"), ACCEPT the need. The rendered check moves
    into the Astro build as a local integration, which the existing CI `docs` job and Deploy Docs
    already run; the Bun test covers README/source URLs, which the `ci` filter already matches.
  - D4 README links to canonical opencodex.me, localized per README: ACCEPT.
  - D5 ordered commits: ACCEPT, amended so the English README edit ships in the same commit as the
    seven locale resyncs and every commit keeps the parity test green.
  - D6 ratchet/union risks: ACCEPT; also fix the stale locale sentence in
    `structure/ops/docs-and-release.md`.
- Open question from the architect (translate all pages or a subset): all 18, main decision, because
  the user granted unlimited subagents and fallback pages read as untranslated in the nav.
- Reflection round 1: MISALIGNED, six gaps (image/src links, trailing-slash wording, hand slugger and
  MDX fragments unproven, URL exception in the translation contract, wrong structure binding
  mechanism, docs-only PRs never run the Bun suite). Dispositions: all folded; 010 rewritten around a
  build-time check that reads rendered ids and every href/src, 030 gains the URL exception, 040 the
  README fragment audit, 010 drops the manifest binding.
- Reflection round 2: MISALIGNED, two gaps. Confirmed sound: `astro:build:done` receives `dir`; CI
  `docs` job runs `bun run build` in docs-site (`ci.yml:1008-1014`); plain .mjs import into Bun is
  fine. Gaps folded: absolute same-host links count as internal in Layer A; existing fragment failures
  are fixed, never globally disabled; 030 acceptance attributes fragment proof to Layer A.

## Explorer evidence

- Meitner `01a0caba-ac00-7700-8bcb-6c51d5fdfda9` (guides audit): 7 findings; main spot-checked
  `desktop/src-tauri/src/resolve.rs:3-7`, `auth.rs:19-24`, `tray.rs:236-240`, `desktop/package.json:4-11` and
  `desktop/README.md:28-45`; all confirmed.
- Turing `01a0caba-acf8-77d2-a378-b7af9f77a883` (README audit): 5 findings; #4 (memory counts) is left to
  open PR #5340; #2 confirmed (`gh api repos/lidge-jun/opencodex --jq .default_branch` is main while the
  README says a plain clone runs dev).

## Audit round 1 (reviewer Volta `01a0cac3-2bd5-73b1-a667-1d7a02948ec8`, gpt-6-sol high)

VERDICT: GO-WITH-FIXES (blockers=7). Synthesis and dispositions:

1. Layer A missed relative and fragment-only links: FOLDED (010 resolves every rendered href against the page URL; `#frag` checks the same page).
2. Legacy host `lidge-jun.github.io/opencodex/…` (used by `src/server/management/cursor-integration-routes.ts:24`) is valid via GitHub's redirect: FOLDED (010 strips the project prefix for that host only; a canonical-host `/opencodex/` stays broken; fixtures for both).
3. `contributing/pr-quality.md` missing in four locales was not listed: FOLDED by narrowing the goal (contributing is #5593's area) and excluding `contributing/` from the scan explicitly.
4. DMG vs app signing: FOLDED (020 wording distinguishes the notarized app from the unnotarized DMG container; evidence in 020).
5. Bypass record lacked tier and final layer: FOLDED (E8 for both layers; final layer named).
6. 020/030 not diff-level: FOLDED. 020's replacement text lives in `021_wp3_macos_menu_bar_draft.md` (written by a gpt-6-sol worker, verified by main before A>B); 030 records a delegation output contract with mechanical acceptance, because translated prose cannot be pre-written without doing the translation.
7. A combined Bun command hides an absent test: FOLDED (010 and 040 run the new test alone and count its pass lines).

Non-blocking anchor corrections are folded into 020.

## Audit round 2 (same reviewer)

VERDICT: GO-WITH-FIXES (blockers=3). Five round-1 folds confirmed closed; 021 sampled claims confirmed.

1. Signing wording pinned to v2.61.0 and README overstated local builds: FOLDED (021 and 020 say "Release builds of OpenCodex.app…", local builds ad-hoc).
2. Stop proxy described as conditional: FOLDED (021: always listed, enabled only when the app started the proxy; tray.rs:61,279).
3. 030 lacks pre-written translated content: REBUTTED. The translated prose is the wp4 deliverable itself; writing it into the plan would perform wp4 inside the docs-only cycle, which LOOP-DOCS-FIRST-01 forbids ("no production patches" in the roadmap cycle). DIFFLEVEL-ROADMAP-01's purpose, an executable PRD per phase, is met by the fixed NEW-file list, the pinned source (English at the wp4 P revision), the byte-identity rules for code, links and frontmatter keys, and the mechanical parity script. Sidebar labels are defined as each new page's translated frontmatter title, so they follow from the worker output with no further judgment. wp4's own P re-verifies this doc against the tree, as the rule requires.

Main verdict for A>B: near-pass.
