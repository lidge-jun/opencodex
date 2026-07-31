# 000 — issue #543: Kiro opus-5가 Claude Code 중간 스티어링을 무시하는 문제

## 신고 내용과 이미 좁혀진 범위

Claude Code를 opencodex 프록시(`claudeCode.authMode: "proxy"`)로 Kiro에 붙여 쓸 때,
에이전트가 작업 중일 때 입력한 스티어링 메시지가 무시된다. Claude Code는 그것을
`queued_command` attachment로 기록하고 다음 요청에 실어 보내며, 프록시는 계속 200을
반환한다. 그런데 모델은 이전 계획을 그대로 이어간다.

신고자 본인의 대조 실험이 범위를 크게 좁혔다. **같은 프록시 빌드(2.7.41), 같은 Claude
Code(2.1.220), 같은 머신, 재시작 없음**인데:

| 경로 | 중간 스티어링 |
|---|---|
| Native Claude Code (프록시 없음) | 동작 |
| opencodex + `kiro/claude-opus-4.8` | **동작** |
| opencodex + `kiro/claude-opus-5` | **무시** |

따라서 "opencodex가 모든 `queued_command`를 버린다"는 최초 가설은 신고자 스스로
반증했다. 번역기가 계통적으로 버린다면 4.8도 같이 실패해야 한다.

남은 질문은 하나다. **우리 코드에 모델 조건 분기가 있는가?**

## 실측 — 두 모델의 페이로드를 직접 비교했다

정적 독해만으로 판단하지 않고, `buildKiroPayload`를 실제 호출해 두 모델의 wire
페이로드를 뽑았다. 입력은 신고된 상황과 동일한 tail:

```
user("Refactor module A.")
assistant(text + toolCall call_1)
toolResult(call_1, "file list here")
user("STOP editing module A. Use kiro/gpt-5.6-sol instead.")   ← 중간 스티어링
```

결과 (`history len`, `CURRENT`는 `conversationState.currentMessage`):

```
===== claude-opus-5 =====
history len: 2
  h[0] USER      (system prefix + tool-catalog nudge + completion instructions)
  h[1] ASSISTANT "Starting."  toolUses=1
CURRENT content: "The requested tool result is attached.\n\nSTOP editing module A. Use kiro/gpt-5.6-sol instead."
CURRENT hasToolResults: true
additionalModelRequestFields: {"output_config":{"effort":"high"}}

===== claude-opus-4.8 =====
history len: 2
  h[0] USER      (동일)
  h[1] ASSISTANT "Starting."  toolUses=1
CURRENT content: "The requested tool result is attached.\n\nSTOP editing module A. Use kiro/gpt-5.6-sol instead."
CURRENT hasToolResults: true
additionalModelRequestFields: undefined
```

**대화 내용과 전송 구조는 동일하다.** 정확히 말하면 다른 것은 세 가지뿐이고, 그중
둘은 정의상 달라야 하는 값이다:

1. `currentMessage.userInputMessage.modelId` — 모델 식별자이므로 당연히 다르다.
2. history의 user 메시지 `modelId` — 같은 이유.
3. `additionalModelRequestFields` — opus-5만 `output_config.effort`를 보낸다.

`content`, `toolResults`, `history` 구조, tool 카탈로그, completion 설정은 같다.
(초안에서 "바이트 단위로 동일"이라고 썼으나 리뷰에서 반증됐다. modelId는 반드시
다르므로 그 표현은 과장이었다. 중요한 것은 **스티어링 텍스트의 위치와 내용이 같다**는 점이다.)

## 판정 1 — 스티어링 텍스트는 버려지지 않는다

중간 스티어링은 history에 묻히지 않고 `currentMessage`에 그대로 실린다. 경로:

- inbound이 블록 순서를 보존한다. `tool_result`는 독립 `function_call_output`이 되고
  뒤따르는 text는 user 메시지가 된다 (`src/claude/inbound.ts:264-301`).
- Kiro 어댑터가 연속된 user 측 turn을 의도적으로 병합한다 (`src/adapters/kiro.ts:442-451`).
  그래서 `user[tool_result]` + `user[스티어링]` 두 개든, 한 메시지에 두 블록이 함께
  오든, 결과는 tool result와 스티어링 텍스트를 **함께 담은 하나의 user turn**이다.
- 마지막 turn이 `currentMessage`가 된다 (`src/adapters/kiro.ts:521-570`,
  `const currentTurn = turns.pop()`). user turn이 아니면 즉시 throw한다.

즉 프록시는 스티어링을 온전히 최신 턴으로 올려보낸다. 200 응답도 정상이다.

## 판정 2 — 이 경로에서 모델 조건 분기는 사실상 없다

확인한 분기 전부:

| 요소 | 모델 의존? | 근거 |
|---|---|---|
| `completionMode` | 아니다 — 도구 유무만 본다 | `src/adapters/kiro.ts:421-422` |
| tool-catalog nudge | 아니다 — 모델 인자 없음 | `src/adapters/kiro.ts:432-434` |
| context window (1M) | 두 모델 동일 | `src/providers/kiro-models.ts:32-33` |
| `normalizeKiroModelId` | 일반 규칙 | `src/providers/kiro-models.ts:57-66` |
| continuation 캐시 | tail을 대체 못 함; 누락 시 400이지 200이 아니다 | `src/server/responses/core.ts` |
| **native effort** | **그렇다 — 유일한 차이** | `src/adapters/kiro.ts:256-259` |

`KIRO_NATIVE_EFFORT_FIELDS`에는 `gpt-5.6-sol`과 `claude-opus-5`만 있다. 그래서
opus-5는 `output_config.effort`를 native로 보내고, opus-4.8은 emulated 쪽으로 간다.

**그런데 emulated 경로도 이 상황에서는 발동하지 않는다.**
`injectKiroThinkingTags`는 `currentMessage`에 tool results가 있으면 건너뛴다
(`src/adapters/kiro.ts:555`). 중간 스티어링 턴은 정의상 tool result를 동반하므로
opus-4.8도 thinking 태그 주입을 받지 않는다. 그래서 위 실측처럼 두 페이로드가
같아진다.

결론: **관찰된 차이를 우리 코드의 분기로 설명할 수 없다.** 유일한 wire 차이는
effort 필드이고, 그것이 "최신 user 지시를 무시한다"로 이어진다는 인과는 아직 근거가 없다.

## 다만 개선 여지는 있다 — 프록시 문구가 사람 지시보다 앞에 온다

실측에서 드러난 실제 문제 하나. `currentMessage.content`가 이렇게 조립된다:

```
"The requested tool result is attached.

STOP editing module A. Use kiro/gpt-5.6-sol instead."
```

`KIRO_TOOL_RESULT_CARRIER_MESSAGE`(`src/adapters/kiro-constants.ts:7`)는 tool result를
담는 user turn이 빈 content가 되지 않게 넣는 프록시 자체 문구다. 그런데 병합 순서상
**사람이 실제로 쓴 지시가 프록시 filler 뒤로 밀린다.**

이건 모델 무관하지만, 최신 사람 지시가 기계적 안내문에 가려질 수 있는 배치다.
opus-5가 이 구조에 더 민감하다면 증상이 이 배치와 상호작용할 여지가 있다.
캐리어 문구는 tool result만 있고 사람 텍스트가 없을 때만 필요하다.

## 가설 순위

1. **UPSTREAM/MODEL (높음)** — Kiro의 opus-5가 `toolResults`와 같은
   `userInputMessage`에 실린 자유 텍스트에 낮은 가중치를 준다. 4.8은 잘 처리한다.
   우리 페이로드가 동일하다는 실측이 이 방향을 강하게 지지한다.
2. **OUR-CODE (중간)** — 캐리어 문구가 사람 지시 앞에 오는 배치가 무시를 조장한다.
   모델 무관 결함이지만 개선 대상이고, 이번에 고칠 수 있다.
3. **OUR-CODE (낮음)** — `output_config.effort`가 opus-5의 tool-loop 순응도를 바꾼다.
   effort를 끈 동일 캡처로 반증 가능하지만, 이건 신고자 환경이 필요하다.

## 아직 증명 못한 것

상류가 실제로 무시하는지는 라이브 캡처 없이는 확정할 수 없다. 여기서 정직하게
구분해야 한다. 우리가 증명한 것은 **"우리는 스티어링을 온전히 보낸다"**이고,
증명 못한 것은 **"상류 opus-5가 그것을 어떻게 대우하는가"**다.

기존 inbound debug ring은 스칼라만 담고 메시지 구조를 기록하지 않으므로
(`src/claude/inbound-debug.ts:58-77`) 이 질문에 답하기에 부족하다.
