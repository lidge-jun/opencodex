# 030 — 다음 라운드에 태울 수 있는 것

`010`과 `020`에서 나온 것 중 **우리가 실제로 고쳐서 머지할 수 있는 것**만 추린다.
선정 기준 둘:

1. `010` 또는 `020`의 행에 근거가 있다.
2. 메인테이너 승인이나 제3자 증거를 **기다리지 않아도** 착수할 수 있다.

두 번째가 이 문서를 짧게 만든다. 열린 PR 27건 중 다수는 코드가 아니라 승인·증거가
막고 있고, 그건 우리가 코드를 써서 푸는 문제가 아니다.

순서는 **공유 표면 우선**이다. 규모나 난이도 순이 아니다. 아래 F1이 F2·F3보다
먼저인 이유는 크기가 아니라 뒤의 것들이 앞의 것에 의존하기 때문이다.

---

## F1 — bridge의 tool call 종료 불변식

**가장 먼저.** 다른 스트림 작업 셋이 여기에 걸린다.

### 무엇이 잘못됐나

`bridge.ts:378-417`의 `closeCurrentToolCall()`은 `status: "completed"`를
**하드코딩**한다:

```
const item = ... {
  type: "function_call", id: currentToolCall.itemId,
  call_id: currentToolCall.callId, name: currentToolCall.name,
  arguments: argsStr, status: "completed",
```

그리고 이 함수는 **실패 경로 두 곳에서 무조건 호출된다**:

- `bridge.ts:776` — 어댑터 `error` 이벤트 처리
- `bridge.ts:835` — 어댑터 제너레이터가 그냥 끝난 경우(`response.incomplete`)

즉 스트림이 실패로 끝나도 클라이언트는 그 직전에
`response.function_call_arguments.done`과 `status:"completed"`인 `function_call`을
받는다. `response.failed`는 **그 뒤에** 나간다. 클라이언트 입장에서는 이미 발행된
tool call이다.

### 왜 이게 루트인가

| 걸린 것 | 관계 |
|---|---|
| #658 AgentRouter EOF | 어댑터에서 완화하려다 `95d8ed77f`로 리버트됨. 리버트 이유가 정확히 "bridge 771이 실패 전에 열린 call을 완료시킨다" |
| #765 잔여 | 같은 지점 |
| #735 | `openai-chat.ts:845-857`에서 어댑터 층만 방어됨. bridge 층은 무방비 |
| PR #781 | **이미 이걸 고친다** — `failCurrentToolCall()`이 `status:"incomplete"`로 취소 |

### 할 일

PR #781의 bridge 부분을 리베이스해서 살린다. 새로 쓸 게 아니라 이미 있는 걸 되살리는
작업이다. `010`에 적었듯 그 PR은 비어 있지 않다.

추가로 `bridge.ts:835`의 암묵적 EOF 경로도 같은 처리를 받아야 한다. #781은 `error`
경로만 다룬다.

### 증명

ablation: `failCurrentToolCall()`을 `closeCurrentToolCall()`로 되돌렸을 때
실패해야 한다. 직전 라운드가 #758·#790에서 두 번 겪은 무력한 테스트를 피하려면
이 확인이 필수다.

주의: `bridge.ts:438-441` 주석이 `response.completed`를 합성한다고 적혀 있는데
실제 코드는 `response.incomplete`를 낸다. 주석이 코드보다 낡았다. 같이 고친다.

---

## F2 — #658 provider 스코프 호환 모드

**F1 다음.** F1이 없으면 이 작업은 무효다 — 취소 경로가 없는 상태에서 EOF 완화를
얹으면 절단된 tool call이 완료로 나간다.

### 무엇이 잘못됐나

`anthropic.ts:866-881`이 `stop_reason` 없는 EOF를 무조건 에러로 만든다.
AgentRouter는 정확히 그렇게 끝낸다.

### 할 일

어댑터를 건드리지 않는다. 그 시도는 이미 리버트됐고 그게 맞다 — 어댑터는 프로토콜
계약을 지켜야 한다.

`responses/core.ts:2463-2477` 호출부에서 provider 스코프 호환 프로파일을
`bridgeToResponsesSSE()`(`bridge.ts:105-145`)로 넘긴다. 현재 시그니처에 정책
파라미터가 없으므로 추가해야 한다.

동작: 프로파일이 켜졌을 때만, 버퍼된 tool 인자가 유효한 JSON 객체로 검증되면 완료,
아니면 취소. 텍스트는 이미 나간 것을 보존.

**기본값은 fail-closed 유지.** 전역 완화는 진짜 절단을 놓친다.

### 증명

프로파일 OFF에서 기존 절단 테스트가 그대로 통과해야 한다. ON에서만 AgentRouter
형태가 완료된다.

---

## F3 — #745 tool schema 루트 type

F1·F2와 독립이다. 병렬 가능.

### 무엇이 잘못됐나

`responses/parser.ts:137-149`가 `parameters`를 `{}`로 만들 뿐 루트 `type`을 안 넣는다.
`schema.ts:99-105`도 요구하지 않는다. DeepSeek 등이 이걸 거부한다.

### 할 일

PR #745의 정규화 방향은 맞다. **없는 건 테스트뿐이고 그건 우리가 쓴다.**

`010`이 확인했듯 두 경로를 다 덮어야 한다:

- `responses/parser.ts` — 파싱 경로
- `adapters/openai-responses.ts:920-951` — `_rawBody` passthrough 경로

파서만 테스트하면 passthrough 라우트가 비어 있다.

### 증명

`parameters` 없는 tool과 `properties`는 있는데 루트 `type`이 없는 tool 둘 다
파싱해서 `parameters.type === "object"`를 확인하고, 기존 속성이 보존되는지 본다.
어댑터 층에서는 직렬화된 body를 확인한다.

---

## F4 — #782 디렉터리 하드닝 상태 유실

이건 PR 자체의 버그다. 정책 논쟁이 아니라 명백한 결함이라 우리가 고쳐도 된다.

### 무엇이 잘못됐나

`management-auth.ts`에서 디렉터리 하드닝이 soft continue할 수 있는데 그 결과가
버려진다. `aclUnverified`를 세우는 건 파일 하드닝뿐이다. 결과적으로 디렉터리 경계가
미검증인데 `/api/settings`가 verified로 보고할 수 있다.

상태 보고가 실제와 어긋나는 것이므로, 보안 판단 이전에 정확성 문제다.

### 할 일

`assertSafeDirectory`가 상태를 반환하게 하고 파일 쪽 상태와 OR로 합친다.
현재 테스트는 파일 타임아웃만 덮으므로 디렉터리 타임아웃 회귀 테스트를 추가한다.

ACL 정책 자체(opt-in을 열 것인가)는 **여전히 메인테이너 보안 리뷰 사항**이다.
우리가 하는 건 보고가 사실과 맞게 만드는 것까지다.

---

## F5 — #719 Kiro 카탈로그 총량 예산

PR 없음. 오너 판단 불필요. 순수 구현.

### 무엇이 잘못됐나

`adapters/kiro-tools.ts:144-171`이 **개별 설명만** 절단한다. 도구 개수나 직렬화
바이트에 예산이 없다. `kiro.ts:419-425`가 전체 목록을 유지하고 `:562-563`이 그대로
업스트림으로 보낸다. 대형 MCP 카탈로그가 생성 전에 `CONTENT_FILTERED`를 맞는다.

### 할 일

`kiro-tools.ts`에 카탈로그 예산을 넣는다. 설계 질문 하나: 초과 시 **무엇을 버릴
것인가**. 임의 절단은 도구를 조용히 사라지게 한다. 보존 우선순위 정책이 필요하다.

### 증명

`tests/kiro-adapter.test.ts`에 대형 카탈로그가 예산 안으로 들어오는지, 그리고
무엇이 남는지를 확인하는 테스트.

---

## F6 — #716 Kiro Windows 설치 안내

가장 단순하다. 마지막인 이유는 쉬워서가 아니라 아무것도 여기에 의존하지 않아서다.

`oauth/kiro.ts:360,378`이 `curl | bash`를 안내한다. 로케일 5개
(`providers.md` en:88,156 / ko:83,106 / ja:83,106 / zh:77,98 / ru:91,116)도 같다.
Windows 사용자는 로그인 시점에 실행 불가능한 명령을 받는다.

**선행 조건**: 공식 Windows 설치 명령을 확인해야 한다. 모르면 추측해서 쓰지 않는다.
플랫폼 인지 헬퍼를 넣고 5개 로케일을 동기화한다.

---

## 테스트 품질 — 별도 항목

`020`에서 확인한 것 외에, 게이트 레인이 dev에 이미 들어간 약한 테스트 셋을 찾았다.
각각 프로덕션 동작을 되돌려도 통과한다.

| 테스트 | 무엇을 놓치나 |
|---|---|
| `tests/logs-timezone.test.ts:44,57` | GUI 포매터를 로컬에서 재구현한다. `Logs.tsx:662`의 실제 포매터나 `serverTimeZone` 배선을 되돌려도 초록. GUI를 import하지도 렌더하지도 않는다 |
| `tests/service-stop-verification.test.ts:40` | 전부 `proxyStillLiveAfterStop`을 직접 호출한다. `serviceCommand`를 타지 않으므로 `service.ts:1997`의 통합 호출을 제거해도 초록 — 그러면 `ocx service stop`이 살아 있는 프록시 위에 native Codex를 복원할 수 있다 |
| `tests/windows-tray-run-limit.test.ts:18` | 명령 빌더만 본다. `windows.ts:546` 설치 경로가 VBS launcher를 안 쓰거나 값을 영속화하지 않아도 초록 |

세 번째는 #780이 머지되면서 들어온 것과 같은 계열이다 — 소스 텍스트를 검사하는 테스트.

이건 이슈가 없다. **`030` 항목으로 올리되 별도 이슈를 여는 게 맞다.** 직전 라운드가
같은 실패 모드를 두 번(#790, #758) 겪었고, 이번에 셋을 더 찾았다면 이건 개별 사고가
아니라 패턴이다.

---

## 이슈로 열어야 하는 것

트리아지 중에 나왔는데 추적 항목이 없는 것들.

1. **Windows CI Bun 런타임 패닉.** `panic(thread N): Internal assertion failure` /
   `oh no: Bun has crashed`. #744와 #693 CI에서 관측. 런처 커밋 두 개(`371aa579d`,
   `0af17fbfd`)로 안 풀린다. 별개 문제다.
2. **소스 텍스트를 grep하는 테스트 패턴.** 위 세 건 + #780이 들여온 것.
3. **#570의 별칭 호스트 질문.** 원 이슈는 닫되(`020` 참조) `myhost.lan` 같은
   비-loopback 별칭 신뢰 목록은 별건으로 남긴다. 보안 리뷰 대상이다.
4. **#572 umbrella의 미착수 8종.** Chutes, SambaNova, Nebius, DigitalOcean,
   Scaleway, Nscale, Vultr, Featherless는 PR조차 없다. umbrella를 열어둔 채
   개별 PR을 증거 미달로 반려하는 상태가 계속되면 양쪽 다 안 움직인다.

---

## 우리가 안 하는 것

명시해두는 게 낫다. 목록에서 빠진 이유가 "잊어서"가 아니라는 걸 남긴다.

- **보안 리뷰 대기 6건** (#779 #750 #744 #693 #671 #616) — 코드가 아니라 승인이
  막고 있다. 우리가 코드를 써도 안 풀린다.
- **preset 증거 미달 5건** (#747 #653 #611 #776, #751은 증거 완비) — 제3자 문서가
  필요하다. 우리가 만들 수 없고 만들어서도 안 된다.
- **#553 Copilot TLS** — 잘못된 인증서는 환경 문제다. 검증 비활성화나 hostname
  재작성은 안전하지 않다. `020`에 근거를 적었다.
- **#793 / #735 나머지 절반** — #773이 왜 리버트됐는지 기록이 없다. 가설은
  `020`/`040`에 있지만 가설로 되돌리지 않는다. **오너 판단이 먼저다.**
- **upstream-tracking 4건** — 우리 코드 문제가 아니다.
