# 001 — Logs tok/s 열 타당성 조사 (Q1)

## 결론

**조건부 가능**이다. 지금도 최종 `usage.outputTokens`와 전체 벽시계 `durationMs`가 한 로그 행에 있으므로, TTFT 미분리의 요청 체감 속도 열은 서버 변경 없이 GUI에서 계산할 수 있다. 다만 이것은 생성(decode) 속도가 아니라 준비 시간·TTFT·도구 대기를 함께 분모에 넣은 *end-to-end output rate*다. 실제 생성 속도를 `tok/s`로 표기하려면 스트리밍 경로에 `firstOutputMs`를 신규 계측·영속해야 하며, 비스트리밍과 tool-only 응답에는 값이 없을 수 있다는 정책이 전제다. 근거: `durationMs` 기록과 usage 최종화는 `src/server/request-log.ts:399-468`, GUI 수신 형태는 `gui/src/pages/Logs.tsx:22-43`.

가격/비용 열은 별도 Q2 범위이며, 본 문서는 비용 산정에 들어가지 않는다.

## 1. 현재 계측·usage 상태

### 1.1 요청 및 attempt 시간

- 최종 요청 로그는 `addFinalRequestLog()`가 만들며, top-level `durationMs`는 종료 시 `Date.now() - start`로 기록된다. 즉 요청 시작부터 terminal/취소/비스트리밍 body 소비 완료까지의 전체 벽시계다. `src/server/request-log.ts:399-468`
- active attempt가 있으면 같은 함수가 `Date.now() - (activeAttemptStartedAt ?? start)`로 `finishRequestAttempt()`를 호출한다. 이 함수는 attempt의 `durationMs`를 0 이상으로 저장한다. `src/server/request-log.ts:418-424`, `src/server/request-log.ts:585-606`
- attempt 스키마는 `durationMs`, `usageStatus`, `usage`, `totalTokens`를 이미 보존한다. `src/usage/log.ts:14-30` 따라서 combo의 attempt별 속도 계산에 필요한 "시간 + usage" 짝은 현 구조상 가능하다.

### 1.2 usage가 채워지는 경로

- Responses 형식의 JSON/SSE payload는 `applyResponseLogMetadata()`가 `usageFromResponsesPayload()`로 읽어 `logCtx.usage`와 active attempt usage에 넣는다. Responses 필드 `input_tokens`/`output_tokens`와 legacy `prompt_tokens`/`completion_tokens` 모두를 정규화하며, reasoning 토큰은 `reasoningOutputTokens`로 별도 보존한다. `src/server/request-log.ts:197-263`
- SSE payload는 `trackSseForRequestLog()`에서 완전한 SSE block 단위로 `inspectResponseLogSsePayload()`에 넘겨 메타데이터를 적용한다. `src/server/relay.ts:142-187`, `src/server/request-log.ts:281-300`
- native passthrough는 body를 `tee()`한 inspect branch를 `consumeForInspection()` 또는 `consumeForResponseLogMetadata()`로 소비하고 같은 `logCtx`를 전달한다. 따라서 native도 최종 usage 수집 경로는 존재한다. `src/server/responses.ts:1153-1193`
- adapter 스트리밍은 `adapter.parseStream()`의 `AdapterEvent`를 `bridgeToResponsesSSE()`로 보낸다. `done`/`error` event는 usage를 가질 수 있고, `AdapterEvent`에는 text, thinking, raw reasoning, tool event가 구분되어 있다. `src/server/responses.ts:1522-1543`, `src/types.ts:192-215`
- usage가 없지만 입력 추정치가 있으면 `finalizedUsage()`는 `outputTokens: 0, estimated: true` fallback을 만들 수 있다. 이를 실제 출력 0과 동일시하면 안 된다. `src/server/request-log.ts:510-535`
- cursor/kiro adapter는 최종 usage가 있어도 `estimated: true`로 표시된다. `src/usage/log.ts:64-80`

## 2. tok/s 정의 두 안

| 안 | 식 | 측정 의미 | 장점 | 한계 |
| --- | --- | --- | --- | --- |
| A. 단순 전체시간 | `outputTokens / (durationMs / 1000)` | 요청 시작부터 완료까지의 output rate | 기존 행의 `usage.outputTokens`와 `durationMs`만으로 즉시 계산 가능 | TTFT, upstream 연결/큐잉, tool 실행, tail 전송을 분모에 포함하므로 decode rate보다 낮다 |
| B. TTFT 분리 | `outputTokens / ((durationMs - firstOutputMs) / 1000)` | 첫 모델 출력 뒤 완료까지의 평균 생성 속도 | 대기와 생성 속도를 분리하고 `firstOutputMs`도 같이 보여줄 수 있다 | first-output 훅과 신규 필드가 필요하며, 비스트리밍/tool-only에는 측정 불능 또는 정의 충돌이 생긴다 |

### A의 저평가 정도와 한계

`firstOutputMs = T`, 전체 `durationMs = D`, 실제 생성 구간을 `D - T`로 정의하면 A는 B의 `(D - T) / D`배다. 따라서 저평가 비율은 `T / D`다. 예를 들어 TTFT 2초·총 10초면 A는 B의 80% (20% 낮음), TTFT 8초·총 10초면 20% (80% 낮음)이다. 이는 위의 정의에서 도출한 계산이며 실제 trace로 검증한 값은 **미확인**이다.

또한 tool loop나 web-search-only 선행 구간은 `durationMs`에 들어가지만 output token 생성 시간은 아니다. bridge의 tool event와 web-search event는 text delta와 별도 event 타입이다. `src/types.ts:192-215`, `src/bridge.ts:507-570`

### 권장안

1차 릴리스는 **A를 `E2E tok/s` 또는 tooltip의 "output tokens / request duration"으로 명시**해 기존/과거 로그까지 즉시 표시한다. 열 제목을 단순 `tok/s`로 고정할 경우 decode 속도로 오해될 가능성이 있으므로, B 데이터가 생긴 뒤에만 `tok/s`라는 짧은 제목을 쓰고 tooltip에 "first output 이후"를 명시하는 편이 낫다.

동시에 2차로 **B를 권장 기준**으로 추가한다. `firstOutputMs`는 request start 기준 milliseconds이며, 분모가 0 이하이거나 output token이 없으면 값은 없게 한다. `reasoningOutputTokens`는 `outputTokens` 세부값으로 수집되므로 별도 가산하지 않는다; `OcxUsage`의 total은 `inputTokens + outputTokens`라는 규약이다. `src/types.ts:227-244`, `src/server/request-log.ts:214-263`.

## 3. TTFT / first-output 훅 후보와 경로별 정의

공통 권장 정의는 **"request start 뒤 처음 관측한 비어 있지 않은 모델 생성 payload의 시각"**이다. 이는 wire byte 첫 도착(heartbeat/메타데이터 제외)과 다르다. 아래 `firstOutputMs`에는 한 번만 `Date.now() - start`를 기록해야 한다. 정확히 어느 usage 토큰이 그 payload에 대응하는지는 provider가 제공하지 않으므로, B는 응답 전체 output usage와 관측된 생성 구간의 평균이다.

| 경로 | 후보 훅 (근거) | 첫 토큰/first output 정의 | 판단 |
| --- | --- | --- | --- |
| Native passthrough SSE | `trackSseForRequestLog()`는 현재 완전 SSE payload를 parse하여 inspect한다 (`src/server/relay.ts:142-187`). native body의 inspect branch는 `consumeForInspection()`에 연결된다 (`src/server/responses.ts:1157-1182`). | parsed Responses event 중 비어 있지 않은 `response.output_text.delta`, `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`를 첫 생성 payload로 한다. raw byte, `[DONE]`, `response.created`, heartbeat는 제외한다. 이벤트 문자열의 정확한 native 전수는 **미확인**; 현 relay는 payload JSON을 이미 검사한다. | `inspectResponseLogSsePayload()` 인접 또는 공유 helper가 가장 작은 훅이다. native client body는 marked response로 deferred wrapper를 우회하므로 그 wrapper만 고치면 누락된다. `src/server/relay.ts:200-280`, `src/server/responses.ts:1157-1193` |
| Adapter streaming | `adapter.parseStream()` → `bridgeToResponsesSSE()` 호출점은 `src/server/responses.ts:1522-1543`; bridge는 `text_delta`를 output-text SSE로, `thinking_delta`/`reasoning_raw_delta`를 reasoning SSE로 변환한다. `src/bridge.ts:428-505` | 비어 있지 않은 `text_delta`, `thinking_delta`, `reasoning_raw_delta` 중 첫 것. `heartbeat`, signature/redacted-only, tool-start는 제외한다. 숨긴 reasoning도 모델 출력으로 세려면 bridge switch 진입 전 event 자체에서 기록해야 한다; hide path는 출력 SSE를 생략한다. `src/bridge.ts:424-455`, `src/bridge.ts:489-505` | `bridgeToResponsesSSE` options에 one-shot callback을 추가해 event loop에서 호출하거나, `AdapterEvent`를 감싸는 wrapper가 적합하다. `src/bridge.ts:66-88`, `src/bridge.ts:407-428` |
| Routed non-streaming / queue non-streaming | queue 경로는 `await runTurn(); await queue.collect()` 후 한 번에 JSON을 만든다. `src/server/responses.ts:1280-1299`. adapter non-streaming도 `await adapter.parseResponse()` 후 JSON을 만든다. `src/server/responses.ts:1546-1563` | client에 관측 가능한 first delta가 없으므로 TTFT **없음 (`—`)**. parse/collect 종료를 TTFT라고 부르지 않는다. | A만 표시. 별도 `firstOutputMs = durationMs`를 저장하면 B 분모 0 및 의미 왜곡을 만든다. |
| tool-call만 있는 streaming 응답 | bridge는 `tool_call_start`에서 output item을 만들고 argument delta를 내보낸다. `src/bridge.ts:507-556` | 모델 "출력 이벤트"는 있으나 최종 `outputTokens`가 0일 수 있고, tool argument의 token 사용량이 별도 제공되지 않는다. tok/s의 first token은 **정의하지 않음**; `—`. | tool latency 지표가 필요하면 별도 `firstActivityMs`로 설계해야 하며 tok/s와 섞지 않는다. |
| reasoning-only 응답 | bridge는 thinking/raw-reasoning delta를 reasoning SSE로 낸다. `src/bridge.ts:454-505`; Responses usage parser는 `reasoning_tokens`를 보존한다. `src/server/request-log.ts:214-263` | `reasoningOutputTokens > 0` 또는 최종 `outputTokens > 0`일 때 첫 non-empty reasoning delta를 first output으로 한다. visible summary 숨김이어도 adapter event 기준으로 잡는다. | provider usage에서 reasoning이 `outputTokens`에 포함되는 것은 local `OcxUsage` total 규약에 부합하지만, provider별 원시 usage 포함 관계의 전수 검증은 **미확인**이다. 이 경우 tooltip에 "output includes provider-reported reasoning where supplied"를 명시한다. |

## 4. 엣지케이스 표시 정책

| 조건 | 근거 | 권장 표시/계산 |
| --- | --- | --- |
| `usageStatus=unreported` 또는 `unsupported` | 상태 enum과 저장 필드가 존재한다. `src/usage/log.ts:7-10`, `src/usage/log.ts:32-52` | `—`; 계산·정렬 숫자 없음. `$0`처럼 0으로 보이지 않게 한다. |
| estimated usage (cursor/kiro 또는 fallback) | cursor/kiro는 `estimated` 처리된다. `src/usage/log.ts:64-80`; fallback은 output 0을 만들 수 있다. `src/server/request-log.ts:510-535` | outputTokens > 0이면 `~12.3 tok/s`; outputTokens=0이면 `—` (추정 0을 실제 무출력으로 오인하지 않음). tooltip에 estimated를 표시한다. |
| reported `outputTokens=0` | usage parser는 0도 유효 number로 받아들인다. `src/server/request-log.ts:214-263` | `—` (0 tok/s가 아니라 output 없음/속도 비정의). 필요하면 tooltip: "no output tokens reported". |
| 실패 및 499 취소 | 499는 `client_cancel`로 정규화되며 failure diagnostics는 usage.jsonl에도 남는다. `src/server/request-log.ts:413-417`, `src/server/request-log.ts:95-125` | 종료 전 reported outputTokens > 0이면 A는 `~` 없이 실제 관측값(estimated면 `~`)을 보여도 된다. B는 firstOutputMs와 `durationMs > firstOutputMs`가 있을 때만 표시한다. usage 없음/0은 `—`. status가 실패라는 사실은 별도 status 열을 유지한다. |
| combo 여러 attempt | combo에서 attempt usage를 합산해 top-level usage를 만들며, optional reasoning/cache detail도 합산한다. `src/server/request-log.ts:609-655`; top-level은 combo model/provider로 바뀐다. `src/server/request-log.ts:436-441` | attempt마다 `usage.outputTokens / attempt.durationMs`는 이미 계산 가능하다. 그러나 top-level `sum(output) / top-level durationMs`는 retry/병렬 여부가 섞인 end-to-end 지표일 뿐 attempt decode 속도가 아니다. 1차 열은 top-level A를 보이고, 상세/향후 확장에 attempt별 A/B를 표시한다. TTFT도 attempt struct에 별도 저장해야 attempt B가 가능하다. |

## 5. jawcode 대조

jawcode는 DB에 `duration`과 nullable `ttft`를 별도로 저장한다. `jawcode/packages/stats/src/db.ts:60-85`, `jawcode/packages/stats/src/types.ts:23-34`. 그러나 집계 `avg_tokens_per_second`는 TTFT를 빼지 않고 `duration > 0 ? output_tokens * 1000 / duration : NULL`로 계산한다. overall과 model group 모두 동일하다. `jawcode/packages/stats/src/db.ts:420-470`.

따라서 jawcode의 현재 tok/s는 본 조사안 **A와 동일한 전체시간 정의**이고, TTFT는 병렬로 평균만 제공하는 별도 지표다. OpenCodex도 A를 즉시 제공하면 jawcode 비교 가능성을 유지한다. B를 추가하더라도 jawcode식 A를 대체하지 말고 `TTFT-adjusted tok/s` 같은 명시적 별도 의미로 제공해야 한다. jawcode가 어떤 runtime hook으로 `ttft`를 실제 측정하는지는 이 참고 범위에서 **미확인**이다(통계 parser는 원본 `msg.ttft`를 그대로 전달한다). `jawcode/packages/stats/src/parser.ts:129-137`.

## 6. 표시·API·영속 계층

- Logs 표 헤더는 time/tokens/model/effort/provider/status/request/duration 8열이며 duration은 마지막 열이다. tok/s는 tokens와 duration 사이 또는 duration 뒤가 자연스럽고, 추가 시 virtual padding `colSpan={8}`도 9로 바꿔야 한다. `gui/src/pages/Logs.tsx:193-209`, `gui/src/pages/Logs.tsx:219-269`
- GUI `LogEntry`는 API JSON을 로컬 interface로 받으므로 top-level `firstOutputMs`/`tokPerSec` 저장형을 도입하면 여기에도 optional 필드를 추가해야 한다. `gui/src/pages/Logs.tsx:22-43`
- 번역 키 원본은 `gui/src/i18n/en.ts`이고 `TKey`가 여기서 유도된다. ko/zh/de는 `Record<TKey, string>`이므로 새 `logs.col.tokPerSec` 및 status/tooltip 키는 네 파일 모두에 추가해야 한다. `gui/src/i18n/en.ts:285-305`, `gui/src/i18n/en.ts:874-876`, `gui/src/i18n/ko.ts:1-3`, `gui/src/i18n/zh.ts:1-3`, `gui/src/i18n/de.ts:1-3`
- `/api/logs`는 in-memory `getRequestLogEntries()` 결과를 filter 후 JSON 그대로 반환한다. 새 optional 필드는 `RequestLogEntry`에 붙이면 기존 소비자는 알 수 없는 JSON property를 무시할 수 있어 additive 하위호환이다. 다만 외부 소비자의 strict schema 동작은 이 저장소에서 **미확인**이다. `src/server/management-api.ts:313-315`, `src/server/request-log.ts:483-501`, `src/server/request-log.ts:658-661`
- `usage.jsonl`은 `addRequestLog()`가 request log를 `PersistedUsageEntry`로 투영해 append한다. `src/server/request-log.ts:95-129`. reader는 JSON line을 읽고 normalize하며, optional unknown field를 버리는 normalize 방식이다. `src/usage/log.ts:191-210`, `src/usage/log.ts:227-243`. 따라서 `firstOutputMs?: number`을 entry/attempt에 optional로 추가하고 normalizer의 finite/nonnegative validation 및 output에 넣으면: 기존 줄(필드 없음)은 읽히고, 새 줄은 구버전 reader가 무시해 읽히는 additive 호환이다. 이 구버전 동작은 normalizer의 spread/선택 필드로부터의 코드상 판단이며 실제 구버전 재현은 **미확인**이다.

## 7. 제안 구현 범위와 순서 (코드 변경은 본 조사 범위 밖)

### 예상 변경 파일

| 구분 | 파일 | 이유 |
| --- | --- | --- |
| MODIFY | `src/server/request-log.ts` | `RequestLogEntry`/context에 optional `firstOutputMs`, final/attempt 투영, combo 정책 연결 |
| MODIFY | `src/usage/log.ts` | `PersistedUsageEntry`·`PersistedUsageAttempt` optional 필드와 JSONL normalize/validation |
| MODIFY | `src/server/relay.ts` | native SSE payload에서 first output event one-shot 기록 |
| MODIFY | `src/server/responses.ts` | native inspection 및 adapter bridge에 callback/context 전달 |
| MODIFY | `src/bridge.ts` | adapter event loop의 text/thinking/raw-reasoning first-output callback |
| MODIFY | `gui/src/pages/Logs.tsx` | API type, 안전한 계산/표시, 열 수/colSpan |
| MODIFY | `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`, `gui/src/i18n/zh.ts`, `gui/src/i18n/de.ts` | 열 제목·tooltip·`—`/estimated 설명 |
| MODIFY | `tests/request-log.test.ts`, `tests/bridge.test.ts`, `tests/bridge-lifecycle.test.ts`, `tests/passthrough-abort.test.ts` | final/attempt persistence, adapter first delta, terminal/cancel/native regression 검증 대상 (정확한 test case 위치는 구현 시 재확인 필요) |
| NEW | 없음 | tok/s 자체는 기존 로그 파이프라인 확장으로 충분하다. |

### 권장 구현 순서

1. **계측**: context/attempt에 `firstOutputMs`를 정의하고 native SSE와 adapter event 두 경로에서 first non-empty text/thinking/raw-reasoning을 one-shot 기록한다. 비스트리밍·tool-only는 의도적으로 unset이다.
2. **영속**: request와 attempt의 optional `firstOutputMs`를 `usage.jsonl` 정규화에 추가한다. 과거 로그는 값 없음으로 유지한다.
3. **API**: `RequestLogEntry`에 optional field를 포함시켜 `/api/logs` additive response로 노출한다. 서버에서 숫자 `tokPerSec`를 저장하지 말고 원천 시간·usage만 저장해 정의 변경에 대비한다.
4. **GUI**: A를 과거/TTFT 없는 행의 fallback으로, B를 TTFT가 있는 행의 권장 표시로 계산한다. unreported/unsupported/0은 `—`, estimated 양수는 `~` 접두로 통일한다.

이 순서는 현재 final log가 request/attempt usage와 duration을 한 곳에서 결합하고, `/api/logs`가 그 객체를 그대로 전달하며, GUI가 이미 usageStatus의 estimated 표시에 `~`를 쓰기 때문에 가장 적은 계약 확장으로 연결된다. `src/server/request-log.ts:399-468`, `src/server/management-api.ts:313-315`, `gui/src/pages/Logs.tsx:220-246`.
