# 030 — wp3: TTFB 타임아웃이 살아 있는 업스트림을 죽인다

사용자가 실제로 맞은 오류다.

```text
stream disconnected before completion: cloud-direct: time-to-first-byte timeout (60000ms)
```

## 근본 원인

`src/adapters/devin/cloud-direct/chat.ts:50`:

```ts
/** Time-to-first-byte timeout. */
const CLOUD_STREAM_TTFB_MS = 60_000;
```

`chat.ts:1118-1131`의 주석은 이렇게 주장한다.

> Once any byte arrives we cancel the TTFB timer and start the per-chunk idle timer

그런데 실제 코드는 그렇지 않다. 타이머는 `chat.ts:1152-1153`의 `finally`에서 지워지고,
그 `finally`는 `await fetch(...)`가 **응답 헤더**로 resolve될 때 실행된다. 즉 이 60초는
"첫 바이트"가 아니라 "헤더 도착"까지의 예산이다. 본문 첫 토큰은 보지 않는다.

본문 무응답은 이미 별도 예산이 있다 — `CLOUD_STREAM_IDLE_MS = 120_000` (`chat.ts:48`,
`chat.ts:1246`). 그래서 현재 구조는 **헤더 60초 < 본문 idle 120초**로, 오래 생각하는
모델일수록 관대해야 할 구간이 더 빡빡하다.

Cognition은 SWE-2에서 첫 토큰이 나올 때까지 헤더를 붙들어 둔다. 그래서 effort가 높을수록
헤더가 늦고, 우리가 스스로 끊는다.

## 라이브 증거

사용자 로그에서 3건, 전부 같은 모양이다.

| # | provider | model | effort | status | durationMs | firstOutputMs | attempts |
|---|---|---|---|---|---|---|---|
| 1 | `devin-cli` | `swe-2` | high | 504 | 60000 | 없음 | 1 |
| 2 | `devin-cli` | `swe-2` | high | 504 | 60024 | 없음 | 1 |
| 3 | `devin-cli` | `swe-2` | high | 504 | 55968 | 없음 | 1 |

`service.log:66219`에 REJECTED `GetChatMessage` `ageMs=137197`이 있고, 같은 시각 형제
호출은 76초까지 살아남았다. 업스트림은 죽지 않았다. 우리가 먼저 끊었다.

## 두 번째 결함: 오류 분류가 비어 있다

abort 사유는 raw `Error`다 (`chat.ts:1123`). `CloudChatError`가 아니므로
`devinErrorClassification`(`src/adapters/devin.ts:53-55`)이 `status === undefined`로
`{}`를 반환하고, 분류가 `src/lib/errors.ts:429-435`의 문자열 추론으로 떨어져
`504 upstream_server_error`가 된다. 우리 쪽 데드라인인데 업스트림 장애로 보고된다.

## 세 번째 결함: `timeout: 0`이 없다

`chat.ts:1135`의 raw `fetch`에는 Bun 자체 fetch 타임아웃을 끄는 `timeout: 0`이 없다.
하우스 스타일은 `src/server/responses/fetch-helpers.ts:87`이다.

```ts
const dispatchInit = { ...withUpstreamHttpVersion(input, init, provider), timeout: 0 };
```

## MODIFY: src/adapters/devin/cloud-direct/chat.ts

### 1) 헤더 예산을 생성 데드라인과 분리하고 설정 가능하게

```ts
// before
/** Time-to-first-byte timeout. */
const CLOUD_STREAM_TTFB_MS = 60_000;

// after
/**
 * Time-to-response-headers budget. Cognition holds the response headers until
 * the model produces its first token, so on a high-effort reasoning model this
 * is a generation deadline, not a connect timeout. It must therefore be at
 * least as generous as the idle budget below; a 60s value guillotined live
 * swe-2 high turns at 60000ms with no output (three logged 504s, 2026-09-13).
 * Override with OPENCODEX_DEVIN_TTFB_MS.
 */
const CLOUD_STREAM_TTFB_DEFAULT_MS = 300_000;
function cloudStreamTtfbMs(): number {
  const raw = process.env.OPENCODEX_DEVIN_TTFB_MS?.trim();
  if (!raw) return CLOUD_STREAM_TTFB_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CLOUD_STREAM_TTFB_DEFAULT_MS;
}
```

`OPENCODEX_ACL_TIMEOUT_MS`(`src/lib/windows-secret-acl.ts:271`)와 같은 하우스 패턴이다.

### 2) abort를 분류 가능한 오류로 감싼다

```ts
// before
const ttfbTimer = setTimeout(() => ttfbController.abort(new Error(`cloud-direct: time-to-first-byte timeout (${CLOUD_STREAM_TTFB_MS}ms)`)), CLOUD_STREAM_TTFB_MS);

// after
const ttfbMs = cloudStreamTtfbMs();
const ttfbTimer = setTimeout(
  () => ttfbController.abort(new CloudChatError(`cloud-direct: no response headers within ${ttfbMs}ms`, undefined, undefined, 504)),
  ttfbMs,
);
```

메시지에서 "time-to-first-byte"라는 말을 뺀다. 헤더를 기다린 것이지 바이트가 아니다.

### 3) `timeout: 0` 추가

```ts
    resp = await fetch(url, {
      method: "POST",
      headers: { /* unchanged */ },
      body,
      redirect: "error",
      signal: initialSignal,
      timeout: 0,
    } as RequestInit);
```

### 4) 주석의 거짓말을 고친다

`chat.ts:1118-1121`의 "Once any byte arrives"는 사실이 아니다. "Once the response
headers arrive"로 정정한다. 이 주석이 이 버그를 가려 왔다.

## NEW: tests/adapters/devin/cloud-direct-stream-deadline.test.ts

fake `fetch` + fake timer로 시간을 실제로 흘려보내지 않는다.

| 케이스 | 시나리오 | 기대 |
|---|---|---|
| A | 헤더가 기본 예산을 넘겨 안 옴 | `CloudChatError`, `status === 504`, 메시지에 `no response headers` |
| B | 헤더 90초 뒤 도착, 본문 정상 | **성공** (구 코드에서는 60초에 죽음) — 사용자 버그의 회귀 |
| C | 헤더 즉시, 본문 idle 초과 | 기존 idle 오류 유지 |
| D | `OPENCODEX_DEVIN_TTFB_MS=1000` | 1초에 abort (설정 반영) |
| E | fetch init에 `timeout: 0` 포함 | 캡처한 init 단언 |
| F | abort 오류가 `devinErrorClassification`에서 `status:504`, `retryable:true` | 분류 회귀 |

케이스 B가 이 단계의 존재 이유다.

## 하지 않는 것

프록시 레벨 자동 재시도는 넣지 않는다. Codex가 이미 같은 conversation으로 재시도했고,
생성 데드라인을 늘리는 것과 재시도는 다른 문제다. 재시도를 넣으면 토큰을 두 번 태운다.


## 감사 반영 (A 단계, BLOCKER-2)

`ttfbController.abort(new CloudChatError(...))`로 abort 사유를 감싸는 설계는 취소한다.
`fetch`가 `signal.reason`을 그대로 던진다는 보장이 없다. 런타임에 따라 `AbortError`로
감싸서 던지면 우리 `CloudChatError`는 사라지고 030 케이스 F가 실패한다.

대신 abort 사유는 평범하게 두고, `fetch`를 감싼 `catch`에서 **우리 타이머가 발화했는지**를
보고 명시적으로 던진다. 그래야 런타임 동작에 의존하지 않는다.

```ts
let ttfbFired = false;
const ttfbMs = cloudStreamTtfbMs();
const ttfbTimer = setTimeout(() => {
  ttfbFired = true;
  ttfbController.abort();
}, ttfbMs);

let resp: Response;
try {
  resp = await fetch(url, { /* ... */ signal: initialSignal, timeout: 0 } as RequestInit);
} catch (err) {
  if (ttfbFired) {
    // Our deadline, not the upstream failing. Classify it as ours so
    // devinErrorClassification sees a status instead of returning {}.
    throw new CloudChatError(`cloud-direct: no response headers within ${ttfbMs}ms`, undefined, undefined, 504);
  }
  throw err;
} finally {
  clearTimeout(ttfbTimer);
  composed?.cleanup();
}
```

케이스 F는 이 `catch` 경로를 직접 겨냥한다. 케이스 G를 추가한다: 호출자가 자기
`req.signal`로 취소했을 때는 `ttfbFired`가 false라 원래 abort가 그대로 전파된다.

감사에서 함께 확인된 것: 기본값 300000ms는 `timeout: 0`과 같이 가면 안전하고,
본문 침묵은 그대로 120초 idle이 잡는다. 라이브 `ageMs=137197` 사례가 있으므로
120000은 헤더 예산으로 부족하다.


## 사용자 지적 반영 — AssignModel 가설 검증 (2026-09-13, wp1 P 시점)

사용자가 계획의 약한 곳을 짚었다: 네이티브 CLI와 Plus는 `AssignModel` RPC를 먼저
부르는데 우리만 안 부른다. 라우팅 비용을 짧은 별도 호출로 치르지 않고 생성 요청에
묻어버려서 헤더가 늦는 것 아니냐는 가설이다.

절반은 사실이고, TTFB 원인으로는 **기각된다**.

### 사실인 부분

우리 트리에 `AssignModel`이 없다. `rg -in "assignmodel|assignment_jwt" src/ tests/` 결과가
0건이다. Plus는 `devin_request.go:376`에
`devinAssignModelPath = "/exa.api_server_pb.ApiServerService/AssignModel"`를 두고
`devin_executor.go:641,765`에서 부른 뒤 결과 `ModelUID`와 `AssignmentJWT`(필드 26)를
`GetChatMessage`에 싣는다.

### 기각되는 부분

Plus의 호출은 무조건이 아니라 가드 뒤에 있다 (`devin_executor.go:883-885`):

```go
// devinIsRouterModel reports whether a model id routes through AssignModel.
// Thinking-effort suffixes are resolved server side.
func devinIsRouterModel(model string) bool {
	return strings.HasSuffix(model, "-router") || strings.Contains(model, "model-router")
}
```

`swe-2-high`는 `-router`로 끝나지도, `model-router`를 포함하지도 않는다. 그러니 Plus도
이 모델에서는 `AssignModel`을 부르지 않고 곧장 `GetChatMessage`로 간다 — 우리와 같다.
주석이 직접 못을 박는다: **thinking-effort 접미사는 서버가 푼다.**

따라서 `AssignModel` 누락은 사용자가 실제로 맞은 `swe-2-high` 504의 원인이 아니다.
wp3의 헤더 예산 수정은 그대로 간다.

### 그래도 남는 진짜 결손 → wp6

기각됐다고 가치가 없는 건 아니다. `AssignModel`이 없으면 **라우터 uid를 아예 못 쓴다.**
레인 A가 카탈로그에서 `adaptive`를 확인했고, 우리 `src/`에는 `adaptive`도 `router`도
0건이다(`live-models.ts`, `devin.ts` 검색). 사용자가 라우터 모델을 고르면 우리는 그것을
구체 uid로 바꾸지 못한 채 원시 문자열로 보낸다.

이것은 TTFB와 무관한 별개 기능 결손이므로 **wp6**으로 세운다. 측정이 필요한 가설
(핸드셰이크가 헤더 지연을 줄이는가)이 아니라, 확인된 기능 공백이다.

### 함께 확정된 것 두 가지

**헤더 이후는 이미 안전하다.** 추론 프레임이 생존 신호로 동작한다. 파서가 추론을
`kind: reasoning`으로 분리하고(`chat.ts:427,753`), `resetIdle()`이 `reader.read()`가
무엇이든 돌려주면 재무장한다. 헤더만 도착하면 그 뒤 90초를 생각해도 죽지 않는다.
죽는 구간은 오직 헤더 이전이다. wp3가 그 한 구간만 건드리는 것이 맞다.

**Plus의 타임아웃은 따라가면 안 된다.** `devin_executor.go:69,85`:

```go
devinDefaultTimeout = 120 * time.Second
client: &http.Client{Timeout: devinDefaultTimeout},
```

Go의 `http.Client.Timeout`은 헤더가 아니라 본문 읽기까지 포함한 **전체 요청** 예산이다.
3분짜리 정상 스트리밍 턴도 120초에 잘린다. 긴 턴에 대해서는 우리 구조(헤더 예산과
본문 idle 분리)가 오히려 낫다. 고칠 곳은 헤더 구간 하나다.

헤더 데드라인을 길게 잡는 것이 위험하지 않은 이유도 여기 있다. 업스트림이 죽으면
TCP/HTTP2 레벨 오류가 즉시 올라와 `fetch`가 reject된다. 300초를 조용히 기다리는
경우는 연결이 블랙홀이 된 때뿐이고, 그건 keepalive의 영역이다.

