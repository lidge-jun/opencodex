# 000 — dev regression review + prompt base variants and git_attribution

Unit: `devlog/_plan/260827_dev_regression_and_prompt_variants/`
Opened: 2026-08-27 · Work class: C4 · Branch target: `dev`
Base commit for opencodex citations: `5d0a97bd1` (dev HEAD, level with origin/dev).
Base commit for upstream citations: `4462b9dee` in
`/Users/jun/Developer/codex/120_codex-cli` ("Allow disabling the multi-agent wait
tool (#34887)"). The 121_openai-codex checkout at this HEAD does NOT carry
`ext/git-attribution`; 120_codex-cli does. That difference is load-bearing and
§3 records what follows from it.

## Objective

Two things the user asked for in one session, plus the review that has to come
first.

1. Review the 179 commits in `origin/main..dev` for regressions before they are
   promoted, with the 503 class ("503 같은 회귀가 있을수도 있잖아") driven against
   a live proxy rather than reasoned about.
2. Give `base-instructions` a real switch and a 2-3 variant selector reachable
   by left/right swipe, where the default variant can never be edited or removed
   ("base 같은것도 끌수 있다면서 이런것도 스위치 달아야지 그리고 base 에서도 2-3번
   옵션으로 변경할수 있도록하고 기본값은 변경안되도록 좌우 스와이프로").
3. Implement the annotation layer from codex-rs ("annotation 부분 구현도 codex-rs
   참조해서 하고").

## What "annotation" turned out to be

The user said "annotation 부분 구현도 codex-rs 참조해서 하고" and, separately,
"어차피 codex-rs에 내장되어있잖아 코덱스는 오픈소스야". Searching
`121_openai-codex/codex-rs` for `annotation` returns only MCP tool annotations
and Responses-API `url_citation` annotations — neither is a prompt layer.

The prompt layer exists in the OTHER checkout:
`120_codex-cli/codex-rs/ext/git-attribution/src/world_state.rs`. It is a
world-state section with id `git_attribution`, markers
`<git_attribution>`/`</git_attribution>`, role `developer`, and three distinct
bodies (`ENABLED_INSTRUCTIONS`, `DISABLED_INSTRUCTIONS`,
`LEGACY_COMMIT_ATTRIBUTION_INSTRUCTIONS`). Its content is commit and pull-request
attribution — the `Co-authored-by: Codex <noreply@openai.com>` trailer and the
`Generated with Codex.` PR marker. That is the annotation the user meant: Codex
annotating its own commits.

Our `LAYER_INVENTORY` (`src/codex/prompt-layers.ts:88-104`) has fifteen entries
and none of them is this one. The panel therefore under-reports the prompt by one
whole developer section, which is exactly the failure mode the panel exists to
prevent.

## The finding that shapes WP3

`git_attribution` is NOT config-gated. `ext/git-attribution/src/lib.rs:33-80`
resolves the policy from the AUTH SERVER — `resolve_attribution_policy(auth_manager,
base_url, http_client_factory)` — caches it on the thread store, and falls back to
`enabled: false` when the lookup fails. `features/src/lib.rs:277` records the old
flag as "Removed legacy git commit attribution guidance flag", so the config key
that once controlled it is gone.

Consequences for the row, all of which the design must respect:

- Class is `runtime-conditional`, not `config-toggle`. There is no key to write.
- It renders with NO switch, per the rule already enforced in
  `PromptLayerRow.tsx:88-96`: a disabled control would claim a capability that
  does not exist.
- Its condition line has to say the real condition — the account's attribution
  policy — not "always on", because both DISABLED and ABSENT are reachable states.
- Its assembly order is registration-order dependent (it arrives through
  `extensions.context_contributors()`, `core/src/session/world_state.rs:64-66`),
  so `order` is `null` and the row shows the neutral dot the existing code
  already renders for that case.

This is the third time in this unit's family that a "family resemblance" guess
would have been wrong (`registry.ts:500-506` warns about the same thing for
models). The layer LOOKS like a config toggle because every other developer
section we ship is one. It is not.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

| WP | Outcome | Doc | Depends on |
|---|---|---|---|
| WP0 | This roadmap, locked | `000`–`030` | — |
| WP1 | Regression review of `origin/main..dev`, 503 class driven live | `001` | WP0 |
| WP2 | `git_attribution` layer end to end | `010` | WP1 (a regression fix could move the same files) |
| WP3 | base-instruction switch + variant swipe selector | `020` | WP2 (both extend the same descriptor pipeline; WP2's is additive, WP3's changes base semantics) |
| WP4 | Docs, locale parity, stack merged | `030` | WP2, WP3 |

WP2 before WP3 is not an effort call. WP2 adds a row to an existing taxonomy with
no new state; WP3 introduces a per-variant store and a write path that can replace
the base prompt. Building the additive one first means WP3's audit reviews one
new concept instead of two.

## Scope boundary

IN: `src/codex/prompt-layers.ts`, `src/server/management/codex-prompt-routes.ts`,
`gui/src/pages/codex-set-prompt.tsx`, `gui/src/components/codex-set/*`,
`gui/src/i18n/*`, `gui/tests/codex-set-*.test.tsx`,
`tests/codex-prompt-*.test.ts`, `docs-site/src/content/docs/*/guides/codex-prompt.md`,
this unit.

OUT: `src/lab/` (the core-lab boundary in AGENTS.md), `src/generated/model-metadata.ts`
(generated), theme (`260802_codex_set_prompt_composer/090_theme_deferred.md` defers
it and nothing here changes that), `go/`, release automation, auth and credential
handling.

## Verification contract

Per work-phase, and no more than this:

```
cd gui && bun x tsc -b --force        # NOT --noEmit: gui tsconfig has files: []
bun x tsc --noEmit                   # repo root
bun test <changed file>              # narrow, per file
bun test ./gui/tests/                # directory form is acceptable
bun run lint:gui                     # judged no-NEW-findings vs origin/dev's 17
bun run privacy:scan
git diff --check
```

The full local suite is never run — a standing user constraint. Heavy verification
goes to CI or `ssh lidge-ai` / `ssh clisu-oracle`. Every commit and push uses
`--no-verify`.
