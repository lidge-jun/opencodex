# Cursor Provider — Tool-Call 死亡 / MCP Empty RCA + Fix Spec

- 작성: 2026-07-02, Boss(조사 조율). 구현은 gpt-5.5 직원 dispatch로 진행 예정.
- 조사 방식: opus 서브에이전트 3기(forward / backward+MCP / test-coverage) 병렬 + Boss 직접 코드 리딩.
- 상태: **RCA 확정, 단 최종 분기(a/b/c)는 라이브 캡처로만 확정 가능**. 이 문서가 구현 SOT.

## 증상 (사용자 보고)

1. 응답(텍스트) 스트리밍은 정상적으로 온다.
2. MCP 목록이 전부 비어 보인다.
3. tool(도구) 호출이 **하나도** 발생하지 않는다.

## 확정된 아키텍처 사실 (코드 근거)

### Forward(tool 송출) — 순수 reactive 단일 게이트
- 초기 `AgentRunRequest`는 tool을 **한 글자도** 싣지 않는다. `src/adapters/cursor/protobuf-request.ts:293-316` `encodeCursorRunRequest`는 `conversationId / conversationState / action / modelDetails`만 채운다.
- Phase 45(`devlog/_fin/350_cursor-provider-add/129_...`)에서 top-level `AgentRunRequest.mcp_tools`(field 4) 미러를 제거했다 — 라이브 서버가 `internal: parse binary: illegal tag: field no 13 wire type 7`로 거부(로컬 스키마 self-consistent decode는 통과하지만 실서버 파서와 wire 불일치). 계약 테스트 `tests/cursor-blob.test.ts:58`이 `expect(run?.mcpTools).toBeUndefined()`로 "tool은 초기 요청에 없음"을 고정.
- 그 결과 tool 광고 경로는 **오직 하나**: 서버가 `requestContextArgs` exec 메시지를 보내면 그 응답으로 `RequestContext.tools`(field 7)에 실어 보낸다.
  - 유일 게이트: `src/adapters/cursor/native-exec.ts:63-68`
    ```
    if (execCase === "requestContextArgs") {
      const tools = [...(deps.mcpToolDefs ?? []), ...(deps.clientToolDefs ?? [])];
      return [ ...RequestContextResult{ requestContext: { tools } }... ];
    }
    ```
  - `clientToolDefs`는 `src/adapters/cursor/live-transport.ts:230-231`에서 `buildCursorToolDefinitions(request.tools, request.toolChoice)`로 계산되어 execContext에 저장되지만, **서버가 물어보지 않으면 wire로 0바이트** 나간다.
  - 파일 자체 주석이 자인: native-exec.ts:36-37 "Without `mcpToolDefs`, the server is never told any MCP tools exist, so it never sends `mcpArgs`." / live-transport.ts:186-189 "the server only calls MCP tools it was told about."
- `request.tools` 상류 배선은 정상: `src/responses/parser.ts`(function/namespace(MCP)/custom/tool_search 파싱) → `request-builder.ts:94` → `CursorRunRequest.tools`. 단 파서가 인식 못 하는 shape는 조용히 drop(parser.ts continue).

### Backward(server tool-call → SSE emit) — 결함 없음
- decode: `protobuf-events.ts:195-272`(deferred start, parallel 직렬화, arg 정규화) → `message-mapper.ts:20-25`(필터 없이 통과) → `live-transport.ts` push → `bridge.ts:362-397` SSE. 끊기는 지점 없음, 잘 테스트됨.
- 단 **게이팅 조건**: 서버가 돌려준 tool-call이 `case==="mcpToolCall"` AND `providerIdentifier==="opencodex-responses"`(`protobuf-events.ts:44-48`)여야 인식. 아니면 무음 drop. 그리고 `recordToolCall`(protobuf-events.ts:153-155)은 이름이 `clientToolNames`에 없으면 error emit — `clientToolNames`는 `request.tools`에서만 채워짐(live-transport.ts:236-240).
- `finalizeTurnEvents`(protobuf-events.ts:280-287)의 fail-closed 절단은 정상 흐름에선 grace-cancel로 회피됨. 상시 원인 아님.

### "MCP empty"의 절반은 설계상 예상됨
- opencodex-hosted MCP 서버는 `provider.mcpServers`를 읽는 `mcp-config.ts:35-42` 단 하나의 경로에만 의존. 이 값이 비면 `live-transport.ts:177-182`에서 `mcpManager` 자체가 undefined → `mcpToolDefs` 영영 미생성.
- **설정 surface 부재**: `grep mcpServers`가 GUI 0건, CLI 0건, `providers/derive.ts`/`registry.ts` 시드 0건. `config.json` 수기 편집만 유일 주입 경로(`config.ts` `.passthrough()`). 즉 일반 사용자에겐 hosted MCP는 100% 빈 상태 = **정상 동작이나 "MCP 비어보임"으로 오인**. devlog 362가 이미 "The empty MCP listing the user saw is expected"라고 문서화.

### 테스트가 green인데 라이브가 죽는 이유
- 나가는 wire에 tool이 encode되는지 검증하는 테스트가 **없다**(오히려 cursor-blob.test.ts:58이 반대를 assert).
- 모든 protobuf encode/decode 테스트가 로컬 생성 스키마(`gen/agent_pb`)로 왕복 → 실서버 wire 비호환이 유닛 전 구간 통과(Phase 45가 이 클래스를 이미 입증).
- `LiveCursorTransport.run()`을 tool 시나리오로 구동하는 통합 테스트가 **0개**. 각 링크만 고립 검증, 연결 미검증.

## 근본원인 (통합 가설)

**초기 turn에 tool을 wire-호환으로 싣지 않고, 서버의 `requestContextArgs` 선요청에 100% 반응형으로만 `RequestContext.tools`에 광고하는 구조.** 이 채널이 현재 사용 모델/엔드포인트에서 tool을 모델에게 노출하지 못하면 세 증상이 한 번에 설명된다:
- 서버가 `requestContextArgs`를 안 보냄 → tool 영영 미광고 → **tool 0회 발화** + 같은 채널의 **MCP empty**. 텍스트는 독립 채널 → **정상**.
- 근거 정합: Phase 45 실패 모델 = `claude-opus-4-7`, Phase 46 수동 성공 = `composer-2.5`(ping_1..10 → 10 function_call). **모델별 requestContextArgs 거동 차이** 강하게 시사.

### 미해결 리스크 (Phase 42 OPEN QUESTION — 반드시 해소)
`devlog/_fin/350_cursor-provider-add/125_...`가 명시적으로 남긴 미해결 질문:
> "RequestContext.tools might be MCP-only semantically despite the generic name. This needs audit."

즉 Cursor가 `RequestContext.tools`를 **MCP 전용**으로 취급하면, generic client(Responses) function tool을 거기 실어도 모델이 못 본다. 이게 사실이면 reactive 채널을 고쳐도 client tool은 영영 안 뜬다.

## 필수 선행: 라이브 진단 (구현 전 반드시)

정적 코드로는 a/b/c를 구분 불가. gpt-5.5 직원의 **1차 작업은 코드 수정이 아니라 계측+라이브 캡처**다. `OPENCODEX_CURSOR_TEST_TOKEN` 필요(`live-smoke-gate.ts`).

진단 항목:
- D1. 실제 Codex 요청에서 `request.tools.length`를 찍는다 → 상류에서 tool이 비어 오는가?(가설 c 판별, 비용 최저)
- D2. 라이브 스트림에서 서버가 `requestContextArgs` exec를 **실제로 보내는가**를 모델별로 캡처(claude-opus 계열 vs composer-2.5). 안 보내면 → 가설 a 확정.
- D3. 보낸다면 우리가 `RequestContext.tools`를 채워 응답한 뒤 모델이 `mcpArgs`/`toolCallStarted`를 내는가? 안 내면 → 가설 b(RequestContext.tools = MCP-only) 확정.
- D4. 캡처 산출물: 실제 Cursor CLI가 tool을 초기 turn에 싣는 필드/shape(가능하면 jawcode SOT `packages/ai/src/providers/cursor.ts` 또는 실 CLI 트래픽 대조).

## Fix 옵션 (진단 결과에 매핑)

- 가설 c(request.tools 빈 채 도착): `src/responses/parser.ts` tool shape 파싱 수정. **S**.
- 가설 a(서버가 requestContextArgs 미발): 초기 `AgentRunRequest`에 tool을 **wire-호환**으로 proactively 싣는다. Phase 45가 깨진 건 잘못된 `McpTools`(field 4) shape였으므로, 실제 Cursor CLI가 쓰는 올바른 필드/인코딩을 D4로 확정 후 `protobuf-request.ts:293-316`에 추가. **L**(RE 필요).
- 가설 b(RequestContext.tools = MCP-only): client function tool을 Cursor가 인정하는 tool 표면(예: 별도 tool 정의 필드/네이티브 tool 매핑)으로 재배치. **M/L**.

## UPDATE (추가 opus 조사) — field-4 proactive 재추가가 유력 저비용 1순위 수정

추가 조사(jawcode SOT / in-repo 레퍼런스 / Phase-45 git 아카이브, 전부 opus 서브에이전트)로 두 가지가 뒤집혔다:

1. **복사할 proactive 레퍼런스는 없다.** jawcode(`packages/ai/src/providers/cursor.ts:2607-2616` "Tools are sent later via requestContext")·gajae-code·oh-my-pi 전부 opencodex와 **동일한 reactive-only**. danger-pi 원본은 머신에 없음(fail-fast). jawcode도 tool-call은 composer-2.5로만 검증, claude-opus 증거 없음 — opencodex 증상과 정확히 일치(모델별 requestContextArgs 거동 차이 = 가설 a 강화).

2. **그러나 proto field 4는 살아있고, Phase 45의 "field 4 불가" 결론은 반박됨(신뢰도 High).**
   - 스키마: `AgentRunRequest.mcpTools`(field 4, `gen/agent_pb.ts:2760`) = `McpTools{ mcpTools: McpToolDefinition[] }`(`McpToolsSchema` `gen:9016`). reactive `RequestContext.tools`(field 7)와 **원소 타입 동일**(`McpToolDefinition`). Phase 45는 스키마가 아니라 값 채우는 배선만 제거.
   - 크래시 `illegal tag: field no 13 wire type 7`은 **파서 desync 서명**: AgentRunRequest 최대 field ≈9라 field 13 없음, wire type 7 존재 불가. `@bufbuild/protobuf` `toBinary(create(...))`는 항상 유효 wire+정합 length만 방출하고 proto3는 모르는 well-formed 필드를 조용히 skip → **정상 인코딩된 field 4는 이 크래시를 재현 불가**. Phase 42의 field-4 실험은 **미커밋 로컬 코드**(git에 diff 없음)였고, 이중광고(field 4 + field 7 동시) 또는 오인코딩(McpTools wrapper 누락/잘못된 input_schema bytes)이 desync 원인일 개연성.
   - devlog 129 RCA는 "live parser가 reject" 하나만으로 field 4를 wire-incompatible로 귀속했고 인코딩 정오·이중광고를 분리 검증하지 않음.

### 1순위 수정 (RE 불필요, cheap, 크래시 재현 불가)
`src/adapters/cursor/protobuf-request.ts`에 field 4를 **올바르게 감싸** proactively 싣되 기존 reactive 핸들러(`native-exec.ts:63-68`)는 **그대로 유지**(both-ways, idempotent, 둘 다 conformant `toBinary`라 desync 원천 불가):
```ts
// import 블록에 McpToolsSchema 추가, tool-definitions에서 builder도 import
import { buildCursorToolDefinitions, OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";
// create(AgentRunRequestSchema, { ... }) 안, modelDetails 뒤:
...(request.tools?.length
  ? { mcpTools: create(McpToolsSchema, { mcpTools: buildCursorToolDefinitions(request.tools, request.toolChoice) }) }
  : {}),
```
- tool 입력은 reactive path와 **완전 동일**(`request.tools`/`request.toolChoice`, `request-builder.ts:94-95`). `inputSchema`는 `encodeCursorInputSchema`=`toBinary(ValueSchema, fromJson(...))`로 이미 정상.
- 후속 필수: `tests/cursor-blob.test.ts:58` `expect(run?.mcpTools).toBeUndefined()` 뒤집기 + **`cursor/claude-opus-4-7` 라이브 A/B로 tool call 실발화 확인**.
- **효능은 Medium 신뢰도**: Cursor 서버가 field 4를 proactively 실제 소비하는지는 라이브로만 확정. 무시하면 **무해 no-op**(reactive만 존중)이라 저위험이지만, 그 경우 model-dependent 버그는 안 고쳐지고 → 가설 b(RequestContext.tools = MCP-only) 또는 prewarm 경로 검토로 이행.

## 회귀 방지 (필수)
어떤 수정이든 **`run()`을 mock HTTP/2 stream으로 구동하는 통합 테스트**를 추가한다: `request.tools` → advertise → 서버 tool-call 프레임 → SSE `function_call` emit 전 구간. 없으면 다시 green-회귀한다. 대상: `tests/cursor-live-transport-tools.itest.ts`(신규).

## 변경 파일 맵 (예상)
- 진단 계측(임시): `live-transport.ts`, `native-exec.ts` (로그, 커밋 전 제거)
- 실제 수정(분기별): `protobuf-request.ts`(가설 a) / `parser.ts`(c) / tool 표면 재배치(b)
- 신규 통합 테스트: `tests/cursor-live-transport-tools.itest.ts`
- (선택, MCP-empty UX) `providers/registry.ts`+GUI에 mcpServers 설정 surface — 별건, 우선순위 낮음

## 제약
- 프로토콜은 문서 없는 2단계 reverse-engineered 사본(Cursor → jawcode RE → opencodex vendored). `.proto` 원본/재생성 파이프라인 없음.
- 라이브 진단은 실 Cursor 계정 토큰 필요. 파괴적 실험 금지(read/ls/grep 위주).
- Boss는 직접 코드 미작성. 구현은 gpt-5.5 직원(`cli-jaw dispatch --virtual --cli codex --model gpt-5.5 --mutable --scope src/adapters/cursor`).
