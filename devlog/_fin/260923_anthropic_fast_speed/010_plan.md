# Anthropic fast mode (`speed: "fast"`) as a native FastWire — plan (wp1)

## Loop spec (HOTL wp1)

- Scope: user asked to verify Claude fast mode over the Anthropic OAuth token, research pricing in the Claude docs via Aside, check the other Claude OAuth models, bind it natively the way the xAI Grok OAuth fast lane was bound, and open a PR. Unlimited gpt-6-sol subagents granted.
- Write scope: branch `codex/anthropic-fast-speed` in this worktree. No merge, release, service restart, or live config edit.
- Certification: focused local tests plus exact-head hosted CI on the PR.

## Evidence

- Live probe matrix: [020_probe-evidence.md](020_probe-evidence.md).
- Official contract (Aside, 2026-09-23): platform.claude.com/docs/en/build-with-claude/fast-mode, /about-claude/pricing, code.claude.com/docs/en/fast-mode. Request `speed: "fast"` + `anthropic-beta: fast-mode-2026-02-01`; echo `usage.speed` ("fast" | "standard"); supported models exactly `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`; Opus 4.6 silently runs standard; fast price is 2x standard input/output with cache multipliers applied to fast input (Opus 5.5 8/40, Opus 5 and 4.8 10/50). Fast has its own rate-limit pool; 429 on fast exhaustion, 529 on capacity. The API does not fall back; Claude Code retries a rejected fast request at standard speed. Subscription fast (Pro/Max/Team/Enterprise) draws on usage credits.

## Decisions

- D1 Wire: `FAST_WIRE_ADAPTERS["anthropic-speed"]` = {"anthropic"}. `service-tier` stays OpenAI-only.
- D2 Registry: `anthropic` (OAuth) and `anthropic-apikey` declare `fastWire: {kind:"anthropic-speed", canonicalToWire:{priority:"fast"}, foreignCallerTiers:"drop", betas:["fast-mode-2026-02-01"]}` and `modelSupportsServiceTier` for the three documented ids. No provider-wide `supportsServiceTier`; Opus 4.6/4.7, Sonnet, Haiku, Fable and future ids stay unclassified. OAuth is included because the probe shows the OAuth lane accepts the field and gates only on account entitlement (usage credits / org enablement), which is the documented Claude Code subscription path.
- D3 Adapter request: on a `set` decision whose value is the declared wire value, emit `body.speed` and add the declared betas to the single `anthropic-beta` header per D3a. Adapter owns `tierLog` with wireKind `anthropic-speed`.
- D4 Adapter response: observe `usage.speed` from `message_start` / `message_delta` (stream) and the buffered body. "fast" confirms, "standard" downgrades (`response-declined`), absent leaves `assumed`.
- D5 Refusal downgrade (final, after reflection 030 and audit 040). Recognition is narrow: status 400 or 429 whose Anthropic error message names fast mode or the `speed` parameter (probe strings: `Usage credits are required for fast mode.`, `Fast mode is not enabled for your organization`, and "does not support the `speed` parameter"), or a 429 carrying `anthropic-fast-input-tokens-remaining: 0` or `anthropic-fast-output-tokens-remaining: 0`. Generic 429/529 keep today's path. The body is read from a bounded clone, so the original refusal survives if the resend is not admitted.
  - Scope is the main adapter recovery loop in `src/server/responses/adapter-dispatch.ts`: one arm after the 401 arms and before the same-target 429 wait and key/OAuth rotation, guarded once per request. Before touching the response it reserves the resend with `reserveCredentialHop("repair", "<provider>|<model>|anthropic-fast-downgrade", countedExternally)` exactly as the generic OAuth 429 arm does (`countedExternally` true only on a helper-reported transient-policy leg); a refused reservation leaves the original refusal untouched and falls through. The permit rides `sendBudgetState.pendingHopPermit`, is confirmed with `permit.use()` in `rebuildAndRefetch`'s `onDispatch`, and is released on any pre-send failure. It replaces `parsed.options.tierDecision` with `drop`, marks `parsed.options.tierObservation.upstreamDeclinedFast = true`, invalidates the same-target cache, and calls `rebuildAndRefetch("anthropic-fast-downgrade")`. The refused response never reaches rotation or cooldown.
  - No process memo. The decision lives on the request, so every later build of the same request (refetches, tool continuations, sidecar iterations that reuse the parsed options) stays standard, and credential rotation or token refresh cannot lose it. Each new turn pays one refused round trip, as Claude Code does.
  - `createAdapterTierMetadata` reports `downgraded` / `response-declined` when the observation carries `upstreamDeclinedFast`, instead of `wire-unavailable`.
  - The resend is a visible, paced, attempt-logged send with its recovery kind and a real request-budget charge. A dispatched resend also charges the root workflow once; a refused pre-send reservation does not. Tests pin workflow exhaustion and that a spent request budget returns the original refusal.
  - New recovery kind `anthropic-fast-downgrade`: roster, cause `parameter-rejected`, status-confirmed 400 mapping, metrics class `fast_downgrade` (additive, via a kind override so `effort_downgrade` keeps meaning reasoning effort), dashboard log label in all ten locales.
  - A first fast send that is refused inside a continuation or sidecar owner (not the main dispatch) keeps today's handling (residual).
- D3a Header merge: provider header overrides are merged case-insensitively into a single `anthropic-beta` with deduped tokens; OAuth betas are preserved; the fast beta is appended after overrides whenever `speed` is emitted, so `speed` is never sent without it.
- D6 Pricing: `PRIORITY_PRICING_RULES` gains 2x rules with `requiresResponseConfirmation` for the three models on `anthropic` and `anthropic-apikey`. Unconfirmed or downgraded turns keep standard price.
- D7 Picker: `--fast` rows follow the existing eligibility predicate; no new listing code.
- D8 Docs/SoT: structure owners (providers-and-adapters, transports/responses, gui-and-management-api cost note) and the stale comment in `src/server/claude-messages.ts`.

## Acceptance criteria

- C1 `fastPolicyForModel` is `eligible` for the three ids on both registry entries; Opus 4.6, Sonnet 5 and Haiku stay unclassified; `fastWire: null` still disables.
- C2 Adapter emits speed + beta only on a set decision; drop/default emits neither; header merge keeps the OAuth betas.
- C3 Stream and buffered echo map to confirmed / downgraded / assumed.
- C4 In the main dispatch loop a recognized fast refusal is replaced by exactly one visible standard resend (recovery kind recorded), never on a standard send, never twice, never for a generic 429/529; later builds of the same request stay standard; the outcome is downgraded/response-declined and priced 1x.
- C5 Confirmed fast turns price at 2x; standard echo or fallback stays 1x.
- C6 Existing pins that flip are rewritten deliberately (fastwire-policy anthropic-speed wire-unavailable, registry roster of explicit FastWire entries).
- C7 Focused tests, typecheck, ratchet/layout, structure:check, privacy:scan pass; PR open with template; exact-head CI inspected.

## Residuals

- Each new turn on an account without fast entitlement pays one refused round trip (about 400 ms) before the standard resend. Operators disable with `fastMode: false` or by not selecting `--fast`.
- A refused first fast send inside a continuation or sidecar owner, Claude Messages native passthrough (caller auth, raw caller `speed`), and the Anthropic web-search provider sidecar keep today's handling.
- None of the user's six OAuth accounts can currently run fast (four lack usage credits, two orgs have it disabled), so a confirmed `usage.speed: "fast"` echo is proven from the docs, not from a live 200.
