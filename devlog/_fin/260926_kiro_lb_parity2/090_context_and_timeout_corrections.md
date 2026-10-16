# 090 — Context-window and timeout corrections after the head-to-head

Work phase wp10. Branch `codex/kiro-lb2-081-corrections` from dev `5518653a9a`. This is the single
executable plan (rewritten after audit; no later section overrides it).

## Evidence

- **C3 static window.** Kiro's model page (https://kiro.dev/docs/models/, fetched 2026-09-27; the page's
  dateModified is 2026-09-25) lists GPT-5.6 Sol, Terra and Luna with a **1M** context window and states
  two-tier pricing: requests up to 272K tokens bill at the listed rate, larger requests at double. Our
  static table (`src/providers/kiro-models.ts:31-38`, cited as "page updated 2026-07-14") records 272K for
  the three GPT-5.6 tiers. `gpt-6-sol`/`gpt-6-luna` are not on Kiro's page and are unchanged.
- **E6 timeouts.** The Kiro header deadline is applied at `src/adapters/kiro-retry.ts:191` (020), and
  body inactivity is bounded for every adapter stream — initial stream `src/server/responses/adapter-delivery.ts:79-99`,
  continuation legs `src/server/responses/adapter-continuation.ts:666-687` — each mapping a stall to 504.
  Verdict: **equivalent bound**. Difference recorded: our header deadline covers connect plus waiting for the
  first byte; kiro-lb's connect timeout covers connect alone.

## Consumers of `KIRO_MODEL_CONTEXT_WINDOWS` and what changes

- Registry seed `src/providers/registry/entries-core.ts:610` → routed catalogue, Codex sync, Claude context windows.
- `kiroObservedContextWindow` (`src/providers/kiro-model-catalog.ts:140`) → static floor for the **minimum
  observed window across live accounts**; that shared minimum feeds catalogue display, the adapter's
  context-percentage conversion and calibration, and request-log estimate capping.
- `kiroUpstreamContextWindow` (`src/adapters/kiro/usage.ts:224`) → adapter `contextWindow`
  (`adapter.ts:292`, `stream.ts:630`); `stream.ts:366-367` computes
  `contextTotalTokens = window × contextUsagePercentage`, so reported context tokens for a GPT-5.6 turn
  scale with the window.
- `request-log.ts:1634` → estimated-token cap.

## Change map

| Path | Change |
|---|---|
| `src/providers/kiro-models.ts` | MODIFY: citation updated to the 2026-09-25 page; `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` → `1_000_000`; one comment noting the 272K pricing threshold. |
| `tests/providers/kiro/kiro-adapter.test.ts` (capped 2050) | MODIFY, net −3 lines: append the three GPT-5.6 ids to the 1M loop list (line ~1770) and delete the three `272_000` expectations (lines ~1778-1780). |
| `devlog/_fin/260926_kiro_lb_parity2/081_head_to_head_result.md` | MODIFY: C3 → parity (static 1M now matches Kiro's page and kiro-lb; observed catalogue evidence still preferred); E6 → equivalent bound, anchors above, tests `tests/server/terminal-guard-server.test.ts` "a stalled initial body fails with a 504 upstream error instead of a proxy error" and "a stalled continuation body reports 504 even when cancelling it aborts the client signal", plus `tests/providers/kiro/kiro-transport-parity.test.ts` "header deadline becomes 504 without rotating; caller abort preserves its reason"; remove both from "Where kiro-lb still leads". |
| docs-site | **No change**: no page states a Kiro GPT-5.6 window (the 272K mentions are the native Cursor guide). |

## Risks

- **Billing:** a client that plans against the larger window may send >272K-token Kiro GPT-5.6 requests,
  which Kiro bills at double. The per-provider context cap only lowers the window clients plan against; it is
  a planning aid, not a hard upstream limit or a billing guarantee. This is Kiro's published contract and
  matches kiro-lb.
- **Context accounting:** correct if Kiro's `contextUsagePercentage` is relative to its documented 1M window;
  not verified live. The observed minimum across accounts still overrides the static value when present.

## Verifiers

`bun run typecheck`; `bun test tests/providers/kiro/` (includes `kiro-adapter`, `kiro-stream` context
calibration, `kiro-model-catalog`); `tests/server/terminal-guard-server.test.ts`;
`tests/usage/request-log-estimate-cap.test.ts`; `tests/ci-workflows/file-size-ratchet.test.ts`;
`bun run privacy:scan`; `bun run structure:check`; the 081 mechanical check. Hosted CI on the PR head.

