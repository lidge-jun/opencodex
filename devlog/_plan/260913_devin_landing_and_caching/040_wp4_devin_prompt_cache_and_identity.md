# 040 — wp4: Devin 프롬프트 캐시와 자격증명 identity

목표는 "Plus와 omp보다 훨씬 좋게"다. 조사 결과 그 목표가 구체적으로 무엇인지가
분명해졌다: 세 구현이 각자 다른 반쪽을 갖고 있고, 아무도 전부를 갖고 있지 않다.

| 능력 | 네이티브 CLI | Plus | opencodex 오늘 | wp4 이후 |
|---|---|---|---|---|
| 세션/캐스케이드 재사용 | 있음 (`sessions.db`) | **없음** (매 요청 새로) | 있음 | 있음 |
| 프롬프트 캐시 옵션 f13 | 있음 (원격) | 있음 (항상) | **없음** | 있음 |
| 캐시 identity 격리 | 있음 (`identity_digest`) | 요청 스코프라 무관 | **없음** (계정 누수) | 있음 |
| 카탈로그 TTL | 없음 | 없음 | 있음 (10분) | 있음 |
| `invalid_argument` cooldown 회피 | 해당 없음 | 있음 | **없음** | 있음 |
| rune-safe tool 절단 | 해당 없음 | 있음 (1024B) | **없음** (JS slice) | 있음 |

## 근거 1 — 우리는 프롬프트 캐시를 아예 요청하지 않는다

`chat.ts:54-60`의 주석은 세션 재사용이 "prompt-cache hit ratio"를 살린다고 말한다.
그런데 요청 인코더(`chat.ts:650-673`)가 실제로 쓰는 필드는 1, 2, 3, 7, 8, 10, 15, 16,
20, 21뿐이다. 캐시 옵션 필드가 없다.

Plus는 매 요청에 넣는다 (`internal/runtime/executor/devin_request.go:23,35,335`):

```go
devinReqCacheOptionsField  = 13
devinCacheControlEphemeral = 1

// devinEncodeCacheOptions encodes PromptCacheOptions{type: EPHEMERAL}.
//
// The native client marks the system prompt as an ephemeral cache entry, which
// is what makes prompt caching effective across turns.
func devinEncodeCacheOptions() []byte {
	return devinEncodeField(nil, 1, 0, devinEncodeVarint(nil, devinCacheControlEphemeral))
}
```

네이티브 바이너리도 원격 프롬프트 캐시를 쓴다 — `prompt_cache_key_base`,
`disable_prompt_cache_writes`, `system_prefix_len`, `append_only_history` 필드와
`affogato/src/cache_keepalive.rs`의 `[CACHE_KEEPALIVE] Ping sent`(TTL clamp 1–60s).
`~/.local/share/devin/cli/sessions.db`의 assistant 지표에 `cache_read_tokens`가
42808, 59704처럼 실제로 찍혀 있다. 캐시는 동작하고, 값이 크다.

즉 Plus는 캐시 옵션은 보내지만 세션을 매번 버려서(`devin_executor.go:626-637`) 캐시
키가 흩어지고, 우리는 세션은 지키는데 캐시 옵션을 안 보낸다. 둘 다 반쪽이다.

## 근거 2 — 캐시가 계정 사이로 샌다

`chat.ts:73`의 키는 `${host}\x1f${apiKey}`다. JWT 캐시(`auth.ts:191-214`)와
카탈로그 캐시(`catalog.ts:54`)도 같은 `(host, apiKey)` 싱글톤이다. 그런데:

- `clearSessionIds`(`chat.ts:94`)는 export되어 있지만 **호출하는 곳이 없다**.
- `src/server/management/oauth-account-routes.ts:349-374`의 logout/remove만 JWT와
  카탈로그를 지우고, 계정 **전환**은 cloud-direct 캐시를 건드리지 않는다.
- `devin.ts:273-318`의 cascade-id Map은 스레드 키라 logout 후 새 계정에 이전
  cascade가 그대로 붙는다.

네이티브 CLI는 이 문제를 이미 풀어 뒀다. `~/.cache/devin/cli/*.bin` 봉투가
`identity_digest`를 갖고, 다른 identity로 쓰인 캐시는 거부한다:
`Ignoring cache file : written under a different identity`.

## MODIFY: src/adapters/devin/cloud-direct/chat.ts — 캐시 옵션 필드

`buildChatRequest`의 `Buffer.concat` 배열에 필드 13을 추가한다. 필드 번호 순서상
`encodeMessage(10, ...)` 토큰들과 `encodeMessage(15, ...)` 사이다.

```ts
// after ...toolParts,
    // #13 prompt_cache_options: { type: EPHEMERAL }. The native client marks the
    // system prefix as an ephemeral cache entry; without it the server does not
    // create a cache entry at all and every turn re-reads the full prefix.
    // Verified against the native CLI (cache_read_tokens 42808/59704 in
    // ~/.local/share/devin/cli/sessions.db) and CLIProxyAPIPlus
    // devin_request.go:335 devinEncodeCacheOptions.
    encodeMessage(13, encodeVarintField(1, PROMPT_CACHE_EPHEMERAL)),
```

`const PROMPT_CACHE_EPHEMERAL = 1;`를 파일 상단 상수와 함께 둔다.

## MODIFY: chat.ts / auth.ts / catalog.ts — identity 키

세 캐시가 같은 identity 개념을 공유하게 한다. 자격증명 원문을 키로 쓰지 않는다.

```ts
/**
 * Cache identity for a Devin credential. The native CLI stores an
 * identity_digest beside every cache envelope and refuses an entry written
 * under a different identity; without that, switching accounts silently
 * serves the previous account cached session, catalog and JWT.
 * The digest never contains the credential itself.
 */
export function devinCacheIdentity(apiKey: string, host: string): string {
  const digest = createHash("sha256").update(`${host}\x1f${apiKey}`).digest("hex");
  return digest.slice(0, 16);
}
```

`getOrAllocateSessionIds`, JWT 캐시, 카탈로그 캐시가 모두 이 값을 키로 쓴다.
해시로 바꾸는 것 자체가 부수 이득이다 — 지금은 Map 키에 API 키 원문이 들어 있고,
힙 덤프나 디버거에 그대로 노출된다.

## MODIFY: 계정 전환 시 소거 (identity 스코프 전용)

전역 `clearSessionIds`는 **삭제한다**. 남겨 두면 함정이다.
`oauth-account-routes.ts:281`의 per-provider logout이 그것을 부르는 순간 다른 계정의
진행 중인 턴까지 session/cascade를 잃는다. 지금까지 호출자가 0건이었던 이유가
그것이며, 안전하게 부를 수 있는 자리가 애초에 없다.

대신 identity 스코프 무효화 하나만 남긴다.

| 경로 | 호출 |
|---|---|
| per-provider logout / remove | `invalidateSessionIdentity(devinCacheIdentity(apiKey, host))` |
| 계정 전환 (activate/select) | 같음, 떠나는 identity에 대해 |
| 전체 종료 | 없음 — 프로세스가 사라지면 Map도 사라진다 |

`devin.ts:273`의 cascade Map도 같은 identity 기준으로 해당 항목만 버린다.

단위 테스트로 고정한다:

- 계정 A로 한 턴 → 계정 B로 전환 → B의 요청이 A의 sessionId/cascadeId를 재사용하지 않는다.
- 계정 A의 턴이 **진행 중**일 때 B를 로그아웃해도 A의 턴은 자기 sessionId를 유지한다.
- 전역 소거 함수가 존재하지 않는다 (export 표면 회귀).

## MODIFY: src/adapters/devin.ts — `invalid_argument`가 cooldown을 태우지 않게

Plus는 `invalid_argument`를 HTTP 400으로 재분류해 자격증명 cooldown을 건너뛴다
(`devin_executor.go:959-983`, `devin_cooldown_test.go:9-15`). 우리 `devinErrorClassification`
(`devin.ts:53-64`)에는 그 분기가 없어서, 우리가 만든 잘못된 요청 하나가 멀쩡한
자격증명을 식힌다.

```ts
if (status === 400) return { status, errorType: "invalid_request_error", retryable: false };
```

와 함께 Connect trailer `invalid_argument`를 400으로 매핑한다.

## MODIFY: rune-safe tool 설명 절단

`chat.ts:586-587`은 JS `slice(0, 6998)`이다. UTF-16 코드 유닛 기준이라 한글이나
이모지 중간에서 잘리고, 그 결과가 `invalid_argument: an internal error occurred`다.
Plus는 1024바이트 rune-safe 절단을 쓴다(`devin_tools.go:125-151`).

바이트 예산으로 바꾸고 코드포인트 경계에서 자른다. 한국어로 도구를 설명하는
사용자에게 직접 영향이 있다.

## MODIFY: usage 회계에 캐시 읽기를 노출

field 7 `ModelUsageStats`가 과금 권위다(`chat.ts:927-959`). 네이티브가
`cache_read_tokens`를 기록하므로 우리도 파싱해 usage에 싣는다. `cache_creation_tokens`는
네이티브 실측에서 전부 null이라 기대하지 않는다.

## NEW: tests/adapters/devin/cloud-direct-prompt-cache.test.ts

| 케이스 | 기대 |
|---|---|
| 인코딩된 요청에 필드 13이 존재하고 값이 EPHEMERAL | 바이트 단언 |
| 같은 identity의 두 턴이 같은 sessionId/cascadeId | 재사용 회귀 |
| identity가 다르면 새 sessionId | 계정 누수 회귀 |
| logout 후 해당 identity만 소거 | `invalidateSessionIdentity` 회귀, 타 identity 생존 |
| 400/`invalid_argument`가 `retryable:false`, cooldown 없음 | 분류 회귀 |
| 7000바이트 한글 도구 설명이 유효한 UTF-8로 절단 | rune-safe 회귀 |

## 하지 않는 것

- 추론 토큰이나 응답 본문을 로컬 디스크에 캐시하지 않는다 (레인 A 권고).
- 캐시 keepalive ping은 이번 범위에서 제외한다. 네이티브는 하지만 프록시가 사용자
  턴 밖에서 업스트림을 두드리는 것은 별도 결정이 필요하다. 후속 단위로 남긴다.
- `sessions.db` 같은 로컬 SQLite 세션 저장소는 만들지 않는다. 프로세스 내 Map으로
  충분하고, 디스크 상태는 계정 누수 표면을 넓힌다.


## 감사 반영 (A 단계, BLOCKER-3)

`clearSessionIds()`를 그대로 부르면 안 된다. 구현이 `sessionCache.clear()`(`chat.ts:95`)라
전역 소거다. 계정을 전환하는 순간 **다른 계정의 진행 중인 턴**까지 session/cascade를
잃는다. 프록시는 멀티테넌트이므로 이건 새 버그를 만드는 수정이다.

identity 스코프 삭제로 바꾼다.

```ts
/**
 * Drop cached IDs for ONE identity. A global clear() would strip the session
 * and cascade of every other account mid-turn, which is why the old exported
 * clearSessionIds() was never safe to call and consequently never called.
 */
export function invalidateSessionIdentity(identity: string): void {
  sessionCache.delete(identity);
}
```

동시성은 epoch로 막는다. 캐시 엔트리에 `epoch`를 달고, 요청 시작 시 읽은 epoch와
응답 조립 시점의 epoch가 다르면 그 턴은 캐시를 갱신하지 않는다. 진행 중인 턴은
자기 sessionId로 끝까지 가고, 다음 턴부터 새 identity를 쓴다.

```ts
interface SessionIds { sessionId: string; cascadeId: string; epoch: number; }
```

재감사(near-pass)가 남긴 잔여 지적을 반영해, 기존 `clearSessionIds`는 남기지 않고
**제거한다**. "전체 로그아웃 전용"으로 문서화만 하는 안은 함정이 그대로 남는다 —
`oauth-account-routes.ts:281`의 per-provider logout이 그것을 부르면 타 계정의 진행 중인
턴이 끊긴다. 안전한 호출 지점이 없는 함수는 export 표면에서 없애는 것이 맞다.
계정 전환과 로그아웃 모두 `invalidateSessionIdentity` 하나만 쓴다.

테스트에 케이스를 하나 더 넣는다: 계정 A의 턴이 진행 중일 때 계정 B로 전환해도
A의 턴은 자기 sessionId를 유지한다.

## 감사에서 통과한 항목

가장 위험했던 와이어 포맷은 확인됐다. `encodeMessage(13, encodeVarintField(1, 1))`은
Plus의 Go 인코더와 바이트가 같다 — `6a 02 08 01`. 필드 13, wire type 2(length-delimited),
길이 2, 내부 필드 1 varint 1. `PromptCacheOptions{type: EPHEMERAL}`에 정확히 맞는다.

sha256 캐시 키 전환도 안전하다. 그 키를 파싱하거나 재구성하는 호출자나 테스트가 없다.
이 계획에 자격증명을 로그·파일명·오류 메시지에 넣는 단계도 없다.

