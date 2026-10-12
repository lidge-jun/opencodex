---
title: 라우팅 프로필 편집기
description: opencodex 대시보드에서 라우팅 정책 프로필을 만들고, 편집하고, 검증하고, 시험 평가하고, 삭제합니다.
---

opencodex 대시보드의 **Models → Routing** 탭에서 `config.json`을 직접 편집하지 않고 `config.routingProfiles`를 관리할 수 있습니다.

## 프로필 만들기

1. 대시보드에서 **Routing**을 엽니다.
2. **Create profile**을 선택합니다.
3. `id`를 입력합니다. 정식 모델 ID는 `policy/<id>`입니다.
4. 명시적인 프로바이더/모델 후보를 하나 이상 추가합니다.
5. 필요하면 요구 조건, 점수 가중치, 비용 한도(`maxEstimatedCostUsd`, 선택 사항인 `onUnknownCost`), 근거가 없을 때의 동작을 설정합니다.
6. 프로필을 저장합니다.

프로필 ID는 생성 후 바꿀 수 없습니다. 다른 ID가 필요하면 새 프로필을 만들고 호출자를 수정한 뒤 이전 프로필을 삭제하세요.

## 검증과 저장

대시보드는 `config.routingProfiles`에서 사용하는 것과 같은 프로필 객체를 관리 API로 보냅니다. 서버는 저장 전에 후보 전체를 검증합니다.

- ID와 별칭은 라우팅 프로필의 명명 및 충돌 규칙을 따라야 합니다.
- 모든 후보 프로바이더가 존재하고 활성화되어 있어야 합니다.
- 중복 후보는 거부됩니다.
- 숫자 한도와 요구 조건은 지원 범위 안에 있어야 합니다.
- 최적화 가중치 중 하나 이상은 양수여야 합니다.

저장에 성공하면 일반 설정 기록기로 프로필을 저장하고, 실시간 상태를 조정하고, 모델 카탈로그를 새로 고칩니다. 검증에 실패하면 이전 설정은 그대로 유지되고 오류가 편집기에 표시됩니다.

`limits.maxEstimatedCostUsd`를 설정하면 `limits.onUnknownCost`의 기본값은 `"allow"`입니다. 비용 추정치를 알 수 없어도 한도 자체를 이유로 제외하지 않으며, 시험 평가와 실제 라우트 결정 기록에 `cost.capOutcome: "unknown-allowed"`를 남겨 한도가 입증되지 않았음을 알립니다. 상한을 엄격히 지켜야 한다면 `"exclude"`를 설정하세요(`cost-limit-unknown`, `cost.capOutcome: "unknown-excluded"`). `onUnknownCost`만 설정하면 효력이 없으며 한도 결과도 기록되지 않습니다. 이 설정은 `unknownEvidence.cost`와 별개입니다. 후자는 가격 정보가 없을 때 독립적으로 제외하거나 감점할 수 있습니다.

## 저장된 프로필 시험 평가

후보 기능은 레지스트리 오버라이드를 적용한 유효 프로바이더 설정을 사용합니다. 따라서 지역 요구 조건(`localOnly`와 `remoteAllowed`)은 실제 업스트림 주소를 기준으로 판단합니다. 주소를 분류할 수 없다면 프로필의 `unknownEvidence.capability` 설정으로 자격을 결정합니다. 해석할 수 없는 잘못된 프로바이더 설정은 알 수 없는 기능을 허용하더라도 항상 `route-unavailable`로 제외됩니다. 누락되었거나 비활성화된 프로바이더도 점수 계산 전에 `route-unavailable`로 제외됩니다.

저장된 프로필을 선택하고 **Dry-run evaluation**에서 컨텍스트 창 크기, 도구 사용, 이미지 입력, 구조화 출력 등의 요청 정보를 추가하세요. 시험 평가는 자격과 점수만 계산하며 업스트림 모델에 요청하지 않습니다.

저장하지 않은 편집 내용은 시험 평가에 사용되지 않습니다. 표시되는 리비전과 평가가 같은 설정을 가리키도록 먼저 프로필을 저장하세요.

## 관리 API

편집기는 다음 엔드포인트를 사용합니다.

- `GET /api/routing-profiles`는 정규화된 프로필과 리비전을 나열합니다.
- `PUT /api/routing-profiles`는 프로필 하나를 만들거나 갱신합니다. `mode: "create"` 또는 `mode: "update"`를 보내세요. 생성 모드는 기존 ID를 덮어쓰지 않습니다.
- `DELETE /api/routing-profiles?id=<id>`는 프로필 하나를 삭제합니다.
- `POST /api/routing-profiles/dry-run`은 업스트림 요청 없이 저장된 프로필을 평가합니다.

저장 페이로드 예시:

```json
{
  "id": "fast",
  "mode": "create",
  "profile": {
    "alias": "ocx/fast",
    "candidates": [
      { "provider": "anthropic", "model": "claude-sonnet-5" },
      { "provider": "openai", "model": "gpt-5.6" }
    ],
    "require": { "tools": true, "minContextWindow": 128000 },
    "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.1, "quota": 0.1 },
    "limits": { "maxEstimatedCostUsd": 0.5, "onUnknownCost": "allow" },
    "unknownEvidence": {
      "capability": "exclude",
      "health": "penalize",
      "quota": "penalize",
      "cost": "penalize"
    }
  }
}
```
