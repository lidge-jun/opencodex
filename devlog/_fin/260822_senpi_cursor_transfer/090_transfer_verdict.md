# 090 — Transfer verdict

Locked from explorer reports + local reads. senpi `a5eed44536f3024c5740dc3dfff4ffe0bb08b717`. No production code in this cycle.

Class keys: ADOPT (port the mechanism), ADAPT (same idea, OpenCodex-shaped), REJECT (wrong product/trust model), ALREADY-HAVE, NEEDS_HUMAN (policy), UNSAFE (do not recommend).

## Table

| ID | Mechanism | Class | OpenCodex owner | senpi source | Residual risk |
|---|---|---|---|---|---|
| T01 | Bare 0-token `resource_exhausted` mapped as 429 | **ADAPT** | `src/adapters/cursor/cursor-errors.ts:131-163`, `src/lib/errors.ts`, `tests/cursor-errors.test.ts:15-17` | [overflow.ts L211-222](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/utils/overflow.ts#L211-L222), issues #1009/#1036 | Must not reclassify quota RE as overflow. Codex compact must actually fire; if not, remint is a second step. |
| T02 | Surface-first then rotate conversationId | **ADAPT** | `src/adapters/cursor.ts:231-247` (today only external invalid_argument) | [cursor-conversation-rotation.ts L34-46](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-conversation-rotation.ts#L34-L46) | Do not persist unbounded maps. Cap + migrate usage cache via existing `rekey`. |
| T03 | Close HTTP/2 on `turnEnded` after exec drain | **ADOPT** | `src/adapters/cursor/live-transport.ts:1132-1154`, `protobuf-events.ts:1327-1328` | [cursor-agent.ts L249-254, L698-704](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L249-L254) PR #1062 | Must preserve Responses client-tool path that **intentionally** ends without turnEnded (`live-transport.ts:203-206`). |
| T04 | Adapter heartbeat-only stall fail (30s/90s) | **ADAPT** | `live-transport.ts:92-93` first-frame only; `src/stall-timeout.ts:8` 300s | [cursor-agent.ts L592-610](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L592-L610) | Do not fight synthetic progress heartbeats that keep the bridge alive. Scope to inbound-frame silence, not "no assistant text". |
| T05 | Unknown exec empty `[]` vs throw+close | **ADAPT** | `native-exec.ts:605-609` | [cursor-agent.ts L1288-1316](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L1288-L1316) | Empty reply was the #116 stream-kill fix. Prefer typed `ExecClientThrow` + stream-close **without** re-throwing into `failAndClear`. Live stall vs empty is unverified. |
| T06 | Live `GetUsableModels.maxMode` on the wire | **ADAPT** | `live-models.ts:115-131` decode keeps ids only; `gen/agent_pb.ts:2617` is catalog `ModelDetails.maxMode`; wire field is `RequestedModel.maxMode` at `gen/agent_pb.ts:2665-2667`; hardcode `protobuf-request.ts:963-966` | [reasoning-params.ts L8-20](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent/reasoning-params.ts#L8-L20) | Product: 1M windows / quota. Needs a live probe before claiming user-visible gain. Keep static seed + auto router ids. |
| T07 | OAuth poll fail-fast 400/401/403/410 | **ADAPT** | `src/oauth/cursor.ts:121-148` | [oauth/cursor.ts L165-178](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/auth/oauth/cursor.ts#L165-L178) PR #905 | Small. Keep OpenCodex refresh retry / JWT accountId. |
| T08 | Per-exec 3s heartbeat | **ADAPT** | `ExecClientHeartbeat` exists in `gen/agent_pb.ts`; stream-close bytes at `native-exec-common.ts:41-49`; no heartbeat writer in `native-exec.ts` | [exec-lifecycle.ts](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent/exec-lifecycle.ts) | Only if long native-exec stays enabled. Default native exec is off. |
| T09 | Billed turnEnded cacheRead 3× clamp | **ADAPT** (only with proto decode) | `TurnEndedUpdate` is `{}` `gen/agent_pb.ts:3083-3085` | [cursor-agent.ts L3516-3547](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L3516-L3547) PR #985 | Do not add billed fields without the clamp. Live wire unverified vs OCX client version. |
| T10 | Newer exec oneofs as typed refusals | **ADAPT** | `gen/agent_pb.ts:6886+` oneof ends at `writeShellStdinArgs`; dispatcher `native-exec.ts:550-609` | [cursor-agent.ts L1655-2010](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L1655-L2010) PR #910 | Proto regen is its own unit. Until then, T05 covers unknown frames. Do not implement Pi tools in the proxy. |
| T11 | Host-tool exec-bridge onto Codex tools | **REJECT** | `native-exec.ts` + `exec-policy.ts:17-44` fail-closed | [cursor-exec-bridge.ts L1-16](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/coding-agent/src/core/cursor-exec-bridge.ts#L1-L16) | Wrong architecture. OpenCodex already surfaces Responses tools; native fs default-off is the trust gate. |
| T12 | `cursor-agent` CLI fallback lane | **REJECT** (core) / **NEEDS_HUMAN** (optional product) | none; `src/oauth/cursor.ts:1-4` | [cursor-cli-oauth/AGENTS.md](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/AGENTS.md) PR #921 | Binary dep, `--force` spends Cursor tools outside Codex sandbox. |
| T13 | Fully dynamic catalog, drop static seed | **REJECT** | `discovery.ts:76-88` seed filter; `discovery.ts:90-104` router ids; `src/codex/catalog/provider-fetch.ts:1197` live gather | [providers/cursor.ts L10-17](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/providers/cursor.ts#L10-L17) | OpenCodex needs logged-out catalog and `auto-*` router models. T06 is the live-field adapt. |
| T14 | thinkingLevelMap / 204-id grouping | **REJECT** for now | `effort-map.ts:96-108` static tiers; `request-builder.ts:187-204` suffix flatten | [catalog-grouping.ts](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/cursor/catalog-grouping.ts) PR #948 | Codex picker already maps effort. Revisit only if live ids stop matching suffixes. |
| T15 | ANTML skip on cursor-agent | **ALREADY-HAVE** (by absence) | no ANTML in `src/` | [tool-call-middleware/index.ts L48-54](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/tool-call-middleware/index.ts#L48-L54) PR #1013 | Only if OCX later adds Claude-name text-tool recovery on Cursor models. |
| T16 | interactionQuery replies | **ALREADY-HAVE** (OpenCodex ahead) | `live-transport.ts:287-382` | missing; [#1026](https://github.com/code-yeongyu/senpi/issues/1026) | Do not copy senpi. |
| T17 | Absolute `usedTokens` cache | **ALREADY-HAVE** | `protobuf-events.ts:1233-1238` | [cursor-agent.ts L3566](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L3566) | Keep. |
| T18 | Compact isolation / skip mid-run compact | **ALREADY-HAVE** (different-shape) | `request-builder.ts:397, 443-444`; `responses/core.ts:2247-2249` | [agent-session.ts L1293-1296](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/coding-agent/src/core/agent-session.ts#L1293-L1296) #984 | Keep OCX isolated-conversation approach. |
| T19 | HTTP/1 RunSSE fallback | **ALREADY-HAVE** (OpenCodex-only) | `http1-bidi.ts:10-11` | [cursor-agent.ts L378-381](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L378-L381) | Keep. |
| T20 | Native-app / Safe Storage patching | **UNSAFE** | n/a | n/a | Out of scope. Prior ocx-cursor probe already forbade this. |
| T21 | Unofficial Cursor protocol ToS | **NEEDS_HUMAN** | whole adapter | whole provider | Both projects already ship it. No new disclosure in this unit. |
| T22 | Copy senpi protobuf / unbounded blob maps | **REJECT** | bounded KV/checkpoint (`native-exec.ts:81-92`, `checkpoint-store.ts:30`) | [cursor-agent.ts L314](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L314); [#1024](https://github.com/code-yeongyu/senpi/issues/1024) | Keep OCX bounds. |
| T23 | Overflow compact `keepRecentTokens: 0` | **REJECT** for adapter | Codex owns compact | [overflow.ts L244-251](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/utils/overflow.ts#L244-L251) | Only relevant if Codex compact keeps a large tail; that is a Codex-side setting, not ocx Cursor. |
| T24 | Fail EOF without `turnEnded` | **ADAPT** (careful) | `live-transport.ts:1147-1150` synthesizes done | [cursor-agent.ts L477-478](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L477-L478) | Conflicts with OCX client-tool suspend and some hardening tests. Fold into T03, do not land as a blanket fail. |

## Recommended later implementation order

Matches `000_plan.md` wp1–wp4:

1. T01 error mapping (highest user-visible: overflow vs 429).
2. T03 + T04 turn-end / stream health (protocol hang).
3. T05 unknown-exec typed reply; T10 only with a dedicated proto unit.
4. T06 maxMode + T07 poll fail-fast (catalog/auth polish).

Do not start T12. Do not start T11.

## Residual unknowns (not blockers for this research lock)

- Whether live `api2.cursor.sh` still emits billed `turnEnded` int64s against OCX client `cli-2026.07.08-0c04a8a`.
- Whether mapping 0-token RE to overflow/400 makes Codex auto-compact, or still needs remint (T02).
- Whether empty unknown-exec replies currently stall modern Pi frames on OCX's proto.
- Native-model toolResult size after Codex compact (#1043 analogue).
