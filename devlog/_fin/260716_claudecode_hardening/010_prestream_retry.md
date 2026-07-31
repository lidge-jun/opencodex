# 010 — pre-stream transient 5xx 재시도 (passthrough)

## 목표

ChatGPT passthrough에서 SSE first byte 이전에 받은 transient 5xx 응답을 프록시가
직접 짧은 백오프로 재시도한다. 48h 레저상 502 직후 초 단위 재시도가 200을 받은
패턴(23:24:35, 23:25:54)이 근거. 기존 `fetchWithResetRetry`(thrown reset 전용)
계약은 그대로 두고, 상태코드 계층을 그 위에 얹는다.

## 변경 파일

### MODIFY `src/lib/upstream-retry.ts` (leaf module 유지 — server import 금지)

추가 1 — transient 분류 (020에서도 재사용):

```ts
/** Upstream statuses treated as transient: gateway errors and Cloudflare 52x.
 *  500 is included per the OpenAI SDK default (auto-retries >=500, Tier-2 proven in
 *  devlog/260716_ocx_claude_sol_502_midstream/02). 507 was observed in the 48h ledger
 *  but is deliberately excluded (storage-class, not gateway-transient). */
export function isTransientUpstreamStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504
    || status === 520 || status === 521 || status === 522;
}
```

추가 2 — 상태코드 재시도 래퍼 (기존 fetchWithResetRetry 아래):

```ts
const TRANSIENT_RETRY_MAX_ATTEMPTS = 3;   // 1 initial + 2 retries
const TRANSIENT_RETRY_BASE_DELAY_MS = 400;
const TRANSIENT_RETRY_MAX_DELAY_MS = 5_000;
// 감사 blocker #2: slow-5xx(사건 원형 191s 502)는 재시도가 순수 중복 부하 — attempt가
// 이 예산을 넘겨 실패했으면 재시도하지 않는다.
const TRANSIENT_RETRY_SLOW_ATTEMPT_MS = 15_000;

/** fetchWithResetRetry + transient-5xx status retry, pre-stream only: a returned
 *  Response has by definition not streamed to the client yet; the failed body is
 *  cancelled before the retry. Honors Retry-After via retryBackoffDelayMs.
 *  A slow failed attempt (> TRANSIENT_RETRY_SLOW_ATTEMPT_MS) is returned as-is:
 *  retrying the slow-502 shape only duplicates upstream load past client timeouts. */
export async function fetchWithTransientRetry(
  doFetch: () => Promise<Response>,
  opts: ResetRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? TRANSIENT_RETRY_MAX_ATTEMPTS);
  let attemptStart = Date.now();
  let res = await fetchWithResetRetry(doFetch, opts);
  for (let attempt = 0; attempt < attempts - 1; attempt++) {
    if (res.ok || !isTransientUpstreamStatus(res.status)) return res;
    if (opts.abortSignal?.aborted) return res;
    if (Date.now() - attemptStart > TRANSIENT_RETRY_SLOW_ATTEMPT_MS) return res;
    console.warn(`[upstream-retry] transient ${res.status}${opts.label ? ` (${opts.label})` : ""} — retrying (${attempt + 2}/${attempts})`);
    const delay = retryBackoffDelayMs(attempt, {
      baseDelayMs: TRANSIENT_RETRY_BASE_DELAY_MS,
      maxDelayMs: TRANSIENT_RETRY_MAX_DELAY_MS,
      headers: res.headers,
    });
    cancelResponseBodyBestEffort(res);
    await sleepWithAbort(delay, opts.abortSignal);
    attemptStart = Date.now();
    res = await fetchWithResetRetry(doFetch, opts);
  }
  return res;
}
```

### MODIFY `src/server/responses.ts` passthrough 분기 (~line 697)

before:

```ts
upstreamResponse = await fetchWithResetRetry(
  () => fetchWithHeaderTimeout(request.url, {...}, upstream.signal, connectMs, parsed.stream),
  { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
);
```

after:

```ts
upstreamResponse = await fetchWithTransientRetry(
  () => fetchWithHeaderTimeout(request.url, {...}, upstream.signal, connectMs, parsed.stream),
  { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
);
```

import 라인에 `fetchWithTransientRetry` 추가. 요청 바디는 passthrough에서 string
(`adapter.buildRequest` 산출) → replay-safe. `fetchWithHeaderTimeout` thunk 재실행은
기존 reset-retry와 동일 패턴이라 추가 위험 없음.

**감사 blocker #1 반영 — pool 실패 계정 기록은 최종 응답만.** attempt별
`recordCodexUpstreamOutcome` 기록은 하지 않는다: transient 실패는 routing.ts의
`consecutiveFailures`를 올리고(threshold 기본 3, routing.ts:315), 한 요청의 재시도
버스트 3회가 곧바로 계정 로테이션을 오발시킨다 — 게다가 retry thunk는 기존 계정
헤더를 유지하므로 로테이션이 in-flight 요청에 도움도 안 된다. 최종 응답은 기존
else-분기(responses.ts:755)가 그대로 기록 → 현행 failover 민감도 보존.

## OUT

- routed(비-passthrough) 어댑터 경로 — 각 어댑터 자체 재시도 정책 보유, 이번 범위 아님.
- SSE 시작 후(200 수신 후) 실패 — relay.ts fail-closed 유지.
- attempt별 pool failover 기록 — blocker #1 사유로 명시적 비목표.

## 리스크 (감사 반영)

- slow-5xx 재시도 예산: attempt 소요 > 15s면 재시도 포기(위 상수). 이 예산은 "느린
  실패 뒤 재시도"를 막을 뿐 attempt 자체의 상한(connectMs 200s)은 그대로다 — 최악
  ≈ 15s + backoff + 15s + backoff + connectMs이며, connectMs×3 중첩 시나리오를 차단
  하는 것이 목적(재감사 Low #1 반영).
- `opts.attempts`는 reset 계층과 공유된다(오늘 기준 전달하는 호출자 없음): 전달 시
  transient×reset 곱으로 최대 9 fetch까지 갈 수 있음을 인지(재감사 Low #3).
- deterministic 500 재시도 비용: 지연 + 중복 2콜로 bounded, 최종 바디(요청 ID 포함)는
  원형 보존(감사에서 마스킹 없음 확인).

## Accept criteria + activation

- NEW `tests/upstream-transient-retry.test.ts`:
  1. 502→200: doFetch 2회 호출, 최종 200, 실패 바디 cancel 호출 확인 (cr1)
  2. 502×3: 3회 호출 후 최종 502 반환 (재시도 소진)
  3. 400: 1회 호출, 그대로 반환 (비-transient 비재시도)
  4. Retry-After: 헤더 존중 (fake timer 또는 짧은 실측 delay)
  5. abort 시 즉시 중단
  6. slow attempt(>15s) → 재시도 없이 반환. 테스트 주입은 옵션 필드
     `slowAttemptMs?: number`를 `ResetRetryOptions` 확장으로 추가하는 방식으로 확정
     (재감사 Low #2 — Date.now 스텁 대신 명시적 seam).
- 기존 `tests/claude-native-passthrough.test.ts` 등 전체 green.
