# Shared dashboard scroll boundary

Codex and Claude account pages can keep scrolling after their visible content ends, moving the sidebar upward and exposing a blank lower area. Preserve the existing page layout while giving normal dashboard pages one document scroller. This single C2 work-phase includes repair, rendered regression checks, and a normal PR merged into dev.

## Loop specification

- Archetype: satisfy-spec bug repair. Trigger: user screenshot and explicit request to fix with Sol subagents and merge.
- Goal: no second outer scroll or blank strip below the sidebar after reaching the end of account pages.
- Non-goals: provider/settings behavior, dependency updates, release/deployment, installed-app replacement, wholesale fixed-shell redesign.
- Verifier: real Chrome measurements and screenshots; maintained built-CSS browser regression; GUI suite/lint/build; repository typecheck, structure check and required current-head CI. Browser script is new and must first fail on unchanged CSS. Existing GUI tests do not calculate layout.
- Stop: merged PR, recorded passing required CI, rendered evidence and honest native-runtime coverage limits.
- Memory artifact: this unit, ignored .tmp/scroll-gap evidence, durable .codexclaw goalplan.
- Outcomes: DONE only after all criteria; unresolved external permission/runtime failures remain unmet. No invented budget exhaustion.
- Escalation: broader shell redesign or unavailable merge authority; main owns decisions and git. No token/cost/time bound was supplied. Tool/credential scope is local GUI, existing browser tooling, and repository GitHub PR/CI/merge authority.

## Evidence and hypotheses

H1: body overflow-axis coupling creates two vertical scrollers. Falsifier: body is not scrollable or removing its horizontal scroll container does not remove the defect.
H2: page bottom padding/min-height is excessive. Falsifier: existing content bottom aligns with viewport after changing only body scroll ownership.
H3: sidebar/background painting alone fails. Falsifier: measured sidebar rectangle itself leaves the viewport.

Chrome on the actual Vite GUI, /#codex-set/multiauth at 1280x800, gave body scrollTop=704, then window scrollY=352 after a second downward wheel. Sidebar top=-352/bottom=448; .app bottom=448.375. Changing only body overflow-x to clip gave body scrollTop=0, window scrollY=704, sidebar top=0/bottom=800 and .app bottom=800.375. This rules out H2/H3 as primary causes. Generic tall shell without an escaped absolute descendant did not reproduce the outer overflow; regression must drive the second scroll.

## Consultation

V1 multi_agent_v1 transport; architect 01a0ff1b-efd3-7c61-bcae-715a83b10fda requested gpt-6.1-sol. D1 accepted: body-only overflow clipping; D2 accepted: keep document scrolling and existing height model; D3 accepted: preserve titlebar/mobile/Combos relationships; D4 accepted: rendered geometry before/after, not CSS strings as visual proof. Same-architect reflection: ALIGNED with D1-D4; accepted clarifications: fixture is mechanism coverage, actual Codex and Claude routes are mandatory; production mobile drawer effect must lock/restore without scroll jumps. Independent A follows reflection.

## Scope and delivery

See 010_scroll_boundary.md for exact changes. Existing source owners and test patterns reused; no runtime abstraction or dependency needed. One ordinary PR targets dev, no native stack. Full root suite is disproportionate for a CSS-only runtime delta; focused GUI checks and browser regression run locally, broad runtime suite stays with required hosted CI. Screenshot evidence is uploaded to pr-assets, never committed on the feature branch.

Toggle proof also reproduced Claude: body=811, window=537, sidebar bottom=263 before; body=0, window=811, sidebar bottom=800 with clip; removing override restored the same 537px gap. Built unchanged GUI successfully; baseline bundle retained in ignored scratch.

Mobile amendment: body-only lock allowed document wheel movement after clipping. A narrow-screen html:has(.sidebar.open) overflow-y:hidden rule repaired it in the actual App (open=482, after wheel=482, close restores prior 500). Keep the existing body effect; root lock follows the real open class. Architect D3 recheck completed ALIGNED after stable-anchor measurement.

A review accepted the browser-harness correction: built entry CSS alone misses the lazy App chunk, so tests must load both in production order. Architect D3 final reflection ALIGNED: actual anchor top stayed 396.4375px before/open/wheel/close; scrollY adjusted with reflow. Existing scrollbar-width horizontal shift is outside this vertical gap repair. All D1-D4 remain aligned. Baseline focused titlebar/viewport tests: 15 pass, 0 fail.

B/C evidence so far: actual Codex/Claude browser and desktop-UA surfaces at 1280/1024/768/390/320: 20/20 geometry cases passed. Actual mobile Escape/navigation/resize dismissal and wheel/touch locks passed. Native WKWebView offline probe reproduced hidden -> clip -> hidden and passed 16 observations; packaged Tauri itself was not launched. GUI suite: 2756 pass/0 fail; root typecheck and GUI build passed.
