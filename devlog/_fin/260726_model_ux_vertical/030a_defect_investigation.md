# 030a — WP5 investigation: four display/routing defects, root-caused

Docs-only investigation pass (LOOP-DOCS-FIRST-01 discovered-scope rule): the user
reported four symptoms mid-loop. This document records each root cause against the
current tree and scopes the fix. No code changes in this work-phase.

Baseline: `dev` at `e1d71f14`. Every claim below carries a live `path:line` citation.

> **Review status.** An independent reviewer verified a first draft and returned
> **FAIL** on four High blockers — several initial causal chains were wrong. This is
> the corrected document; each section records the reviewer's `path:line` evidence and
> the disposition (REVIEW-SYNTHESIS-01).

## D1 — context windows render as `1.048576M` and there is no 1M affordance

**Symptom.** Models with a 1 MiB context window show `1.048576M`, and the user reads
the absence of a 1M control as "no 1M support".

**Root cause — three independent facts (reviewer confirmed).**

1. *Formatting.* `gui/src/pages/ClaudeDesktop.tsx:104-110` `formatContextWindow` divides
   by `1_000_000` and interpolates into `claudeDesktop.contextM` = `"{n}M context"`.
   Several providers genuinely report `1_048_576` (2^20):
   `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` pins `gemini-3.6-flash`/`gemini-3.1-pro` to
   `1_048_576` (`src/providers/antigravity-models.ts:104-108`) and `kimi/k3[1m]` too.
   `1048576 / 1e6 = 1.048576` — correct math, ugly string. `Grok.tsx:21-26` repeats the
   same helper.

2. *Native models have NO context window at all.* `buildClaudeDesktopState`
   (`src/server/management/shared.ts:193-200`) maps native models to `{ route, label }`
   with **no contextWindow**; routed models do get theirs. The value exists:
   `nativeOpenAiContextWindow(slug)` (`src/codex/catalog/metadata.ts:68`) — the same
   accessor the Grok sync already uses (`src/grok/sync.ts:38-43`). So Sol's 372k and
   gpt-5.5's 272k render as blank on Desktop. Confirmed live: every `native/gpt-5.x`
   row returns `ctx=None`.

3. *The 1M flags are written but never surfaced.* `src/claude/desktop-3p.ts` sets
   `supports1m`/`prefer1m` on a Desktop registry entry whenever the routed
   `contextWindow >= 1_000_000` (`:42`, `:166-168`, `:178`, `:196-197`). The DTO
   (`DesktopModel` in `shared.ts`) does not carry either flag, so the dashboard shows
   nothing.

   **Reviewer blockers 1 (both rounds, accepted).** Round 1: a real `prefer1m` toggle
   is NOT correctly scoped yet — the writer hard-wires `prefer1m` from eligibility
   (`...(model.supports1m ? { supports1m: true, prefer1m: true })` at `:178`) and the
   persisted profile has no per-model preference field. So WP7 ships the read-only
   `supports1m` chip only; a toggle needs a new profile field and is deferred.
   Round 2: the read-only chip itself is inconsistent for native models. Native
   candidates are created as `nativeSlugs.map(id => ({ provider: "native", id }))` with
   no context (`src/server/management/shared.ts:193-200`), and the apply route strips
   native rows before passing routed contexts to `writeDesktop3pConfig`
   (`src/server/management/agent-settings-routes.ts:445-457`). So WP6's DTO chip could
   light up for a native 1M model while the generated Desktop config cannot emit its
   `supports1m`/`prefer1m`. WP6 must therefore make `desktop-3p` resolve native context
   via `nativeOpenAiContextWindow` in EVERY writer path, and the chip derives from the
   same capability predicate — never from a second, parallel source of truth.

**Fix scope.** (a) format windows `>= 1_048_576` as `1M`; (b) pass
`nativeOpenAiContextWindow` into the native rows; (c) add `supports1m` to the DTO and a
compact `1M` chip on the collapsed row summary. No change to the writer threshold logic.

## D2 — no "claude-api 방어로직" (Anthropic-API input guard) on Desktop

**What exists.** An Anthropic image guard exists and is real:
`src/adapters/anthropic-image-guard.ts` (`enforceAnthropicImageLimits`) and
`anthropic-image-normalize.ts`, invoked from `src/server/claude-messages.ts:309-312`.
Reviewer confirmed: these are **request/image-path** protections, not config validation.

**What is missing.** `desktop-3p.ts` performs no schema validation of its emitted
`inferenceModels` beyond alias-collision checks (`:180-186`).

**Reviewer blocker 5 (accepted — my `[1m]` claim was only half right).** I claimed a
`[1m]` bracket leaks into a Desktop model *name*. It does not: non-Anthropic names are
hashed by `desktop3pAlias()` (`src/claude/desktop-3p.ts:90-93`), so `kimi/k3[1m]` yields
the opaque alias `claude-opus-4-8-kj2` (verified live via `bun -e`). The leak is real
but in the **label**: `displayModelId()` (`:100-110`) splits on `-`/`_` and title-cases
parts, so `k3[1m]` becomes a `labelOverride` of `K3[1m] (kimi)` — the bracket survives
into the human-facing label.

**Fix scope.** Label normalization (strip/normalize bracket segments like `[1m]` → a
clean `K3 1M`), then a write-path schema guard over the emitted `Desktop3pModelEntry[]`
(a sibling `desktop-3p-guard.ts`) asserting: `supports1m` only for genuinely ≥1M models,
`labelOverride` free of bracket markers and within a length bound, `name` matching the
expected alias shape. Mirrors the image-guard precedent.

## D3 — no `claude`/`grok` tag on the usage page

**Reviewer blockers 2 + 3 (accepted — the taxonomy is worse than I described).**

1. *Filter is a fixed 3-way.* `gui/src/pages/Usage.tsx:210` maps a hardcoded
   `["all","codex","claude"]` onto `UsageSurface = "all"|"codex"|"claude"`
   (`src/usage/summary.ts:8`).

2. *The codex bucket is a bug, not just an absence.* `summarizeUsage`
   (`src/usage/summary.ts:494-495`) classifies `claude` as
   `entry.surface === "claude" || "claude-desktop"` and `codex` as
   `entry.surface !== "claude"`. **So a `claude-desktop` entry matches BOTH filters** —
   `codex` currently swallows every `claude-desktop` turn.

3. *Widening the TS union alone loses the new value.* The two log serializers whitelist
   only `"claude" | "claude-desktop"`: `src/usage/log.ts:220` and
   `src/server/request-log.ts:147,223` both do
   `...(entry.surface === "claude" || entry.surface === "claude-desktop" ? { surface } : {})`.
   A `"grok"` value would be silently dropped at write time unless both are updated.

4. *Grok attribution — capability verified, provenance is best-effort.* I first claimed
   Grok traffic is detectable from the fence's `api_key = "opencodex-loopback"`.
   Reviewer round 1: `handleChatCompletions` (`src/server/chat-completions.ts:47-80`)
   has no attribution check and non-loopback admission
   (`src/server/auth-cors.ts:184-188`) accepts only `x-opencodex-api-key` — so a static
   client string cannot prove Grok origin. Reviewer round 2 pressed further: I then
   proposed a dedicated `x-opencodex-grok: 1` header, but had NOT verified Grok can
   even send a custom header, and the fence emits only
   `model/base_url/api_backend/api_key/name` (`src/grok/inject.ts:152-160`).

   Verified against the Grok source (`/Users/jun/Developer/codex/180_grok-build`): Grok
   DOES support a per-model custom header that it sends verbatim on every inference
   call — `extra_headers = { "X-Request-Tags" = "..." }` in the user guide
   (`crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md:89,111`), with a
   global `[models].extra_headers` default that a per-model entry overrides per key
   (`apply_global_extra_headers` in `config.rs`). So the fence CAN add
   `extra_headers = { "x-opencodex-grok" = "1" }`.

   **Provenance honesty (both rounds accepted).** Even so, a static header on a
   loopback bind is not cryptographic proof: any client on the same loopback can send
   the same header, and loopback binds do not require API admission. So
   `surface: "grok"` is a **best-effort attribution tag** for dashboard bucketing, not
   a security boundary. The criterion must assert "a request carrying the header is
   labelled grok", never "only real Grok turns are labelled grok". False positives are
   acceptable for a usage tag; they are NOT acceptable for auth or billing.

**Fix scope.** (a) widen `PersistedUsageEntry.surface` and `UsageSurface` with
`"grok"` and an explicit `"codex"` predicate that excludes `claude-desktop`; (b) update
BOTH serializers and `parseUsageSurface`; (c) keep historical unlabelled entries in the
legacy `codex` bucket (no retroactive relabel); (d) add a dedicated
`x-opencodex-grok: 1` header to the fence and read it in `handleChatCompletions` to set
`surface: "grok"`; (e) add the `grok` filter tag + icon.

## D4 — context shows `200k` for models that are larger

**Reviewer blocker 4 (accepted — my root cause was false).** I claimed nothing is set
to `200_000` except `AUTO_CONTEXT_FLOOR` and a fixture, so a displayed `200k` must be a
blank. Wrong on both counts. Real provider metadata pins `200_000`:

- `ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS["claude-sonnet-4-6"] = 200_000`
  (`src/providers/antigravity-models.ts:100`);
- Kiro: `claude-opus-4.5`, `claude-sonnet-4.5`, `claude-sonnet-4.0`, `claude-haiku-4.5`,
  `glm-5`, `minimax-m2.5`, `minimax-m2.1` all `= 200_000`
  (`src/providers/kiro-models.ts:36-44`);
- Kimi: `k3` = `262_144` and `k3[1m]` = `1_048_576`
  (constants `KIMI_K3_STANDARD_CONTEXT_WINDOW` / `KIMI_K3_1M_CONTEXT_WINDOW` at
  `src/providers/registry.ts:266-268`, assigned per model at `:313-315`);
- and `AUTO_CONTEXT_FLOOR = 200_000` (`src/claude/context-windows.ts:19`).

An absent window produces `null` and is omitted by `{context && ...}` — it cannot render
as `200k`. So a displayed `200k` is a REAL value. I could not identify the user's
specific 200k route from the live API (no `native/` or `gpt-` route returned 200_000),
so **D4 splits**: D1a/D1b ship the formatting + native-window fixes, and the `context
unknown` display for blank windows ships as a genuine UX improvement — NOT as the
explanation for a displayed `200k`. If the user can name the route showing 200k, that
is a separate per-route metadata correction at its provider source.

## What each fix is and is not (corrected)

| Defect | Is | Is not |
|--------|----|--------|
| D1a | A rounding/format fix in two `formatContext*` helpers | A data problem — catalog values are correct |
| D1b | Pass an existing accessor into the DTO AND every desktop-3p writer path (apply, auto-apply, CLI) | A new metadata source |
| D1c | Surface existing `supports1m` as a read-only chip | A toggle yet — the profile has no preference field (follow-up) |
| D2 | Label normalization + a write-path schema guard | A request-path guard (already exists); a `[1m]` name leak (names are hashed) |
| D3 | Fix the codex bucket swallowing claude-desktop, widen surfaces, label Grok via a dedicated header | Just widening a TS union (serializers drop it); attribution from a static fence key |
| D4 | A `context unknown` display for blanks + per-route metadata fix if a specific model is named | A display patch for a real 200k constant |

## Fix work-phase map (corrected scope)

| WP | Slice | Depends on |
|----|-------|------------|
| WP6 | D1a+D1b: formatting + native windows (DTO AND the desktop-3p writer path) + `context unknown` display | — |
| WP7 | D1c: surface `supports1m` on the DTO + read-only 1M chip (toggle deferred) | WP6 |
| WP8 | D3: fix codex bucket, widen surface taxonomy, label Grok via dedicated header, add tag | — |
| WP9 | D2: label normalization + Desktop 3P output schema guard | — |

Each gets a diff-level decade doc (`060`-`090`) before implementation.
