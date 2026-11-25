# 090 — 요청 정책: outbound payload rule·요청 filter seam, 요청 masking

**Gaps:** G-034, G-035
**Depends on:** 060, 070
**Size:** L

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

운영자가 특정 공급자/모델 요청에 반복되는 소수의 default·drop 규칙을 지정하고, 명시적으로 등록한 요청 filter를 실제 outbound body가 만들어진 지점에서 실행한다. 기본 off인 요청 masking으로 지정 패턴을 업스트림 전송 전에 가리고, 실패하면 물리적 전송이 한 번도 일어나지 않는다.

## Why

- **G-034** — CPA `payload` 설정(`002` L2-4)과 magpie `moejs`(`006` L6-3)는 변환 후 body 규칙을 준다. OpenCodex는 effort 정책(`ocx:src/server/effort-policy.ts:170`)과 outbound URL/headers hook(`ocx:src/plugins/upstream-hooks.ts:15`)뿐이다.
- **G-035** — magpie는 요청 masking을 한다(`mgp:internal/masking/masking.go:381`) (`006` L6-4). OpenCodex의 redaction은 로그·오류용이다(`ocx:src/server/responses/terminal-error-redaction.ts:103`).

## Changes

Outbound body는 `request-prepare.ts`가 아니라 adapter의 `buildRequest`에서 만들어지고, retry·recovery·OAuth refresh가 다시 만들며, native Messages는 따로 보낸다 (감사 r2 #3, r3 #1). 그래서 filter는 body가 만들어지거나 다시 만들어지는 모든 지점 뒤, 물리적 send 앞에 둔다. dispatcher에 들어가지 않는 경로는 admission에서 거절한다.

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/config/schema/payload-rules.ts` | NEW | `{match:{provider, model?, protocol?}, set?: Record<path, value>, drop?: path[]}`, allowlist 경로만 |
| `src/plugins/outbound-filters.ts` | NEW | core 소유 slot `registerOutboundFilter({id, run})`. 등록이 없으면 호출 0회. 결과 `{ok: true; request} \| {ok: false; reason}` |
| `src/server/responses/adapter-dispatch.ts` | MODIFY | 1992줄, 여유 7줄. 첫 `buildRequest`(`ocx:src/server/responses/adapter-dispatch.ts:342`) 결과와 retry 재생성(`:663`) 결과에 각각 `applyOutboundFilters` 한 줄. 캐시된 same-target 재사용(`:660`)은 이미 필터된 요청이다 |
| `src/server/messages-native.ts` | MODIFY | native Messages 물리 send(`ocx:src/server/messages-native.ts:769`) 앞 `activeRequest`에 한 줄 |
| `src/server/responses/passthrough-dispatch.ts` | MODIFY | 1968줄(여유 31). 네 재생성 지점 모두에 한 줄씩: 첫 `buildRequest`(`ocx:src/server/responses/passthrough-dispatch.ts:390`), recovery 재생성(`ocx:src/server/responses/passthrough-dispatch.ts:1137`), Codex credential replay 재생성(`ocx:src/server/responses/passthrough-dispatch.ts:1308`), OAuth refresh 재생성(`ocx:src/server/responses/passthrough-dispatch.ts:1409`) |
| `src/server/key-admission.ts` (070) | MODIFY | masking이 켜진 키가 위 dispatcher를 거치지 않는 경로(image 생성 등, 그리고 standalone Realtime·dictation WS)를 요청하면 거절. 070이 HTTP·Responses WS turn과 standalone WS(`serve-options.ts:1690` 직후, upstream socket 결정 전)에 이미 연결한 `admitKeyTurn`에 경로 판정만 추가 |
| `src/server/inference/request-masking.ts` | NEW | deterministic 규칙(정규식 목록, 지정 필드), 원문 미보관. filter로 등록됨. 기본 off, 키별 정책은 070 키 모델 |
| `gui/src/pages/` 설정 | NEW 패널 | 규칙 편집과 dry-run (실제 요청 없음) |

1차 지원 wire: 변환 adapter 경로(Responses↔Chat/Messages/Gemini), native Messages, Responses passthrough. 그 밖의 경로(예: realtime, image 생성)는 masking이 켜진 키라면 admission에서 거절하고, payload rule은 적용하지 않는다고 문서에 명시한다.

### Before / After

`ocx:src/server/responses/adapter-dispatch.ts:342` — build 결과가 바로 send 준비로 간다.

```ts
// before
initialRequest = await transportState.activeAdapter.buildRequest(parsed, { /* … */ });
refreshRequestToolAliases(initialRequest);
```

```ts
// after (sketch) — 같은 한 줄을 :663, passthrough :390/:1137/:1308/:1409, messages-native :769에도
initialRequest = applyOutboundFiltersOrThrow(await transportState.activeAdapter.buildRequest(parsed, { /* … */ }), filterCtx);
refreshRequestToolAliases(initialRequest);
// applyOutboundFiltersOrThrow: 등록된 filter가 없으면 같은 객체를 그대로 반환. 실패하면 OutboundFilterRefusal을 던져 send 전에 종료.
```

## Dependencies

060 (codec 변경 뒤 outbound 지점 확정), 070 (키별 정책 모델).

## Acceptance

- 규칙이 없는 설치에서 세 지점의 `applyOutboundFilters`는 같은 객체를 돌려주고 추가 parse·타이머가 없다.
- payload rule로 특정 모델 요청의 필드를 drop하면 그 요청에만 적용되고, 응답 SSE의 tool/reasoning/terminal frame은 그대로다.
- masking 규칙 오류 fixture: 첫 build에서 실패하면 물리적 fetch가 0회다. 첫 send가 끝난 뒤 retry·recovery·OAuth refresh 재생성에서 filter가 실패하면 **추가** fetch가 0회다 (adapter-dispatch, passthrough의 recovery·credential replay·OAuth refresh 각각). native Messages 경로도 같다.
- masking이 켜진 키로 범위 밖 wire를 호출하면 admission에서 거절되고 dispatcher가 호출되지 않는다. standalone Realtime·dictation WS에서는 upstream socket이 한 번도 열리지 않는다.

## Verification

- 신규 `tests/config/payload-rules.test.ts`, `tests/lib/plugin-outbound-filters.test.ts`, `tests/server/request-masking.test.ts`, `tests/server/request-masking-zero-send.test.ts`
- 기존 회귀: `tests/lib/plugin-upstream-hooks.test.ts`, `tests/lab/core-lab-boundary.test.ts`
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`, `bun run privacy:scan`

## Risks

- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `adapter-dispatch.ts`는 1992줄로 여유 7줄이다. 이 단계의 추가는 두 호출 줄로 끝나야 하며, 넘치면 먼저 기존 코드를 sibling으로 옮긴다. `passthrough-dispatch.ts` 1968줄.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다. filter slot은 `src/server/passive-route-linker.ts`와 같은 core 소유 등록 패턴으로만 채운다.
- **Privacy:** masking 전 원문을 로그·trace에 남기지 않는다. detector 다운로드·자동 업데이트 없음.

## Non-goals

- 응답 측 hook과 placeholder 복원 (G-059 보류), 플러그인 marketplace (G-047 비채택), provider-extension ABI (G-039 보류).
