# 060 — wire 충실도: 첨부 전용 turn, Gemini Interactions egress, xAI upstream WS

**Gaps:** G-022, G-023, G-024
**Depends on:** 040
**Size:** L

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

Codex와 Claude Code의 첨부 전용 turn, file-backed 첨부, PDF, 여러 modality의 tool result가 대상 공급자 능력에 맞게 보존되거나 전송 전에 명확히 거절된다. Gemini Interactions를 공급자 네이티브로 보내는 opt-in 모드와 xAI upstream WebSocket 전송을 제공한다.

## Why

- **G-022** — CPA translator는 첨부 단독 turn과 다중 modality tool result를 변환한다 (`001` L1-4). OpenCodex의 `checkRepresentable`(`ocx:src/protocols/guard.ts:17`)과 Claude inbound(`ocx:src/claude/inbound.ts:64`)는 경로별로 다르다.
- **G-023** — CPA는 Interactions를 공급자로 보낸다 (`001` L1-5). OpenCodex는 local ID로 처리하고 리소스 조회도 로컬이다(`ocx:src/server/gemini-interactions-inbound.ts:209`: "never forwarded upstream").
- **G-024** — CPA `xai_websockets_executor`는 upstream WS를 쓴다 (`001` L1-3). OpenCodex xAI는 HTTP다(`ocx:src/providers/xai-transport.ts:21`).

## Changes

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/protocols/attachment-capability.ts` | NEW | 대상별 첨부 능력 `{image, pdf, file, toolResultImage}` |
| `src/protocols/guard.ts` | MODIFY | `checkRepresentable`(`ocx:src/protocols/guard.ts:17`)이 능력 표로 판정해 보존/413/400 구분 |
| `src/claude/inbound.ts` | MODIFY | 첨부 변환 지점(`ocx:src/claude/inbound.ts:64`, `:291`)에서 file-backed 첨부와 tool-result modality 보존 |
| `src/protocols/codecs/gemini-interactions-egress.ts` | NEW | Interactions 요청을 공급자 wire로 encode |
| `src/protocols/codecs/gemini-interactions.ts` | MODIFY | 770줄. `interactionsToChat`(`ocx:src/protocols/codecs/gemini-interactions.ts:318`) 옆에서 모드별 분기만 |
| `src/server/gemini-interactions-inbound.ts` | MODIFY | 연쇄 POST의 previous id 처리(`ocx:src/server/gemini-interactions-inbound.ts:86`)와 `handleGeminiInteractionResource`(`ocx:src/server/gemini-interactions-inbound.ts:209`): native 모드에서는 owner 확인 뒤 local id → upstream id 매핑으로 GET/DELETE/cancel을 공급자에 전달. local 모드는 그대로 |
| `src/providers/xai-ws-transport.ts` | NEW | Bun bounded WS, transcript/ID 수명, WS→SSE terminal·fallback |
| `src/providers/xai-transport.ts` | MODIFY | `isXaiResponsesDestination`(`ocx:src/providers/xai-transport.ts:21`) 옆에 transport 선택 |
| `src/server/responses/fetch-helpers.ts` | MODIFY | `egressFor`(`ocx:src/server/responses/fetch-helpers.ts:362`)를 WS 연결에도 적용 |

Interactions native 모드 의미 (감사 r2 #8, r3 #6): create는 공급자 id를 받아 `{localId, upstreamId, ownerKey, provider, destination, accountId, generation}`로 저장한다(040 snapshot). GET/DELETE/cancel은 owner가 다르면 기존처럼 없는 id로 응답한다. owner가 같으면 생성 때와 같은 admission(`ocx:src/server/index/gemini-routes.ts:73`)에 더해, 지금 키 범위가 묶인 destination을 아직 허용하는지 다시 확인한 뒤 저장된 계정·generation으로만 전달하며, 그 계정이 제거됐거나 generation이 바뀌었으면 다른 계정으로 보내지 않고 409 `interaction_binding_unavailable`을 돌려준다.

연쇄 POST (`previous_interaction_id`, 감사 r4 #3): local 모드는 지금처럼 저장된 history로 요청을 다시 만든다(`ocx:src/server/gemini-interactions-inbound.ts:86`). native 모드는 local previous id로 binding을 찾고, owner와 현재 destination 정책을 다시 확인한 뒤, 매핑된 upstream id를 묶인 계정으로 보낸다. binding이 없거나 계정을 쓸 수 없으면 409이며 history 재구성으로 몰래 바꾸지 않는다. 설정은 `providers.<g>.interactionsEgress`이며 값은 `local`(기본)과 `native`다.

### Before / After

`ocx:src/protocols/guard.ts:17` — 판정은 feature 표현 가능성만 보고, 대상 공급자의 첨부 능력은 보지 않는다.

```ts
// before
export function checkRepresentable(input: { inbound: Protocol; requestPath: readonly ProtocolHop[];
  features: Iterable<ProtocolFeature>; policy: "legacy" | "reject" }): RepresentableVerdict {
  if (input.policy !== "reject") return { ok: true };
  const { effects } = featureEffectsForPath(input.inbound, input.requestPath, input.features);
  const features = unrepresentableFeatures(effects);
  return features.length === 0 ? { ok: true } : { ok: false, features, reasonCodes: ["feature-unrepresentable"] };
}
```

```ts
// after (sketch)
export function checkRepresentable(input: { /* 기존 필드 */; attachments?: AttachmentCapability }): RepresentableVerdict {
  const attachment = input.attachments ? attachmentVerdict(input.features, input.attachments) : undefined;
  if (attachment && !attachment.ok) return attachment;               // 첨부 전용 turn은 policy와 무관하게 send 전 400/413
  if (input.policy !== "reject") return { ok: true };
  /* 기존 판정 그대로 */
}
```

## Dependencies

040. G-024의 WS는 040의 계정별 egress, 강제 HTTP, pacing을 따라야 한다 (감사 r1 #4). G-022와 G-023은 040 없이 먼저 시작할 수 있다. 090의 outbound filter 위치는 이 단계의 codec 변경 뒤 확정한다.

## Acceptance

- 첨부만 있는 Codex turn을 이미지 미지원 대상에 보내면 업스트림 호출 전에 400과 이유가 나온다. 지원 대상에서는 첨부가 보존된다 (공급자별 fixture).
- `interactionsEgress: native`에서 create → GET → cancel → DELETE가 upstream id로 왕복한다. 다른 키 소유자의 id는 없는 id로 응답한다. pool의 active 계정이 바뀐 뒤에도 후속 조작과 연쇄 tool-result POST는 생성 계정으로 가고, 그 계정이 사라졌으면 409다. 생성 뒤 키 범위를 좁혀 destination이 더 이상 허용되지 않으면 GET/DELETE/cancel/연쇄 POST 모두 upstream send 0회로 거절된다. 기본값에서는 동작 변화 없음.
- xAI WS 모드에서 연속 turn이 history 전체를 재전송하지 않는다. WS 실패 시 HTTP로 돌아가되 이미 보낸 turn을 암묵적으로 재전송하지 않는다.
- fixture: 강제 HTTP 설정이 있으면 WS를 열지 않는다. pacing 설정이 있으면 WS 프레임도 같은 간격을 지킨다. 계정 egress proxy가 지정되면 WS 연결도 그 proxy를 쓴다.

## Verification

- 신규 `tests/responses/protocol-attachment-capability.test.ts`, `tests/adapters/google/google-interactions-egress.test.ts`, `tests/server/gemini-interactions-native-resource.test.ts`, `tests/providers/xai-ws-transport.test.ts`
- 기존 회귀: `tests/responses/protocol-guard.test.ts`, `tests/claude-integration/claude-inbound-*.test.ts`, Gemini Interactions codec 테스트, `tests/responses/openai-responses-passthrough.test.ts` (캡 4809줄; 새 케이스는 sibling 파일)
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`; WS는 `ci:full`

## Risks

- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `openai-responses-passthrough.test.ts`는 캡 파일이다.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다.
- **재전송:** xAI WS fallback은 fail-closed 재전송 게이트를 따른다.
- **Privacy:** 첨부 바이너리·경로를 로그에 남기지 않는다.

## Non-goals

- 범용 TTS, legacy completions (G-042, G-043 비채택), Gemini Live (G-038 보류), embeddings/rerank (G-037 보류).
