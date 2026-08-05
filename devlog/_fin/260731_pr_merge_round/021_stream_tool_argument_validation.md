# 021 — 스트림 tool 인자 검증을 이번 라운드에서 뺀 이유

#765를 태우면서 파생된 문제 하나를 세 번 고치려다 실패했다. 세 번째에서
멈추고 되돌렸다. 기록으로 남긴다 — 다음 사람이 같은 길을 다시 걷지 않도록.

## 발단

`toolUseArguments()`가 파싱 불가능한 문자열 input을 JSON **문자열**로 재인코딩했다
(`src/adapters/anthropic.ts:269`). tool 계약은 객체를 요구하므로
`"not json at all"`이 그대로 전달된다. #765가 보고한 이중 인코딩이다.
`{}`로 떨어뜨리는 것으로 고쳤고, 이건 남아 있다.

그런데 리뷰어가 짚었다: **스트리밍 경로는 그대로다.** `input_json_delta`의
`partial_json`을 그대로 흘려보내므로(`:836`) 같은 깨진 페이로드가
`parseResponse`로는 `{}`, `parseStream`으로는 `"not json"`이 된다. 한 결함에
두 답.

## 세 번의 시도

**1차 — 조각을 버퍼링해서 블록 종료 시 검증.** 두 경로가 같은 헬퍼를 타게 만들었다.
리뷰어가 거부: `src/bridge.ts:628`이 어댑터 delta 하나하나를 클라이언트가 보는
`response.function_call_arguments.delta` 프레임으로 바꾼다. 조각을 붙들면
시작된 함수 호출이 블록이 끝날 때까지 빈 인자로 보인다.
`tests/responses-stream-tool-events.test.ts:30`이 쪼개진 프레임 유지를 고정하고 있다.
일관성을 얻으려고 프로토콜을 깬 것이다.

**2차 — 증분 전달은 유지하고, 조립본이 파싱 안 되면 턴을 에러로.** 계약은 복구됐다.
리뷰어가 다시 거부: 어댑터가 `tool_call_end` 없이 `error`를 내도
`src/bridge.ts:771`의 error 케이스가 열린 tool call을 닫는다.
`closeCurrentToolCall()`이 `response.function_call_arguments.done`과
`status:"completed"`인 `response.output_item.done`을 `response.failed` **앞에**
내보낸다. 즉 클라이언트는 여전히 "완료된 호출"을 본다.

**3차 — 없음.** 여기서 멈췄다.

## 왜 멈췄나

실제 수정 지점이 `src/bridge.ts`다. 열린 tool call을 닫지 말고 취소하는
터미널 에러 모드를 새로 만들어야 하는데, 그건:

- 이 PR(#765, Anthropic 어댑터)의 범위 밖이다.
- 모든 어댑터의 error 경로에 영향을 준다. Anthropic만의 문제가 아니다.
- Codex가 다음 턴에 호출을 돌려보낼 때의 동작을 바꾼다.
  `closeCurrentToolCall()`의 주석이 왜 빈 인자를 `"{}"`로 직렬화하는지 설명한다 —
  `JSON.parse("")`가 세션 전체를 400으로 오염시킨 이력이 있다. 이 경로는
  건드리기 전에 그 이력을 먼저 이해해야 한다.

같은 결함을 두 번 연속 고치지 못했으면 패치를 멈추고 근본 원인으로 가라는 게
규칙이다. 세 번째는 계획을 바꾸는 자리지 세 번째 패치를 미는 자리가 아니다.

## 지금 상태

- **유지**: non-stream `toolUseArguments` → `{}` 수정과 그 테스트.
  독립적으로 옳고, #765가 보고한 절반을 실제로 고친다.
- **유지**: EOF stop-reason 회귀 테스트. 기존 EOF 테스트 둘 다 stop reason을
  안 보내서 fallback을 되돌려도 통과한다 — 무력한 테스트였다. 새 테스트는
  fallback을 끄면 실패한다(14 pass / 1 fail 확인).
- **되돌림**: 스트리밍 경로 변경 전부. 지금 동작은 이 라운드 이전과 같다.

**남은 결함**: 스트리밍 경로는 여전히 깨진 `partial_json`을 그대로 흘린다.
#765는 그래서 열어둔다. 다음 사이클의 단위는 "Anthropic 어댑터"가 아니라
**"bridge의 터미널 에러가 열린 tool call을 어떻게 처리해야 하는가"**다.
어댑터부터 손대면 또 같은 벽에 부딪힌다.
