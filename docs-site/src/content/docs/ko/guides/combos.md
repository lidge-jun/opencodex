---
title: "콤보: 페일오버와 로드 밸런싱"
description: "하나의 가상 모델을 여러 공급자에 걸쳐 페일오버나 가중 로드 밸런싱으로 라우팅합니다."
---

**콤보**는 정해진 순서로 나열된 실제 공급자/모델 대상 목록 앞에 서는 하나의 가상 모델입니다. 클라이언트는 `combo/<id>`로 요청하고, opencodex는 대상을 하나 선택해 요청을 그 구체적인 `provider/model`로 다시 쓰며, 첫 번째 대상이 재시도 가능한 실패를 내면 다른 대상을 시도할 수 있습니다.

이 방식은 다음 두 경우에 유용합니다.

- **페일오버:** 하나의 모델을 우선 사용하되, 예비 모델도 준비해 둡니다.
- **로드 밸런싱:** 성공한 요청을 여러 모델이나 공급자에 걸쳐 가중치에 따라 나눕니다.

콤보는 일반 공급자 라우팅 앞단에 놓입니다. `provider/model` 선택자에 익숙하지 않다면 먼저 [Model Routing](/guides/model-routing/)을 읽으십시오.

## 60초 퀵스타트

이 예시는 Anthropic을 먼저, OpenAI를 나중에 두는 `combo/main`을 만듭니다. 두 공급자는 이미 존재하고 활성화되어 있어야 합니다.

```bash
ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol
```

기본 전략은 페일오버이므로 일반 요청은 `anthropic/claude-opus-4-8`으로 갑니다. 그 시도가 재시도 가능한 실패를 내면 opencodex는 `openai/gpt-5.6-sol`로 넘어갈 수 있습니다.

가상 모델은 평소에 모델 ID를 넣는 자리 어디서나 사용할 수 있습니다.

```json
{
  "model": "combo/main",
  "input": "Explain why the sky looks blue."
}
```

저장된 정의를 확인합니다.

```bash
ocx combo show main
```

:::tip
먼저 페일오버와 동일 가중치로 시작하십시오. 트래픽을 의도적으로 분산하고 싶을 때만 round-robin으로 바꾸고, 동일 분산이 적절하지 않을 때만 가중치를 추가하십시오.
:::

## 콤보 이름 동작

`ocx combo set <id>`의 콤보 ID는 문자나 숫자로 시작해야 합니다. 그 뒤에는 문자, 숫자, `.`, `_`, `-`를 포함할 수 있고, 전체 길이는 64자 이하여야 합니다. 정식 모델 ID는 항상 `combo/<id>`입니다. 예를 들어 ID `main`은 `combo/main`이 됩니다.

콤보를 설정하면 `combo/` 네임스페이스는 예약됩니다. 이름이 `combo`인 공급자는 그 자리를 차지할 수 없고, 콤보 ID도 이미 설정된 공급자 이름과 겹칠 수 없습니다.

선택적 alias를 쓰면 콤보의 공개 모델 이름을 따로 둘 수 있습니다. alias는 다음 조건을 따릅니다.

- ID와 같은 문자를 사용합니다.
- `daily-fast`처럼 단독일 수도 있고, `team/daily-fast`처럼 `/`를 하나 포함할 수도 있습니다.
- `combo`일 수 없고 `combo/`로 시작할 수도 없습니다.
- 다른 콤보 alias와 중복될 수 없습니다.
- 일반적으로 `gpt-`, `o1-`, `o3-`, `o4-`, `codex-`로 시작하는 bare OpenAI 계열 이름일 수
  없습니다. 명시적 `nativeAlias: true` Desktop 호환 모드만 예외입니다.

alias를 설정해도 정식 `combo/<id>` 형식은 계속 해석됩니다. 정식 조회가 alias 매칭보다 먼저 실행되므로, alias가 다른 콤보의 정식 ID를 가로챌 수는 없습니다.

:::note
alias는 클라이언트가 요청하는 공개 이름만 바꿉니다. 콤보에 저장된 ID나 그 뒤의 실제 공급자/모델 선택자는 바꾸지 않습니다.
:::

## 전략 선택

### 페일오버: 순서가 있는 기본값과 예비값

`failover`는 설정 순서에서 가장 먼저 적합한 대상을 선택합니다. 대상이 적합하려면 해당 공급자가 존재하고, 활성화되어 있고, 쿨다운 중이 아니며, 요청에 붙은 특수 조건을 처리할 수 있어야 합니다. 이 전략에서는 가중치와 `stickyLimit`이 영향을 주지 않습니다.

다음 순서가 있다고 하겠습니다.

1. `anthropic/claude-opus-4-8`
2. `openai/gpt-5.6-sol`
3. `google/gemini-3-pro`

각 요청은 Anthropic에서 시작합니다. Anthropic에서 재시도 가능한 실패가 나면 그 요청은 OpenAI로 넘어갑니다. OpenAI에서도 재시도 가능한 실패가 나면 Google로 넘어갈 수 있습니다. 종결 오류가 나면 남은 대상은 더 시도하지 않고 즉시 멈춥니다.

### 라운드 로빈: 부드러운 가중 배치

`round-robin`은 smooth weighted round-robin을 사용합니다. 대상 가중치가 클수록 시간에 따라 더 큰 비중을 가져가지만, 그 몫이 한꺼번에 긴 덩어리로 몰리지는 않습니다. `stickyLimit`은 선택된 대상에 몇 번의 성공 요청을 붙여 둘지 정합니다.

성공 요청 두 번씩 묶는 2:1 콤보를 만듭니다.

```bash
ocx combo set balanced \
  --targets anthropic/claude-opus-4-8:2,openai/gpt-5.6-sol:1 \
  --strategy round-robin \
  --sticky 2
```

대상을 **A**(가중치 2)와 **B**(가중치 1)라고 하면, 처음 여섯 번의 가중 선택은 `A, B, A, A, B, A`입니다. `stickyLimit`이 2이므로 각 선택은 성공 요청 두 번 동안 유지됩니다.

| 성공 요청 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 대상 | A | A | B | B | A | A | A | A | B | B | A | A |

장기 비율은 여전히 2:1입니다. 재시도 가능한 실패가 나면 현재 sticky 배치를 끝내고, 그 대상을 쿨다운 상태로 보낸 뒤, 같은 요청에 대해 다른 적합한 대상을 선택합니다.

:::caution
가중치는 비율이며 퍼센트가 아닙니다. `2,1`과 `200,100`은 같은 비율을 뜻합니다. 의도를 분명히 보여 주는 작은 값을 쓰는 편이 좋습니다.
:::

## 대상 실패 시 동작

콤보 실패는 **홉** 실패와 **종결** 실패로 나뉩니다.

| 결과 | 동작 |
| --- | --- |
| HTTP 401, 403, 404, 408, 429, 또는 모든 5xx | 대상을 쿨다운으로 보내고 다음 적합한 대상으로 넘어갑니다. |
| 인증, 구독, 쿼터, 속도 제한, 과부하, 또는 상위 서버 오류로 분류됨 | 상태 코드만으로는 충분하지 않더라도 대상을 쿨다운으로 보내고 넘어갑니다. |
| 클라이언트 취소(499), `origin_rejected`, cyber-policy refusal, context overflow, 또는 invalid request | 멈추고 오류를 반환합니다. 다른 대상을 써도 요청이 유효해지지 않기 때문입니다. |
| 그 밖의 분류되지 않은 오류 | 멈추고 오류를 반환합니다. |

홉된 대상은 기본적으로 60초 동안 쿨다운에 들어갑니다. 상위 응답에 유효한 `Retry-After` 값이 있으면 opencodex는 그 값을 대신 사용합니다. 숫자 초와 HTTP-date 값이 모두 허용되며, 모든 쿨다운은 최대 10분으로 제한됩니다.

현재 요청은 이미 시도한 대상을 다시 시도하지 않습니다. 이후 요청은 그 대상의 쿨다운이 끝날 때까지 건너뜁니다. 적합한 대상이 하나도 남지 않으면 프록시는 HTTP 503과 함께 `error.code = "combo_unavailable"`을 반환합니다.

:::note
페일오버는 의도적으로 범위를 제한합니다. 대상별 가용성, 인증, 쿼터, 과부하 실패에는 도움이 되지만, 호출자 오류나 정책 거부를 숨기지는 않습니다.
:::

## 기본 reasoning effort

`defaultEffort`는 다음 조건이 모두 참일 때만 `reasoning.effort`를 채웁니다.

1. 콤보에 null이 아닌 기본값이 있습니다.
2. 호출자가 effort를 설정하지 않았습니다.
3. 선택된 대상의 카탈로그가 그 정확한 effort를 광고합니다.

요청에 `reasoning` 객체가 없으면 opencodex가 새로 만듭니다. `reasoning`은 있지만 `effort` 속성이 없으면 다른 필드는 그대로 두고 기본값만 추가합니다. 호출자가 준 effort는 절대 덮어쓰지 않습니다.

대상 기능을 알 수 없거나 설정한 effort를 포함하지 않으면 opencodex는 기본값을 생략하고 대상의 동작은 그대로 둡니다. 지원 값은 `low`, `medium`, `high`, `xhigh`, `max`, `ultra`입니다. effort를 호출자와 대상에 완전히 맡기려면 이 필드를 생략하거나 `null`로 설정하십시오.

## 암호화된 v2 서브에이전트 작업

Codex v2 서브에이전트에는 중요한 제한이 하나 있습니다([issue #92](https://github.com/lidge-jun/opencodex/issues/92)). 네이티브 부모 프로세스는 새로 생성된 작업자에게 보낼 작업을 네이티브 ChatGPT 백엔드용으로 생성한 암호문으로만 전달할 수 있습니다. 외부 공급자는 그 페이로드를 읽을 수 없습니다.

이런 요청에서 콤보는 재시도 가능한 실패가 나더라도 정식 네이티브 ChatGPT 경로만 적합 대상으로 남깁니다. 콤보에 복호화 가능한 대상이 하나도 없으면 opencodex는 전송 전에 멈추고 HTTP 400을 반환합니다.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unreadable_encrypted_agent_task"
  }
}
```

이렇게 하면 읽을 수 없는 지시문이 들어 있는 요청이 해당 공급자에게 가지 않습니다. 읽을 수 있는 평문 작업은 일반 콤보 전략을 사용합니다.

복구 방법은 네 가지입니다.

1. 자식에게 네이티브 ChatGPT 모델을 선택합니다.
2. 콤보에 정식 네이티브 ChatGPT 대상을 추가합니다.
3. 서로 다른 공급자 사이의 위임에는 v1 경로를 사용합니다.
4. 호출자를 직접 제어할 수 있다면 작업을 평문 v2 `agent_message` content로 다시 보냅니다.

v1/base/v2 모드와 암호화된 작업의 전체 흐름은 [Sub-agent Surface](/guides/sub-agent-surface/)를 보십시오.

## 콤보 관리

### 대시보드

로컬 대시보드를 열고 **Models → Combos**를 선택합니다. 워크스페이스는 콤보를 만들고, 편집하고, 이름을 바꾸고, 제거할 수 있으며, 대상 선택기에서는 비활성 모델과 중첩 콤보를 제외합니다.

### CLI

주요 명령은 다음과 같습니다.

```bash
ocx combo list
ocx combo show <id>
ocx combo set <id> --targets provider/model[:weight],...
ocx combo remove <id> --yes
```

`set`은 `--strategy`, `--sticky`, `--effort`, `--alias`, `--native-alias`, `--display-name`,
`--rename-from`도 받습니다. `--native-alias`에는 현재 지원되는 bare native alias와 비어 있지 않은 display name이 필요합니다. `--effort`, `--alias`,
`--display-name`에 `-`를 지정하면 해당 값을 지울 수 있습니다. `create`와 `update`는 `set`의
별칭이고 `delete`는 `remove`의 별칭입니다. 모든 combo 하위 명령은 `ocx route combo ...`에서도 사용할 수 있습니다.

### Management API

헤드리스 클라이언트는 `/api/combos`에 `GET`, `PUT`, `DELETE`를 사용합니다. `GET`은 정규화된 콤보 정의를 나열하고, `PUT`은 새 항목을 만들거나 교체하며(이름 바꾸기도 가능), `DELETE`는 id 쿼리 파라미터를 사용합니다. 인증과 요청/응답 세부 내용은 [Management API reference](/reference/management-api/)에 있습니다.

전체 지속 설정은 [Configuration](/reference/configuration/)을 보십시오.

## 구성 참조

콤보는 최상위 `combos` 객체에 저장되며, 콤보 ID로 키를 잡습니다.

```json
{
  "combos": {
    "balanced": {
      "targets": [
        { "provider": "anthropic", "model": "claude-opus-4-8", "weight": 2 },
        { "provider": "openai", "model": "gpt-5.6-sol", "weight": 1 }
      ],
      "strategy": "round-robin",
      "stickyLimit": 2,
      "defaultEffort": "high",
      "alias": "team/balanced"
    }
  }
}
```

| 필드 | 필수 | 기본값 | 규칙 |
| --- | --- | --- | --- |
| `targets` | 예 | — | 설정된 `{ provider, model, weight? }` 대상의 비어 있지 않은 순서가 있는 배열이어야 합니다. 중복된 provider/model 쌍은 거부됩니다. |
| `targets[].weight` | 아니요 | `1` | 1에서 10,000 사이의 정수입니다. round-robin에서 사용되며 failover에서는 무시됩니다. |
| `strategy` | 아니요 | `"failover"` | `"failover"` 또는 `"round-robin"`입니다. |
| `stickyLimit` | 아니요 | `1` | round-robin 선택 한 번당 성공 요청 1에서 100회 사이의 정수입니다. |
| `defaultEffort` | 아니요 | `null` | `low`, `medium`, `high`, `xhigh`, `max`, 또는 `ultra`입니다. 호출자가 effort를 생략하고 대상이 지원을 광고할 때만 적용됩니다. |
| `alias` | 아니요 | 없음 | 선택적으로 앞뒤 공백을 제거한 공개 모델 ID입니다. 위의 alias 규칙을 따릅니다. 빈 값은 alias 없음으로 저장됩니다. |
| `nativeAlias` | 아니요 | `false` | 현재 지원되는 bare native alias가 routing/catalog 우선권을 갖도록 명시적으로 허용합니다. |
| `displayName` | 아니요 | 없음 | catalog 표시 전용 label입니다. `nativeAlias`가 true이면 필수입니다. |

## 문제 해결

### `combo/<id>`가 404를 반환하는 이유는 무엇인가요?

combo id를 찾을 수 없기 때문입니다. 응답은 HTTP 404와 `invalid_request_error` 유형을 반환합니다.
`ocx combo list`를 실행하고, 철자와 대소문자를 확인하고, 관리 명령이 모델 요청을 받는 것과 동일한
opencodex 인스턴스에 기록했는지 확인하세요.

### `combo_unavailable`이 발생하는 이유는 무엇인가요?

모든 대상이 현재 부적격 상태입니다. 예를 들어 프로바이더가 비활성화되었거나, cooldown 중이거나,
이 요청에서 이미 시도되었거나, 암호화된 v2 작업 때문에 제외되었을 수 있습니다. 대상 프로바이더 상태와
최근 업스트림 오류를 확인하세요. cooldown이라면 기본 60초 또는 업스트림 `Retry-After` 기간(최대 10분)을
기다린 뒤 다시 시도하세요.

### alias가 거부된 이유는 무엇인가요?

먼저 alias 문법과 예약 이름을 확인하세요. 중복 alias나 잘못된 형식은 HTTP 400으로 거부됩니다.
첫 세그먼트가 설정된 Codex 계정 네임스페이스인 slash 포함 alias는 HTTP 409로 거부되므로 다른 alias
네임스페이스를 선택하세요. CLI와 대시보드는 서버의 정확한 검증 메시지를 표시합니다.

### 첫 번째 오류 뒤에 failover가 멈춘 이유는 무엇인가요?

대상별 오류가 아니라 종결 오류였기 때문입니다. 잘못된 입력을 수정하고, 너무 큰 context를 줄이고,
정책 거부를 처리하거나, 거부된 요청 origin을 바로잡으세요. combo는 이런 경우 다음 대상으로 넘어가지
않습니다.
