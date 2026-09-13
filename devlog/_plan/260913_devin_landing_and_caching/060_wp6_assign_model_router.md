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

