# 000_plan — dangling tool_calls hardening (openai-chat 어댑터)

## 배경 / 증거

- 사고 로그: `ocx-mrqaiw05-269` (2026-07-18 20:35:31 KST), model `k3[1m]`, provider `kimi`
  (Kimi Code OAuth, `https://api.kimi.com/coding/v1`, openai-chat 어댑터), 400
  `invalid_request_error`: assistant `tool_calls` 중 `request_user_input:353`에 대응하는
  tool 메시지 부재.
- 세션 롤아웃(`~/.codex/sessions/2026/07/18/rollout-...019f7463-....jsonl` line 1415/1417):
  앱 history에는 `function_call`(`call_id=tool_RAM0...`)과 `function_call_output`이 정상
  페어로 존재. 단, 호출과 출력 사이에 developer 주입 메시지(INTERVIEW rescan)가 끼어 있음.
- 코드 근거: `src/adapters/openai-chat.ts` `messagesToChatFormat`
  - ~line 101: user/developer 메시지 push 시 `pendingToolCallIds = new Set()` 리셋.
    끼어든 메시지 때문에 미해결 tool_call id가 그대로 dangling으로 남음.
  - toolResult의 고아 보정(가짜 assistant 합성)은 존재하나, 반대 방향(응답 없는 호출)
    보정은 없음.

## Root cause (메커니즘)

`messagesToChatFormat`가 history를 직렬화할 때 두 경우에 dangling `tool_calls`를
그대로 업스트림으로 본냄. Kimi/Moonshot은 assistant `tool_calls` 직후 각 id의 tool
메시지를 강제 검증하므로 400.

1. assistant(tool_calls) → user/developer 메시지 삽입 → toolResult: pending 리셋으로
   원래 assistant의 tool_call이 dangling. (이번 사고 경로)
2. history 말미의 assistant(tool_calls)에 toolResult가 없음: 그대로 dangling.
   (턴 중단/재시도 경로)

## Fix (diff-level)

### `src/adapters/openai-chat.ts` — MODIFY

- `pendingToolCallIds: Set<string>` → `pendingToolCalls: Map<string, string>`
  (id → tool name)로 변경. assistant case에서 `toolCalls.map(tc => [tc.id, tc.name])`로 채움.
- 헬퍼 `flushPendingToolCalls()` 추가: pending이 비어있지 않으면 각 id에 대해
  `{ role: "tool", tool_call_id: id, content: "[tool result unavailable: \"<name>\" call was interrupted before a result was recorded]" }`를
  `out`에 push하고 pending을 clear.
- 호출 지점:
  - user/developer case: 메시지 push **전에** flush (기존 리셋 대체).
  - assistant case: 새 assistant push 전에 flush (연속 assistant 방어).
  - 루프 종료 후 `return out` 직전: 잔여 pending flush (말미 dangling 보정).
  - toolResult case: flush 없음. `pendingToolCalls.has(toolCallId)` 체크로 변경,
    성공 시 `pendingToolCalls.delete(toolCallId)`.

### `tests/openai-chat-dangling-toolcalls.test.ts` — NEW

`createOpenAIChatAdapter(provider).buildRequest(parsed)`로 messages를 뽑아 검증.

- C1: assistant(toolCall `call_x`) → developer 메시지 → toolResult(`call_x`)
  → wire의 모든 assistant tool_call id가 직후 tool 메시지로 답변됨. (branch 1 활성화)
- C2: 말미 assistant(toolCall)만 있고 결과 없음 → 합성 tool 메시지가 끝에 추가됨.
  (branch 2 활성화)
- C3: 정상 페어(assistant→toolResult 바로 연속)에는 합성 메시지가 0개.
- C4: 고아 toolResult(선행 호출 없음)는 기존처럼 가짜 assistant+tool 쌍으로 보정됨.
- C5: 다중 tool_calls 중 일부만 결과 있음 → 누락분만 합성 보정.

### devlog — NEW

- 본 문서 + D에서 `010_record.md` (구현/검증 증거) 추가.

## Scope

- IN: `src/adapters/openai-chat.ts` `messagesToChatFormat`, 신규 테스트 1개, devlog 유닛.
- OUT: responses parser 변경, 다른 어댑터(anthropic/cursor/kiro/google) 보정,
  Codex 앱 측 수정, npm publish/배포, git push.

## Accept criteria

- `bun test tests/openai-chat-dangling-toolcalls.test.ts` 전부 통과 (C1-C5 각각 해당
  분기 실발화 — 합성 tool 메시지의 존재/부재를 assertion으로 관찰).
- 기존 openai-chat 관련 테스트 회귀 없음: `bun test tests/openai-chat-hardening.test.ts tests/openai-chat-parallel-stream.test.ts tests/openai-chat-eof.test.ts tests/openai-chat-model-suffix.test.ts`.
- 타입체크 통과 (repo script 기준).

## 예상 터미널 결과

DONE(수정+테스트 통과) / BLOCKED(재현 불가 시 로그 추가 수집 요청).

## A-gate amendment (Sol 리뷰 GO-WITH-FIXES, blockers=6 반영)

Sol 독립 감사 결과 eager flush(끼어든 메시지 전에 합성 결과를 박는 원안)는 **진짜 결과가
뒤에 존재하는데도 실패를 날조**하고, orphan 경로가 가짜 assistant를 만들어 같은 id의
중복 라운드를 생성하는 문제가 있음이 확인됨. 설계를 defer + reattach로 변경.

### 수정 설계 (defer + reattach + last-resort synthesize)

우선순위: (1) 진짜 결과는 원래 호출에 재부착 → (2) 진짜 결과가 없을 때만 합성 →
(3) 역사에 호출이 아예 없을 때만 orphan 가짜 assistant 생성.

- `pending: Array<{ id, name }>` — 마지막 assistant-with-calls의 미해결 호출 발생(occurrence)
  목록(id 중복 보존, Map 금지).
- `deferred: unknown[]` — 툴 라운드가 열린 동안 도착한 user/developer 메시지 보관.
- case별 동작:
  - assistant: pending이 남아있으면 먼저 합성 결과 flush(이전 라운드 닫기) → 새 assistant
    push → pending 교체. deferred가 있으면 라운드 종료 후 해제.
  - toolResult: id가 pending occurrence와 매칭 → 바로 tool 메시지 push(adjacency 유지,
    barrier는 deferred 상태라 사이에 안 낌), 해당 occurrence 제거. pending이 비면 deferred
    해제. 매칭 없음 → pending 합성 flush + deferred 해제 후 기존 orphan 경로(가짜
    assistant+tool) — 중복 id 생성 안 함.
  - user/developer: pending이 열려 있으면 deferred에 보관, 아니면 즉시 push.
  - 루프 종료: 잔여 pending 합성 flush → deferred 해제.
- 사고 시나리오 wire: assistant(call) → tool(진짜 결과) → developer 메시지 (Sol의
  canonical 순서와 일치).
- id 하드닝: assistant tool_call의 id가 비어있으면 `call_ocx_minted_<n>`을 발급(기존 id와
  충돌 검사). 결과 매칭은 occurrence 큐에서 선형 탐색.
- 합성 결과 문구(실행 상태 미상을 명시, 사용자 의도 사칭 금지):
  `[ocx] no tool result was recorded for "<name>"; execution status unknown — do not treat this as success, failure, or user-provided input.`

### 테스트 매트릭스 (개정)

- T1 사고 재현: call → developer → result ⇒ 순서 call, result, developer / dangling 0.
- T2 말미 dangling ⇒ 끝에 합성 결과.
- T3 정상 페어 ⇒ 합성 0.
- T4 orphan result(호출 없음) ⇒ 가짜 assistant+tool 쌍 유지.
- T5 병렬 호출 부분 결과 ⇒ 매칭분만 부착, 라운드 종료 시 잔여 합성.
- T6 미매칭 result + pending 존재 ⇒ pending 합성 flush → deferred 해제 → orphan 쌍.
- T7 연속 assistant(앞에 calls) ⇒ 앞 라운드 합성 flush 후 다음 assistant.
- T8 빈 call id ⇒ minted id로 발급+페어링 가능.
- T9 wire 불변식 검증 헬퍼를 모든 케이스에 적용: 모든 assistant tool_calls가 직후 tool
  메시지 블록으로 닫히고, 블록 내 다른 role 없음, 블록 밖 tool 메시지 없음, 생성 id 충돌
  없음.
- T10 합성 문구 assertion: "no tool result was recorded" 포함, interrupted 단어 미포함.

### 기록하되 범위 밖 (residual)

- developer→system role 매핑의 의미론(지시 우선순위) 변경 — 별도 계약 변경이라 본 유닛
  범위 밖.
- OpenAI/xAI/DeepSeek/게이트웨이별 live conformance probe — 후속 유닛 후보.
