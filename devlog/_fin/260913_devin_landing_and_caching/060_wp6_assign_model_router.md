# 060 — wp6: 라우터 모델을 못 쓴다 (AssignModel 부재)

사용자 지적에서 나온 단계다. 원래 가설은 "AssignModel을 안 불러서 헤더가 늦다"였고
그건 기각됐지만(030 참조), 검증 과정에서 별개의 확정된 기능 결손이 드러났다.

## 결손

우리 트리에 `AssignModel`이 없다.

```text
$ rg -in "assignmodel|assignment_jwt|assignmentJwt" src/ tests/
(0건)
$ rg -in "adaptive|router" src/adapters/devin/live-models.ts src/adapters/devin.ts
(0건)
```

레인 A가 네이티브 카탈로그에서 `adaptive`를 확인했다. 라우터 uid는 그 자체로 모델이
아니라 "서버가 골라 달라"는 요청이며, `AssignModel`로 구체 uid를 받아 와야 한다.
우리는 그 문자열을 그대로 `GetChatMessage`의 필드 21에 실어 보내고, Cognition은
모르는 모델로 취급한다.

## 언제 부르는가

무조건이 아니다. Plus의 가드를 그대로 따른다 (`devin_executor.go:883-885`).

```go
func devinIsRouterModel(model string) bool {
	return strings.HasSuffix(model, "-router") || strings.Contains(model, "model-router")
}
```

주석이 명시한다: thinking-effort 접미사는 서버가 푼다. 그러니 `swe-2-high` 같은 평범한
모델에 이 호출을 붙이면 **왕복만 하나 늘어난다.** 라우터 uid에서만 부른다.

우리 판정에는 `adaptive`도 넣는다. 레인 A가 카탈로그에서 실제로 본 값이고, Plus의
접미사 규칙만으로는 걸리지 않는다.

## NEW: src/adapters/devin/cloud-direct/assign-model.ts

와이어 포맷은 Plus의 인코더/파서와 1:1로 맞춘다.

요청 `AssignModelRequest` — 경로 `/exa.api_server_pb.ApiServerService/AssignModel`:

| 필드 | 내용 | 출처 |
|---|---|---|
| 1 | metadata (GetChatMessage와 동일 빌더) | `devinAssignMetadataField` |
| 2 | router uid (string) | `devinAssignRouterField` |
| 3 | cascade_id (string, 있을 때만) | `devinAssignCascadeField` |
| 5 | 마지막 turn의 prompt 하나만 | `devinAssignPromptField` |

전체 히스토리가 아니라 **마지막 메시지 하나**만 보낸다는 점이 중요하다. 라우팅 결정에
필요한 최소치이고, 이래야 이 호출이 짧게 끝난다.

응답 `AssignModelResponse`:

| 필드 | 내용 |
|---|---|
| 1 | assignment (sub-message) |
| 1.1 | assignment JWT (string) |
| 1.2 | 구체 model uid (string) |

## MODIFY: src/adapters/devin/cloud-direct/chat.ts

라우터 uid일 때만 선행 호출하고, 결과를 두 곳에 반영한다.

```ts
if (isRouterModelUid(req.modelUid)) {
  const assignment = await assignModel(req, sessionIds.cascadeId);
  if (assignment?.modelUid) req = { ...req, modelUid: assignment.modelUid };
  if (assignment?.jwt) assignmentJwt = assignment.jwt;
}
```

인코더에 필드 26(`assignment_jwt`)을 추가한다. 있을 때만 쓴다.

```ts
...(assignmentJwt ? [encodeString(26, assignmentJwt)] : []),
```

실패는 치명적이지 않다. Plus도 실패하면 요청받은 모델로 그냥 진행한다
(`devin_executor.go:871` debug 로그 후 fallthrough). 같은 방식으로 degrade한다 —
라우팅을 못 받았다고 턴을 죽이지 않는다.

## NEW: tests/adapters/devin/cloud-direct-assign-model.test.ts

| 케이스 | 기대 |
|---|---|
| `swe-2-high` | `AssignModel` 호출 없음 (왕복 추가 금지 회귀) |
| `*-router` / `model-router` / `adaptive` | 호출 있음 |
| 응답의 uid가 필드 21에 반영 | 바이트 단언 |
| 응답의 JWT가 필드 26에 반영 | 바이트 단언 |
| JWT 없으면 필드 26 부재 | 바이트 단언 |
| `AssignModel`이 실패해도 원래 uid로 진행 | degrade 회귀 |
| 요청 필드 5에 마지막 turn 하나만 | 히스토리 유출 회귀 |

## 순서

wp4 다음. 둘 다 `chat.ts` 인코더를 건드리고, wp4의 필드 13이 먼저 들어가는 편이
필드 순서를 한 번만 정리한다.


## 결론 — 구현하지 않는다 (A 단계 감사 FAIL, 2026-09-13)

이 단계는 **NOOP으로 닫는다.** 독립 감사가 `VERDICT: fail`로 블로커 2건을 냈고,
둘 다 반박되지 않는다.

**BLOCKER-1 — 라우터 uid가 우리에게 도달한다는 증거가 없다.**
Plus의 가드 패턴(`-router` 접미사, `model-router` 포함)은 우리 카탈로그에도,
`DEVIN_STATIC_MODELS`에도, 레인 A의 바이너리 조사에도 없다. 레인 A가 본 `adaptive`는
`GetCliModelConfigs` 응답이고, 우리는 `GetCascadeModelConfigs`만 파싱한다. 다른 RPC의
모델 목록을 근거로 우리 요청 경로에 RPC를 하나 더 붙일 수는 없다.

**BLOCKER-2 — 훅을 걸 자리가 이미 선점되어 있다.**
사용자가 `adaptive`를 직접 타이핑해도 `resolveWireModelUid`가 먼저 `adaptive-medium`으로
바꾸고, 그다음 카탈로그 preflight가 `not_listed`로 턴을 끝낸다. AssignModel 호출은
그 두 단계 뒤에 올 자리라 영원히 실행되지 않는다. 훅을 앞으로 당기려면 wp5에서 막
정리한 접미사 해석과 #14의 preflight 계약을 둘 다 되돌려야 하는데, 확인되지 않은
수요를 위해 확인된 보호장치를 걷어내는 거래다.

### 그래도 남겨 두는 것

봉투 자체는 검증됐으므로 기록은 유지한다. 나중에 라우터 uid가 실제로 관측되면
이 문서의 필드 표를 그대로 쓰면 된다. 감사가 함께 확인한 사항:

- 요청 1/2/3/5, 응답 1→{1 jwt, 2 uid} 구조는 Go 구현과 일치한다.
- 다만 우리 `buildMetadata`는 Go `devinBuildMetadata`와 필드·클라이언트 문자열이
  달라서, 그대로 재사용하면 다른 봉투가 나간다. 재사용 전 대조가 필요하다.
- AssignModel이 느리면 wp3의 헤더 데드라인에는 안 걸리지만 사용자 체감 TTFB는
  늘어난다. 구현한다면 이 호출에 **별도의 짧은 타임아웃**이 필요하다.
- 필드 26은 21 뒤, JWT가 있을 때만. assignment JWT는 api_key와 동급으로 로그·오류
  본문에서 가려야 한다.

### 착지 조건

다음 중 하나가 관측되면 이 단계를 다시 연다.

1. `GetCascadeModelConfigs` 응답에 `-router` 또는 `model-router` uid가 실제로 나온다.
2. 사용자가 라우터 uid로 턴을 시도해 `not_listed`로 죽은 사례가 로그에 남는다.

그 전까지 요청 경로에 RPC를 추가하는 것은 순비용이다.

