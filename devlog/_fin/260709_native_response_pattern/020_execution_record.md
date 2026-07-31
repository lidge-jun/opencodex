# Execution record (2026-07-09)

## Shipped
- src/bridge.ts: `hiddenRawReasoningText` + `flushHiddenRawReasoning()` (txt-only ocxr1 envelope
  via direct encodeReasoningEnvelope); hidden guard in `reasoning_raw_delta`; flush wired at all
  8 closeCurrentRawReasoning barriers + stream catch path; non-streaming flushRawReasoning hidden
  branch. Visible mode (summary "auto") unchanged.
- tests/bridge-raw-reasoning-hidden.test.ts (6 activation tests incl thrown-stream flush and
  preserve-model replay round-trip).
- structure/04_transports-and-sidecars.md: "Reasoning display parity" SoT section.

## Evidence
- Audit rounds: plan audit (Euclid, gpt-5.5) GO-WITH-FIXES(2) -> both folded (barrier+catch
  coverage; txt-only envelope path). Final fresh review (Dirac, gpt-5.5): PASS, zero blockers,
  incl. GLM->Claude thread-switch replay safety and passthrough scrub coverage.
- Gates: bun test 1724 pass / 0 fail (175 files); tsc --noEmit exit 0.
- Live probe (temp dev instance :10199, glm-5.2, summary none): zero reasoning_text.delta;
  envelope-only reasoning item (txt decodes to the model chain-of-thought); two function_call
  items; response.completed. Wire shape = native pattern.

## LOOP-PESSIMIST-01 (not proven / residual)
- Desktop-app visual grouping is client-side and closed-source; wire parity is proven, the
  visual confirmation needs the USER to restart the Codex app (stale in-memory model info from
  before the catalog flip) + restart ocx (running proxy predates this unit) + open a fresh
  thread on glm-5.2/grok-4.5.
- If the user later opts into visible thinking (summary "auto"), raw reasoning becomes visible
  again and will split cells - by design (native semantics).
- Kiro thinking replay unchanged (kiro adapter drops thinking parts on replay regardless).
