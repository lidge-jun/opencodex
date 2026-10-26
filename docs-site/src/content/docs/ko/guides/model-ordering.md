---
title: 모델 정렬에 관하여
description: opencodex가 Codex 모델 선택기와 spawn_agent 모델 override의 순서를 정하는 방식.
---

Codex 모델 선택기는 opencodex 설정에 적힌 프로바이더 선언 순서나 모델 배열 순서를 보존하지
않습니다. 최종 순서는 카탈로그 priority로 정해지며, 같은 priority를 가진 라우팅 모델에는 결정적인
알파벳순 정렬이 적용됩니다.

## Codex가 적용하는 규칙

Codex의 models-manager는 선택기에 표시되는 카탈로그 항목을 `priority` 오름차순으로 정렬합니다.
카탈로그 배열 순서는 버리므로 생성된 JSON 배열에서 항목을 앞으로 옮겨도 선택기에서는 앞으로
이동하지 않습니다. 이 제약은 `src/codex/catalog/sync.ts`에 직접 기록되어 있습니다.

따라서 opencodex는 배열 위치가 아니라 더 낮은 priority를 부여해 featured 위치를 제어합니다.
이 표의 고정값과 아래 예시는 유효한 account selector가 없는 설정을 설명합니다. `N`개의 selector가
있으면 설정 rank `i`의 featured bare native는 priority `i * N + j`인 selector 행으로 확장되며,
`j`는 0부터 시작하는 selector 위치입니다. featured routed 행은 `i * N`, exact account-qualified
native id는 해당 selector의 `i * N + j`를 사용합니다. Codex는 계속 선택기에 표시되는 처음 다섯
행만 노출합니다. 선택되지 않은 routed 행은 이러한 selector 그룹 밖으로 이동합니다.

selector가 없을 때의 priority는 다음과 같습니다.

아래 우선순위 표와 예시는 선택기 전체 정렬을 켜지 않은 경우를 설명합니다.

| 카탈로그 항목 | Priority | 근거 |
| --- | ---: | --- |
| `subagentModels[i]` | `i` (`0`부터 `4`) | `src/codex/catalog/sync.ts`의 featured rank map |
| 그 밖의 라우팅 모델 | `5` | `src/codex/catalog/sync.ts`의 라우팅 항목 생성 |
| 기본 네이티브 GPT slug | `9` | `src/codex/catalog/sync.ts`의 네이티브 항목 생성 |
| featured 목록이 있을 때 선택되지 않은 네이티브 모델 | 최소 `featured.length + 100` | `src/codex/catalog/sync.ts`의 네이티브 카탈로그 병합 |

관리 API는 `src/server/management/agent-settings-routes.ts`의 `slice(0, 5)`로 `subagentModels`를 최대
5개로 제한합니다. 이는 처음 5개 모델 override만 광고하는 Codex `spawn_agent` 서피스와 맞습니다.
5개 밖의 모델도 메인 선택기에 계속 표시될 수 있고 정확한 id로 호출할 수 있습니다.

## 같은 priority 안에서의 순서

일반 라우팅 모델은 모두 priority `5`이므로 동률 정렬이 필요합니다. 카탈로그 항목을 만들기 전에
`gatherRoutedModels()`가 라우팅 모델 목록을 프로바이더 이름순, 그다음 모델 id순으로 알파벳 정렬합니다
(`src/codex/catalog/provider-fetch.ts`).

따라서 다음 설정의 순서는 최종 정렬에 영향을 주지 않습니다.

- `providers` 객체에서 key를 선언한 순서
- 각 프로바이더의 `models` 배열에 id를 적은 순서

그다음 `orderForSubagents()`가 stable sort를 사용해 featured 모델을 `subagentModels`에 적힌 순서대로
앞으로 옮깁니다. featured가 아닌 모델은 앞에서 정해진 프로바이더/id 알파벳 상대 순서를 유지합니다
(`src/codex/catalog/sync.ts`). 항목 생성 시 featured rank도 priority `0`부터 `4`로 변환되므로
Codex의 priority 정렬에서도 이 선두 순서가 보존됩니다.

## 노출 여부와 순서는 별개

`selectedModels`와 `disabledModels`는 어떤 라우팅 모델을 노출할지 정할 뿐, 정렬을 제어하지 않습니다.
`filterCatalogVisibleModels()`는 두 선택 목록을 `Set` 조회로 변환하고, 배열을 rank로 사용하지 않은 채
수집된 목록을 필터링합니다(`src/codex/catalog/provider-fetch.ts`).

따라서 `selectedModels`나 `disabledModels`의 배열 순서를 바꿔도 선택기 위치는 달라지지 않습니다.
바뀔 수 있는 것은 모델의 포함 여부뿐입니다.

## 최종 선택기 패턴

유효한 account selector가 없고 featured 목록이 비어 있지 않을 때 최종 순서는 다음과 같습니다.

1. 설정된 `subagentModels` 순서 그대로, priority `0`부터 `4`를 받은 모델
2. 나머지 모든 라우팅 모델, 프로바이더순과 모델 id순 알파벳 정렬, priority `5`
3. 카탈로그 병합 과정에서 featured 블록 아래로 밀린 선택되지 않은 네이티브 모델

`subagentModels`가 없으면 라우팅 모델은 priority `5`를 유지하고, 네이티브 GPT 항목은 정상 priority
(opencodex가 만든 항목은 보통 `9`)를 사용합니다. 라우팅 그룹 내부는 계속 프로바이더/id
알파벳순입니다.

## 예시

`subagentModels`에 다음 5개 id가 이 순서대로 들어 있다고 가정합니다.

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

선택기의 시작 순서는 다음과 같습니다.

| 선택기 위치 | 모델 | Priority | 이 위치에 표시되는 이유 |
| ---: | --- | ---: | --- |
| 1 | `gpt-5.5` | `0` | 첫 번째 `subagentModels` 선택 |
| 2 | `opencode-go/glm-5.2` | `1` | 프로바이더가 `anthropic`보다 뒤여도 두 번째 선택이므로 이 위치에 표시 |
| 3 | `anthropic/claude-opus-4-6` | `2` | 세 번째 선택 |
| 4 | `gpt-5.6-sol` | `3` | 네 번째 선택 |
| 5 | `gpt-5.6-terra` | `4` | 다섯 번째 선택 |
| 6 | `anthropic/claude-fable-5` | `5` | 남은 라우팅 모델 중 프로바이더/id 알파벳순 첫 항목 |
| 7 이후 | 나머지 라우팅 모델 | `5` | 프로바이더 알파벳순, 같은 프로바이더 안에서는 모델 id 알파벳순 |
| 라우팅 모델 이후 | 나머지 네이티브 모델 | `featured.length + 100` 이상 | 선택되지 않은 네이티브 모델은 featured 블록 아래로 이동 |

처음 5개 항목은 `spawn_agent`에 광고되는 override이며, 나머지는 일반 선택기 순서로 이어집니다.

account selector가 있으면 bare native 선택이 selector-qualified 그룹으로 확장된 뒤에 5개 제한이
적용됩니다.

## 순서를 바꾸는 방법

선두 모델 순서를 바꾸는 지원 수단은 `subagentModels`를 재정렬하는 것입니다. 대시보드의
**Sub-agents** 페이지에서는 bare native와 routed id의 순서를 바꿀 수 있습니다. 설정과
`ocx agent subagents set`은 exact account-qualified `<selector>/<native-openai-model>` id도
지원합니다. 대시보드는 이미 저장된 id를 현재 사용할 수 없어도 보존합니다. 설정 id는
최대 5개만 사용하세요. account selector가 있으면 bare native 하나가 여러 selector-qualified 행으로
확장될 수 있으므로 설정 항목과 노출 행이 항상 일대일로 대응하지는 않습니다.

`modelPickerOrder`는 선택기의 표시 순서만 지정합니다. 라우팅 ID인 `<provider>/<model>`만
넣으면 목록에 있는 비 featured 행이 지정 순서대로 별도 표시 구간(`1000 + i`)에 배치됩니다.
목록에 없는 라우팅 행은 원래 우선순위를 유지하므로 이 구간보다 앞에 남습니다. `subagentModels`에도
들어 있는 행은 featured 우선순위를 유지하고, 네이티브 행도 원래 위치를 유지합니다.
상대적 순서를 정할 라우팅 행은 모두 목록에 넣어야 합니다.

선택기 전체를 정렬하려면 `/`가 없는 카탈로그 ID를 하나 이상 넣으세요. `gpt-5.6-sol`처럼 실제 문자가
있는 bare ID여야 하며, 빈 문자열이나 공백만 있는 항목은 해당하지 않습니다.

```json
{
  "modelPickerOrder": ["gpt-5.6-sol", "opencode-go/glm-5.3"]
}
```

지정한 행이 배열 순서대로 먼저 나오고, 나머지 행은 원래 우선순위대로 뒤에 나옵니다.
카탈로그 ID는 정확히 일치하는 값으로 찾습니다. `gpt-5.6-sol`과 `openai/gpt-5.6-sol`은 서로 다른 행입니다.
같은 라우팅 ID의 원문 표기와 인코딩 표기도 허용하지만, 정확히 일치하는 항목이 우선합니다.
빈 항목과 공백뿐인 항목은 무시합니다. 계정별 행을 지정할 때는 selector가 포함된 전체 ID를 써야 합니다.

### 마이그레이션 주의: 기존 목록에 들어 있는 네이티브 ID

이전에는 `modelPickerOrder`의 bare native ID를 무시했습니다. 이제 기존 목록에 이런 ID가 있으면
featured 행을 포함한 선택기 전체 정렬이 활성화됩니다. 기존 라우팅 전용 동작을 유지하려면 bare ID를
제거하세요. 미설정 목록, 빈 목록, 공백만 있는 목록, 라우팅 ID만 있는 목록은 기존 동작을 유지합니다.

`modelPickerOrder`는 자연 우선순위로 최대 5개의 선호 후보를 고르는 OpenCodex의
서브에이전트 안내용 계산을 보존합니다. 이동한 각 행의 자연 우선순위는 네이티브 `priority`와 별도로
남으며, 선택기 순서만 바꿔서는 이 계산 결과가 달라지지 않습니다. 정확한 모델 이름으로 override를
지정할 자격도 제한하지 않습니다. 광고 목록은 허용 목록이 아니며, 기존 인증·모델·effort·백엔드 제약은
그대로 적용됩니다.

네이티브 Codex는 네이티브 `priority` 순서에서 사용 가능하고 선택기에 표시되는 모델 중 앞의 5개를
`spawn_agent`에 광고합니다. V1과 모델 override를 공개하는 V2가 여기에 해당합니다.
따라서 OpenCodex의 선호 후보가 그대로여도 선택기 순서에 따라 광고되는 5개는 달라질 수 있습니다.
V1에는 OpenCodex의 선호 후보 목록을 주입하지 않습니다. V2는 클라이언트 카탈로그 상태가 허용할 때
자연 우선순위 기반 안내를 추가로 받을 수 있지만, 이 안내가 네이티브 도구의 광고 목록을 재정렬하지는 않습니다.

`disabledModels`와 각 공급자의 `selectedModels`는 노출 여부를 정하는 필드입니다.
별도의 `modelOrder`, `providerOrder`, priority map 설정은 없습니다.

## 대시보드 정렬 프리셋

**Models**에서 기본값·모델 이름순·프로바이더별·사용량순 스냅샷을 선택한 뒤 **순서 적용**을 누르세요. 현재 표시 가능한 라우팅 ID와 `modelPickerOrderMode`(`alphabetical`, `provider`, `most-used`)를 저장합니다. 사용량순은 적용 시 보관된 전체 사용량을 한 번 읽습니다. 다시 열거나 모델이 추가·삭제되어도 자동 재계산하지 않습니다. 기존 사용자 지정·네이티브 전체 순서는 명시적으로 적용하기 전까지 유지됩니다. 기본값은 사용 가능한 모델이 없어도 두 피커 필드를 지웁니다.

`GET/PUT /api/subagent-models`의 `chosen`·`available`은 비활성·누락된 저장 roster도 보존하고, `pickerAvailable`은 선택 가능한 라우팅 ID만 제공합니다. Models는 `pickerOrder`·`pickerOrderMode`만 보내며 `models`를 보내지 않습니다. Roster만 저장하면 피커 설정은 유지됩니다. 잘못된 요청이나 저장 실패는 이전 상태를 보존합니다.

라우팅 전용 프리셋은 featured·네이티브 우선순위 구간을 유지하며 Codex 카탈로그와 Claude 검색 목록의 라우팅 그룹에 적용됩니다. Claude 네이티브 선두 그룹과 명시적 Desktop 프로필·alias 소유권은 유지됩니다. OpenCodex 가이드 순위와 fallback 설정은 유지되지만 네이티브 Codex에 표시되는 상위 5개·권장 기본 모델은 달라질 수 있습니다. 저장은 클라이언트를 재시작하지 않으며 카탈로그 갱신이 미완료이면 나중에 다시 열어야 할 수 있습니다.
