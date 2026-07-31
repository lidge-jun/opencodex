# 95 — Verification matrix (for the future implementation cycle)

| Change | Surface | Risk | Verification | Evidence |
|---|---|---|---|---|
| Streaming reroute | bridge.ts reasoning_raw_delta → summary path | LOW | bridge.test.ts: summary_text delta present + final summary[] non-empty | tests/bridge.test.ts |
| Non-streaming reroute | bridge.ts flush path | LOW | non-stream replay → reasoning item summary[] non-empty | tests/bridge.test.ts |
| hideThinkingSummary parity | both paths | LOW | with flag → no summary item | tests/bridge.test.ts |
| Regression | thinking_delta + usage | LOW | existing tests still green | bun test tests/bridge.test.ts |
| Typecheck | whole repo | LOW | bun x tsc --noEmit exit 0 | tsc |
| Manual | reasoning-capable chat provider | MED | Codex app expands the trace | runtime screenshot |

## Gates
- `bun test tests/bridge.test.ts` green; `bun x tsc --noEmit` clean.
- Atomic commit; doc-only this cycle (no code).
- Confirm sub-case B (no reasoning_content) documented as model limitation.
