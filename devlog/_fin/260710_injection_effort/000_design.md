# 260710 — Sub-agent delegation reasoning-effort selector (injectionEffort)

## Decision (user request, 260710)

The Dashboard's "Sub-agent delegation" panel picks only a model (`injectionModel`)
to name in the v1 Proactive delegation prompt. Add a second selector for the
reasoning effort the delegated sub-agents should run at.

## Mechanism

codex-rs `spawn_agent` accepts a `reasoning_effort` argument and validates it by
catalog membership (`validate_spawn_agent_reasoning_effort`, see
devlog/260709_v2_gated_ultra). Since 260709 every reasoning-capable catalog entry
advertises `max`/`ultra` (mock top tiers) and the wire clamps unsupported rungs
(`nativeEffortClamp` / `clampToSupportedCodexEffort`), so any ladder value from
`CODEX_REASONING_LEVELS` (low..ultra) is safe to instruct.

The proxy therefore only needs to extend the delegation prompt: when both
`injectionModel` and `injectionEffort` are configured, `multiAgentGuidanceText`
appends

> A preferred sub-agent reasoning effort is also configured: "<effort>". Set the
> reasoning_effort argument of spawn_agent to exactly "<effort>" for those sub-agents.

Semantics guardrails:

- Effort WITHOUT a model changes nothing — the max/ultra effort gate and the base
  prompt stay exactly as before (the gate relaxation remains model-opt-in only).
- Clearing the model clears the effort (it is meaningless alone).
- API rejects non-ladder efforts with 400; `effort` key absent in PUT means
  "unchanged" so old GUIs keep working.

## Files touched

- `src/types.ts` — `OcxConfig.injectionEffort?: string`.
- `src/reasoning-effort.ts` — exported `isCodexReasoningEffort()`.
- `src/server/management-api.ts` — GET `/api/injection-model` now returns
  `{ model, effort, efforts, available }`; PUT accepts `{ model, effort }` with the
  validation/clearing rules above.
- `src/server/responses.ts` — `multiAgentGuidanceText(parsed, model?, effort?)` +
  call site passes `config.injectionEffort`.
- `gui/src/pages/Dashboard.tsx` — second `Select` in the delegation panel (shown
  only while a model is chosen), saving via the same PUT.
- `gui/src/i18n/{en,ko,zh}.ts` — `dash.injectionEffortLabel` ("Reasoning effort" /
  "추론 강도" / "推理强度"), `dash.injectionEffortNone` ("Model default" / "모델
  기본값" / "模型默认").
- `tests/multi-agent-compat.test.ts` — +3 prompt tests (effort named; absent when
  unset; effort-alone keeps the gate).
- `tests/injection-model-api.test.ts` — NEW, 5 tests for the PUT/GET roundtrip and
  clearing/validation rules (isolated `OPENCODEX_HOME`).

## Verification (260710)

- Baseline before edits: `bun test` — 1816 pass, 0 fail (183 files).
- After: `bun test` — 1824 pass, 0 fail (184 files); +8 = exactly the new tests.
- `bunx tsc --noEmit` — clean (exit 0).
- `cd gui && bun run build` — vite build OK (`✓ built in 92ms`).
- Rendered prompt assertion (multi-agent-compat):
  `reasoning_effort argument of spawn_agent to exactly "xhigh"` present when
  model+effort configured; `reasoning_effort` absent otherwise.

Live note: the running proxy (v2.7.1-preview, port 10100) predates this change;
the new fields appear after the next `ocx restart`. No restart was performed here
because live sub-agent traffic (gpt-5.6-sol) was in flight.
