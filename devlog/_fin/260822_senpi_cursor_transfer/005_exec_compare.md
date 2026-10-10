# 005 — Exec / interactionQuery / tool pairing

Hypatia + Plato + Pasteur.

## Architecture mismatch (do not ignore)

senpi is a **host**. Exec frames map onto senpi tools via `CursorExecHandlers`, then the agent loop skips `kCursorExecResolved` blocks ([cursor-exec-bridge.ts L1-16](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/coding-agent/src/core/cursor-exec-bridge.ts#L1-L16), [block-symbols.ts L40-49](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/utils/block-symbols.ts#L40-L49)).

OpenCodex is a **Responses proxy**. Exec either runs locally inside the adapter (only if `nativeLocalExec: "on"`) or is rejected. Codex-owned tools travel as `opencodex-responses` MCP and are **not** executed on the exec channel (`live-transport.ts:226-246`). Copying senpi's host-tool bridge would invert OpenCodex's trust model.

## Frames

OpenCodex known cases end at `writeShellStdinArgs` (`gen/agent_pb.ts:6886+`). Dispatcher `native-exec.ts:550-609`. Default policy off (`exec-policy.ts:17-44`).

senpi additionally dispatches Pi family 45–51 and answers newer oneofs with typed refusals (mcpState, hooks, subagents, canvas, conversation search). Unknown/unset: `ExecClientThrow` + `streamClose` ([cursor-agent.ts L1288-1316](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L1288-L1316)). OpenCodex unknown: empty `[]` (`native-exec.ts:605-609`, #116). That is the stall class senpi refused.

OpenCodex-only: real background shell / fetch / optional computer-use when native exec is on. senpi refuses those.

## interactionQuery

OpenCodex answers immediately (`live-transport.ts:287-382, 1256-1269`): createPlan success; ask/switch reject; web/exa approve; setupVm + unknown empty. senpi has **no** interactionQuery branch ([cursor-agent.ts L922-946](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L922-L946), issue #1026). Do not copy senpi here.

## Pairing / double-exec

OpenCodex: `local_side_effect` before native exec (`live-transport.ts:1248-1252`); `completedToolCalls` for Responses mapper idempotency (`protobuf-events.ts:1052-1056`). senpi: `kCursorExecResolved` so the **agent loop** does not re-run host tools. Different layer. Only needed if OpenCodex starts synthesizing native exec as Codex-visible tool calls.

## Transfer suspicion

High: unknown-exec typed reply + stream-close (without enabling local fs). Medium: proto refresh to name Pi/mcpState/hook frames **as typed refusals**, not as implementations. Reject: host-tool bridge, enabling nativeLocalExec by default, copying senpi's missing interactionQuery.
