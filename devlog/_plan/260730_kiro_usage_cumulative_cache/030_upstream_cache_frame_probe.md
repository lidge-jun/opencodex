# 030 — 상류 캐시 프레임 미보고를 증명하고 경로를 열어둔다

의존: 010

## 문제

5202개 kiro 행 중 0개가 캐시 필드를 갖는다. 직렬화는 캐시 필드를 보존하므로
(`src/usage/log.ts:132-134`) 값이 애초에 도착하지 않는다는 뜻이다. 두 가설이 남는다.

- H1: CodeWhisperer가 `metadataEvent.tokenUsage`를 아예 보내지 않는다.
- H2: 보내지만 우리가 읽는 키 이름이 다르다 (예: 다른 wire client 프로필에서 필드명 상이).

`commit 28996a4cf fix(kiro): use CLI wire contract without profiles`가 wire client를
바꿨으므로 H2를 완전히 배제할 수 없다.

## 조사 방법 (비파괴, 자격증명 불필요한 것 우선)

1. `parseKiroEvent`가 `metadataEvent`를 받았는데 `tokenUsage`가 없을 때를 세는
   진단 카운터를 `debugProviderDiagnostic("kiro", ...)` 경로로 확인한다. 이미 존재하는
   `context_usage` 진단(`src/adapters/kiro.ts:1099`)과 같은 계층이며 요청 본문을
   로깅하지 않는다 — privacy 스캔 위반이 아니다.
2. `KNOWN_EVENT_TYPES`(`src/adapters/kiro-events.ts:14-22`)에 없는 이벤트 타입이
   조용히 무시되고 있는지 확인한다. `parseKiroEvent`는 미지 타입을 `null`로 버린다.
   상류가 사용량을 별도 이벤트로 보낸다면 여기서 사라진다.
3. `~/.opencodex/usage-debug.jsonl`(2026-07-09자, 264KB)에 kiro 프레임 샘플이 있는지 확인.

## 판정 — H1 확정 (정적 증명 완료)

**상류는 `tokenUsage`를 보내지 않는다.** 자격증명 없이 결정적으로 증명됐다.

증명 논리: `parseTokenUsage()`는 `totalTokens`를 `required: true`로 읽는다
(`src/adapters/kiro-events.ts:74`). 즉 **authoritative usage가 한 번이라도 도착하면
반환 객체에 `totalTokens`가 반드시 포함된다.** 현재 코드에서 `usage()`의 fallback base는
`{ inputTokens, outputTokens, estimated }`뿐이고 `totalTokens`를 만들지 않는다
(`src/adapters/kiro.ts:775-778`).

따라서 `usage.totalTokens`의 존재 여부가 authoritative 프레임 도착의 리트머스지다.
실측 (`~/.opencodex/usage.jsonl`, kiro usage 객체 5691개):

| usage 필드 조합 | 행 수 | 기간 |
|---|---|---|
| `inputTokens, outputTokens, totalTokens, estimated` | 4736 | 06-30 ~ **07-01만** |
| `inputTokens, outputTokens, estimated` | 611 | 06-29 ~ **07-30 (현재)** |
| `inputTokens, outputTokens` | 347 | 초기 |

최신 행(07-30 07:54)은 `{"inputTokens":49,"outputTokens":13,"estimated":true}` —
`totalTokens` 없음. 캐시 필드도 0건. `parseTokenUsage`가 실행됐다면 둘 다 있어야 한다.
**결론: `authoritativeUsage`는 undefined 상태로 남는다. 상류 미보고 확정.**

### 4736개 큰 totalTokens 행의 정체 (H2 배제)

06-30~07-01 구간의 큰 `totalTokens`(예: 217233, 367980)는 authoritative 프레임이
아니다. `commit 7374c3ac8 fix(kiro): use context usage percentage for totals`(06-29)이
`contextUsagePercentage × contextWindow`를 **`totalTokens`에 직접** 넣던 시기의 산물이다.
이후 `contextTotalTokens`라는 전용 필드로 옮겨졌고(fc5170049), 그 필드가 지속 계층에서
버려지면서 큰 숫자가 사라졌다. 즉 사용자가 기억하는 "누적으로 패치된 상태"는 실재했고,
`totalTokens` → `contextTotalTokens` 이관 과정에서 소실된 것이다. 이번 수정이 복원한다.

같은 이유로 H2(키 이름 drift)는 배제된다. 큰 숫자의 출처가 상류 캐시 프레임이 아니라
우리 자체 계산이었으므로, 상류 필드명이 바뀐 흔적이 아니다.

## 변경 (조사 결과에 따라 분기)

**H1 확정 → 코드 변경 없음.** `logs.tokens.noCache`(캐시 미보고) 라벨은 정직한
상태 표시이므로 유지한다. 파서는 이미 `cacheReadInputTokens` /
`cacheWriteInputTokens`를 매핑하고 있어, 상류가 언젠가 보내기 시작하면 코드 수정 없이
즉시 c/w가 표시된다. 경로는 열려 있다.

캐시 c/w 요구는 **상류 제약으로 닫는다.** CodeWhisperer는 Anthropic `/v1/messages`나
OpenAI-chat과 달리 per-turn 캐시 분해를 노출하지 않는다. 없는 숫자를 추정으로 채우면
대시보드가 거짓말을 하게 되므로 하지 않는다.

## 회귀 테스트

`tests/kiro-stream.test.ts`

1. `tokenUsage` 없는 `metadataEvent`(예: `contextUsagePercentage`만) → 캐시 필드를
   만들어내지 않고 `estimated: true`가 유지된다. 조작된 숫자를 지어내지 않음을 못 박는다.
2. H2로 새 키를 매핑한 경우, 새 키와 기존 키 각각에 대한 케이스.

## 위험

- 낮음. 진단 확인은 읽기 전용이고, 코드 변경은 조사 결과가 뒷받침할 때만 한다.
- 상류가 보내지 않는 숫자를 추정으로 채워 캐시 분해처럼 보이게 하는 것은 금지다.
  그건 대시보드를 거짓말하게 만든다. `캐시 미보고`는 정직한 상태 표시다.
