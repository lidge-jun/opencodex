# 261009 Claude surfaces: 1M by default, 200k as an opt-in

## Summary

Long-window models routed to Claude surfaces are accounted at 200k even when their real window is
872,000. The Desktop Code-tab picker shows `GPT 6 Astra (native)`, `GPT 6 Luna (native)` and
`GPT 6.1 Sol (native)` without the `[1m]` selector, so Claude Code (2.1.288) falls back to its 200k
default for them, although the live picker snapshot already carries `contextWindow: 872000`. The
launch path (`ocx claude`) marks the same models because it also injects
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`; surfaces whose runner does not inherit that variable mark only
windows of 1M or more.

This unit makes every Claude surface that picks a default (Desktop picker, `cc` picker, launch env
slots, Desktop 3P, generated subagents) mark a long window (>= 829,800) as 1M by default, offers a
`· 1M` row for it in discovery, adds the
recovery that makes this safe where the compaction variable is absent, and adds an explicit 200k
opt-in. It is delivered as a manual PR chain on `dev`, one layer per work-phase.

## Loop spec

- Class: C3 (cross-module Claude surface behavior, public config/API/CLI field; no auth, no persistence migration).
- Loop archetype: satisfy-spec, multi-cycle (wp0 docs, wp1..wp4 implementation).
- Trigger: user request 2026-10-09 (Desktop picker shows Astra/K3 as 200k; make 1M the default, 200k opt-in in GUI/CLI; stacked PRs; Sol agents as verifiers only).
- Goal: session eb6a39f9-d450-4b3e-8f06-60c43022f3cf, goalplan `claude-surfaces-claude-code-launch-discovery-des`.
- Non-goals: changing the Codex native window defaults (272,000 / 872,000 opt-in stays a Codex catalog decision); the Anthropic beta allowlist; writing the user's `~/.claude/settings.json` env; windows below 829,800 (K3 bare 262,144, Grok 256,000, Devin 262,000 stay 200k-accounted because the compaction floor cannot sit under their real window).
- Verifier per layer: `bun run typecheck`, the focused test files named in each decade doc, `bun run structure:check`; full suite and cross-platform shards are left to exact-head GitHub CI (local full runs are excluded for this repository per the maintainer's standing instruction).
- Stop condition: wp4 PR opened with its CI observed, or a blocker reported.
- Memory artifact: this unit (000 roadmap, 010..040 phase docs, per-phase audit/done notes).
- Expected outcomes: DONE when the four layers are open with templates filled and typecheck green locally; BLOCKED when CI on a layer fails for a cause outside the layer.
- Escalation: Sol agents act as architect, auditors and reviewers only; main writes all code. A slice is reclaimed after two failed reviewer rounds on the same finding.
- Resource bounds: no token or wall-clock budget was set by the user; tool scope is local repo, `gh` on `lidge-jun/opencodex`, read-only inspection of the installed Claude Code binary.

## Evidence

| Fact | Source |
|---|---|
| Claude Code context window: `[1m]` -> 1e6; declared knowledge windows > 200k clamp to 200k unless native 1M; otherwise `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (non-claude ids) else 200k | Claude Code 2.1.288 binary, functions `vv`, `I5r`, `Kd`, `yv` (strings at `~/.local/share/claude/versions/2.1.288`) |
| Claude Code classifies `prompt_too_long` when the error message includes `prompt is too long` or `input is too long for requested model`; parses `prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)` for the gap; runs reactive compaction | same binary, functions `b4n`, `fdt`, `mDt`; strings `Reactive compact: ...`, `tengu_reactive_compact_triggered` |
| Embedded gateway contract: relay a 400/413 Anthropic envelope like `prompt is too long: ...`; "the client's recovery (auto-compact etc.) keys on it" | same binary, embedded "Claude Code gateway protocol" text |
| opencodex emits `context_length_exceeded` with upstream text or `PROVIDER_INPUT_TOO_LARGE_MESSAGE` | `src/claude/outbound.ts:73`, `src/server/claude-messages.ts:1338-1386`, `src/server/responses/context-overflow.ts:5` |
| Desktop picker marks only >= 1M because Desktop runners do not inherit the compaction env | `src/claude/intercept/picker-models.ts:51-54` |
| Live picker snapshot: Astra/Luna/Sol 6.1 `contextWindow: 872000` unmarked; `K3 1M (kimi)` already `[1m]` | `~/.opencodex/claude-intercept/cli-picker-models.json` (local, not committed) |
| Discovery 1M variant requires >= 1M; `auto` passed but unused | `src/claude/model-info.ts:150-176`, `src/server/index/serve-options.ts:1053` |
| Desktop 3P `supports1m` threshold 1M in three owners | `src/claude/desktop-3p.ts:63,254`, `src/claude/desktop-profile.ts:362`, `src/server/management/shared.ts:417` |
| Brackets: Desktop 3P names are hashed `claude-opus-4-8-*` aliases; `k3[1m]` already round-trips | `src/claude/desktop-3p.ts:122-161`, `src/claude/desktop-3p-guard.ts:11-32` |

## Architect consultation

Architect: gpt-6.1-sol subagent, read-only, proposal D1-D7 (session transcript). Dispositions:

| ID | Proposal | Disposition |
|---|---|---|
| D1 | Normalize at `anthropicErrorBody`; keep recognized text; numbers only when parsed | ACCEPT. Folded the missed lane: `messages-native.ts:901` drops `classified.code`, so 010 rewrites its message without changing the native envelope shape |
| D2 | Pure leaf `long-context.ts`; Desktop/profile/context-windows depend inward | ACCEPT |
| D3 | Discovery emits the unmarked base row first, so variants do not make 1M "the default" | REBUT for discovery: the `/v1/models` list is an explicit choice list and Claude Code shows both rows; the default selection on Claude surfaces is the picker row (one row per model, now marked) and the launch env slot. ACCEPT the ceiling point: variants keep reporting `min(1e6, max input)` |
| D4 | Sparse persistence, `"1m"` deletes, reject others; typed `[1m]` survives; 200k disables compact injection too; precedence over autoContext | ACCEPT, written into 030 |
| D5 | Full field chain incl. system-env reconcile list, picker inputs, GUI normalization, refresh | ACCEPT. Chain table in 030; GUI normalization and manual-env export in 040 |
| D6 | Exact-text tests and ratchet headroom | ACCEPT; tests in 010/020, headroom table below |
| D7 | structure/ ownership, docs-site guide, CLI capability registries, anthropic2 | ACCEPT. `isAnthropicInstanceId` replaces `provider === "anthropic"` in the new predicate and the discovery mode choice; capability registries + `skill:surface` in 030 |

## Work-phase map (dependency order)

| wp | Layer | Doc | Depends on | Branch |
|---|---|---|---|---|
| wp0 | Roadmap (this unit) | 000 | - | committed as the first commit of wp1's branch |
| wp1 | Overflow envelope `prompt is too long` (safety net) | 010 | wp0 | `claude/1m-01-prompt-too-long` -> `dev` |
| wp2 | Long-window eligibility on every Claude surface | 020 | wp1 | `claude/1m-02-long-context` -> wp1 |
| wp3 | `claudeCode.contextAccounting: "200k"` opt-in (config, launch, surfaces, API, CLI) | 030 | wp2 | `claude/1m-03-context-accounting` -> wp2 |
| wp4 | Dashboard control + locales | 040 | wp3 | `claude/1m-04-context-accounting-gui` -> wp3 |

wp1 goes first because wp2 widens marking onto runners that may lack the compaction variable; the
recovery has to exist before the widening ships. wp3 consumes wp2's single marking mode. wp4 only
renders wp3's field.

## Ratchet headroom

Universal cap: a file outside `tests/fixtures/file-size-baseline.json` fails at 2000 lines. Files
this unit grows: `tests/claude-integration/claude-outbound.test.ts` 1936 (edit in place only, no
new cases there), `src/server/management/agent-settings-routes.ts` 1858, `src/server/claude-messages.ts`
1730, `src/types/config.ts` 1733, `src/claude/outbound.ts` 1103; none is in the baseline. New cases
go into new sibling test files. All eleven locale catalogs are exempt.

## Source-of-truth sync

`structure/` owner docs (checked by `bun run structure:check`) are updated in the layer that changes
the behavior they describe: `structure/runtime.md` and `structure/clients/claude-desktop.md`, the
owners of `src/claude/` per `structure/INDEX.md:126` (wp1, wp2), and the config /
management owners for the new `claudeCode` key and `/api/claude-code` field (wp3). Each layer's P
resolves the exact owner file from `structure/INDEX.md`. The user-facing docs-site Claude Code page is updated
in wp3 (new CLI flag and config key).

## Architect reflection (round 1: MISALIGNED, folded)

| Gap | Fold |
|---|---|
| D1 regex took any later count | 010: counts need `resulted in` / `you requested`; otherwise prefix only |
| D2 discovery followed a custom compact window | 020: discovery uses the fixed unpaired rule; `auto` only switches it off |
| D3 base/Fast rows still 200k; sub-1M variant advertised 1e6 | 000 summary + 020 scope note; variant advertises `min(1e6, max input ?? window)` |
| D5 roster/self subagent sites; GUI cache | 030 adds `agents-inject.ts:100,133` via `subagentMarkingMode`; 040 explains the normalizer covers cached reads and `EDITABLE_KEYS` |
| D6 headroom table missing | added above |
| D7 config/management SoT owners | added above |

## Architect reflection (round 2: MISALIGNED, folded)

| Gap | Fold |
|---|---|
| GUI cached state bypasses the GET normalizer | 040: normalize in `normalizeFirstPartyState` (`ClaudeCode.tsx:37`), shared by cache (`:115`) and GET (`:153`); test with an older cached state |
| `200k` would strip explicit `[1m]` subagent selectors | 030: explicit markers follow the unpaired safety rule regardless of mode; mode governs unmarked selectors only; precedence tests for roster/self/force |

## Independent audit (round 1: FAIL, synthesized)

| Blocker | Disposition |
|---|---|
| 1 native Messages lanes | Pre-stream HTTP folded (010). Classifier widening and native SSE frame rewrite REBUTTED as out of scope with reason in 010 (Codex-shared classifier; no native-lane route crosses the 1M line in this unit); residual recorded |
| 2 roster/self subagents ignore 200k | Already folded after architect reflection (030 `subagentMarkingMode`, explicit-marker rule) |
| 3 Desktop option chain | Folded: option threads through `generateDesktop3pConfig`; writer derives it from the re-read config; remote export endpoint added (030) |
| 4 Pool 2 guard | Folded: pickers and `buildClaudeContextWindows` use `isAnthropicInstanceId` (020) |
| 5 discovery floor / ceiling | Already folded (020 `variantMode`, ceiling from window) |
| 6 boundary tests | Folded: 999,999 cases rewritten to 829,799 / 829,800 (020) |
| notes | GUI test paths, i18n parity tests, structure owners named |

## Independent audit (round 2: FAIL on B1 only, folded)

B1 rebuttal withdrawn: a custom `anthropic`-adapter provider reaches the native lane with any
window, so wp2 can widen a native route. 010 now normalizes the native lane locally (HTTP with
upstream `code` and a local wording test, streaming via the existing SSE payload rewriter for
non-Anthropic-instance providers, collected-stream errors -> 400), leaving the Codex-shared
`classifyError` untouched. Regression with a custom provider and unfamiliar wording added.

## Independent audit (round 3): PASS

Notes folded into 010: gate the SSE rewrite on `nativeInstance` (`messages-native.ts:309-310`), not
on the provider name; place it after `echoRequestedModel` before the stream/collect split; add a
413 case and an SSE `rate_limit_error` negative; the superseded HTTP-only snippet was removed.
