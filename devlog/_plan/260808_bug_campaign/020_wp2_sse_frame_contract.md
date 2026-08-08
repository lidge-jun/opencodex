# 020 — WP2: SSE 프레임 파싱 계약 (#1219 + #1249)

선행: WP1. 절차: `003_republish_protocol.md`.

## 문제의 정확한 형태

이슈 #1219는 "SSE 프레임이 `null` 로 파싱되면 세 어댑터가 모두 크래시한다" 고
보고했다. 현재 `origin/dev` 에서 그대로 재현된다.

`src/adapters/openai-chat.ts:961-967`:

```ts
chunk = JSON.parse(payload) as Record<string, unknown>;
```

`:972`:

```ts
if (chunk.error !== undefined && chunk.error !== null)
```

`JSON.parse("null")` 은 예외를 던지지 않고 `null` 을 반환한다. 캐스팅은 타입 체커만
속일 뿐 런타임에는 아무것도 하지 않으므로 `null.error` 역참조가 일어난다.

같은 결함이 세 곳 더 있다: `src/adapters/google.ts:500-510`,
`src/adapters/anthropic.ts:987-995`, `src/web-search/parse.ts:158-163`.

## PR #1240 — 재작업 불필요로 정정됨 (2026-08-08 게이트 실행)

> **이 절의 원래 결론은 뒤집혔다.** WP1 라이브 게이트가 #1240의 head 변경을
> 잡아냈고(`f155138c` → `965dd9901`), 재검토 결과 **작성자가 이미 종료 동작을
> `continue` 로 고쳤다.** 아래 분석은 왜 종료가 틀렸는지에 대한 기록으로 남기되,
> 우리가 직접 재구현하는 §020-1 계획은 **폐기한다.** 상세는 `011` 문서 참조.
>
> 새 계획: #1240을 채택한다. 코드 재작업 없음. PR 본문의 낡은 설명만 정정 요청.

### 원래 분석 (기록용)

#1240(snowyukitty)은 이 결함을 정확히 찾았지만 **처리 방식이 틀렸다.** 비레코드
프레임을 malformed로 보고 스트림을 종료시킨다.

이슈 스레드의 리포터 정정에 따르면 `data: null` 은 스트림 **중간에** 나타난다.
일종의 패딩/킵얼라이브다. 여기서 종료하면 뒤따르는 finish 청크와 `[DONE]` 을
통째로 버린다. 즉 크래시를 응답 절단으로 바꾸는 셈이다.

올바른 동작은 건너뛰기다.

## 020-1 · #1219 — #1240 채택으로 대체 (직접 구현 폐기)

원래 계획은 네 파서를 우리가 직접 고치는 것이었다. #1240의 새 head가 그 일을
이미 정확히 해냈으므로 폐기한다.

채택 대상: head `965dd990114fc6203297475142a28fcd7cb44642`
`Co-authored-by: snowyukitty <270071858+snowyukitty@users.noreply.github.com>`

확인된 구현(재검토 근거):

- `src/adapters/openai-chat.ts:978-980`, `src/adapters/google.ts:513-515` 가
  비레코드 프레임에서 `return "continue"`
- Google은 `sawAnyFrame = true`(`:517`) 이전에 처리해 빈 스트림 가드 보존
- Anthropic `:994-1001`, web-search `parse.ts:162-174` 도 건너뛰기로 일관
- `tests/sse-null-data-frame.test.ts` 가 유효 청크 사이 `data: null` 후 완주를
  확인(`:55-62`, `:101-107`)하고 전량 비레코드는 fail-closed 확인(`:109-116`)

해야 할 일: PR 본문의 "emit ... error and terminate" 설명을 현재 동작에 맞게
정정하도록 요청한다. `#1219` `Closes` 링크 확인.

<details>
<summary>폐기된 직접 구현 계획 (기록용)</summary>

새 브랜치 `codex/260808-sse-non-record-frames`
원작자 보존: `Co-authored-by: snowyukitty <270071858+snowyukitty@users.noreply.github.com>`
해소 이슈 **#1219**, supersedes **#1240**

### MODIFY `src/adapters/openai-chat.ts`

현재 `:961-972` 를 다음 형태로:

```ts
let parsed: unknown;
try {
  parsed = JSON.parse(payload);
} catch {
  // 구문적으로 잘못된 JSON은 여전히 종료성 malformed 오류
  return malformedFrameError(payload);
}

// 유효 JSON이지만 레코드가 아닌 프레임(null, 배열, 스칼라)은 패딩으로 보고 건너뛴다
if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  return "continue";
}

const chunk = parsed as Record<string, unknown>;
```

핵심은 두 경우를 구분하는 것이다. **구문 오류는 종료**(진짜 손상된 스트림),
**유효 JSON 비레코드는 건너뛰기**(패딩).

### MODIFY `src/adapters/google.ts`

`:500-510` 에 동일 패턴. Google도 스트림 중간 패딩이 가능하므로 `continue`.

### MODIFY `src/adapters/anthropic.ts`

`:987-995`. Anthropic 경로는 기존대로 malformed/비레코드 프레임을 **건너뛴다**
(종료하지 않는다). 역참조 전에 형태를 검증하는 것만 추가한다.

### MODIFY `src/web-search/parse.ts`

`:158-163`. 사이드카도 건너뛰기 유지.

### NEW `tests/sse-non-record-frames.test.ts`

네 파서 각각에 대해:

- `data: null` 이 유효 청크 **사이에** 있을 때 → 후속 청크와 `[DONE]` 이 온전히
  처리된다 (이것이 #1240 대비 핵심 회귀)
- `data: []`, `data: 42`, `data: "text"` → 동일하게 건너뛴다
- `data: {broken` → 종료성 오류 유지

활성화 증거(C-ACTIVATION-GROUNDING-01): 단순히 "크래시 안 함" 이 아니라, null
프레임 **이후** 청크가 실제로 소비되었음을 어서션한다. 종료 동작이었다면 red가
되는 테스트여야 한다. 먼저 #1240 방식으로 구현해 red를 확인한 뒤 `continue` 로
바꿔 green을 만든다.

</details>

## 020-2 · #1249 빈 data 프레임 (스택 상단)

원작자 `Yuxin Qiao <104957188+Yuxin-Qiao@users.noreply.github.com>`
원본 브랜치 `Yuxin-Qiao:fix/openai-chat-empty-data-frame`
원본 커밋 `20c7afb5`
새 브랜치 `codex/260808-sse-empty-data-frame` (base: `codex/260808-sse-non-record-frames`)

### MODIFY `src/adapters/openai-chat.ts`

현재 `:951-963` 이 `trim()` 직후 `[DONE]` 검사와 `JSON.parse` 로 진행한다. 빈
`data:` 는 `JSON.parse("")` 로 가서 종료성 오류가 된다.

가드를 `[DONE]` 검사 **앞에** 넣는다:

```ts
const payload = rawPayload.trim();
if (payload.length === 0) return "continue";
if (payload === "[DONE]") { ... }
```

### 두 변경의 최종 합성 결과

```ts
const payload = rawPayload.trim();
if (payload.length === 0) return "continue";        // 020-2
if (payload === "[DONE]") { ... }

let parsed: unknown;                                 // 020-1
try { parsed = JSON.parse(payload); }
catch { return malformedFrameError(payload); }

if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  return "continue";
}
const chunk = parsed as Record<string, unknown>;
```

두 훅은 같은 줄을 건드리지 않는다(020-2는 현재 953행 뒤 삽입, 020-1은 961행부터
변경). 스택으로 쌓아도 충돌하지 않는다.

### MODIFY `tests/sse-unspaced-data-fields.test.ts`

빈 페이로드 케이스 추가.

## 020-3 · #1205 reasoning placeholder 주입 (스택 상단)

원작자 `Yuxin Qiao <104957188+Yuxin-Qiao@users.noreply.github.com>`
원본 브랜치 `Yuxin-Qiao:fix/issue-1193-reasoning-placeholder`
원본 커밋 `77ee3325b`, `48961a91e`, `61283a42f`
새 브랜치 `codex/260808-reasoning-replay-placeholder` (base: `codex/260808-sse-empty-data-frame`)
해소 이슈 **#1193**

### 결함

`preserveReasoningContentModels` 가 replay 캐시에 의존하는데, 긴 세션에서 캐시가
미스나면 reasoning 없이 bare `tool_call` continuation을 보낸다. DeepSeek thinking
모드가 이를 400으로 거부한다.

### 수정

MODIFY `src/adapters/openai-chat.ts` — 캐시 미스 시 placeholder reasoning을
주입해 계약을 만족시킨다. 같은 파일을 020-1, 020-2가 이미 건드리므로 이 순서로
스택 상단에 놓는다.
MODIFY `src/providers/registry.ts`, `src/providers/derive.ts`, `src/router.ts`,
`src/types.ts`
MODIFY `src/oauth/index.ts`, `src/oauth/login-cli.ts`, `src/server/auth-cors.ts`
MODIFY `tests/deepseek-reasoning-replay-gaps.test.ts`,
`tests/oauth-provider-reconcile.test.ts`
MODIFY docs 5개 로케일 `reference/configuration/providers.md`

**범위 확인 필요:** OAuth와 CORS 파일이 포함된 이유가 불명확하다. reasoning
placeholder와 무관해 보이므로 리베이스 시 해당 훅이 정말 필요한지 확인하고,
무관하면 제외해 범위를 좁힌다(`enforce-target` 의 focused-scope 체크리스트).

활성화 시나리오:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| 캐시 미스 | replay 캐시를 비운 채 tool_call continuation 요청 | placeholder reasoning이 실제로 주입됨. 400 아님 |
| 캐시 히트 | 정상 캐시 상태 | 기존 reasoning 그대로 사용. placeholder 미주입 |

캐시 히트 케이스가 중요하다. 항상 placeholder를 넣으면 원본 reasoning을 덮어쓴다.

## WP2 수용 기준 (채택 기준으로 전환)

§020-1이 폐기되어 신규 브랜치 생성 요구를 제거했다. 남은 것은 기여자 PR의
착지 조건이다.

- **#1240 채택**: CI green 확인 후 머지 승인 요청. 코드 수정 없음. 착지 시
  #1219 close
- **#1249 채택**: #1240 착지 후 리베이스가 필요한지 확인. 같은 파일의 다른
  줄이므로 충돌은 없을 것으로 예상하되 실제로 확인한다
- **#1205 채택 검토**: OAuth/CORS 훅이 reasoning placeholder와 무관해 보이므로
  범위 확인. 무관하면 분리 요청. 착지 시 #1193 close
- 각 PR의 CI가 green이어야 한다. 우리가 새로 돌릴 로컬 검증은 없다 —
  기여자 브랜치의 CI가 그 역할을 한다
- 공유 어댑터(`src/adapters/openai-chat.ts`)를 셋이 함께 건드리므로 **착지
  순서를 정하고 각 착지 후 dev 전체 스위트 green을 확인**한다
- null 프레임 이후 청크 소비 증거 확보 (종료 동작에서 red였음을 보인 기록 포함)
