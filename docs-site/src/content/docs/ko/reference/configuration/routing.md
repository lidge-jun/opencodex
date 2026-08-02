---
title: 라우팅 설정
description: 기본 provider 선택, model 해석 순서, combo 별칭, 대상 순서, effort 기본값입니다.
---

라우팅은 클라이언트가 보낸 model id를 하나의 실제 provider와 upstream model로 바꿉니다.

## 최상위 라우팅 필드

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` | 앞선 모델 규칙이 하나도 맞지 않을 때 쓰는 최종 provider입니다. 활성화되어 있고 설정된 provider 이름이어야 합니다. |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | 순서가 정해진 provider/model 대상들로 구성한 가상 `combo/<id>` 모델입니다. |

## 모델 해석 순서

opencodex는 요청된 model을 다음 순서로 해석합니다:

1. 설정된 `<account-selector>/<native-openai-model>` 네임스페이스입니다. 매핑된 저장 Codex 계정으로만 routing하며, exact target이 잘못되었거나 사용할 수 없으면 fail closed합니다.
2. 정규화된 `combo/<id>` 또는 설정된 combo 별칭입니다. 정규화된 id가 별칭보다 먼저 적용됩니다.
3. 접두사가 설정된 provider를 가리키는 명시적 `<provider>/<model>` 네임스페이스입니다.
4. `gpt-*`, `o1-*`, `o3-*`, `o4-*` 같은 bare native OpenAI 계열 id입니다. 이 경우 정규화된 활성 `openai` provider를 통해 라우팅합니다.
5. provider의 `defaultModel`과 정확히 일치합니다.
6. 알려진 provider-family model prefix입니다.
7. provider의 설정된 `models` 목록 안의 정확한 model입니다.
8. `defaultProvider`이며, 요청한 model id를 그대로 유지합니다.

비활성화된 provider는 제외합니다. 비활성화된 provider의 명시적 네임스페이스는 다음 규칙으로 넘어가지 않고 실패합니다. 여러 provider에 걸쳐 일치할 수 있는 규칙은 JSON에 적힌 삽입 순서대로 provider 항목을 검사하므로, bare model이 애매할 수 있으면 명시적 네임스페이스를 사용하십시오.

## 명시적 Codex 계정 selector

`codexAccountNamespaces`는 `side` 같은 공개 selector를 저장된 Codex 계정 하나에 매핑합니다.
`side/gpt-5.6-sol` 요청은 canonical `openai` provider가 Direct mode여도 그 계정만 사용하고,
upstream에는 bare `gpt-5.6-sol` model id를 보냅니다. selector 뒤에는 bare native OpenAI-family
id만 사용할 수 있습니다.

명시적 선택은 Pool assignment strategy와 일반 thread affinity를 우회합니다. 매핑된 account가 없거나,
일시 중지되었거나, cooldown 중이거나, 사용할 수 없거나, 재인증이 필요하면 다른 account로 전환하지
않고 fail closed하며 active Pool account도 변경하지 않습니다. bare native model id는 기존 Pool /
Direct routing을 유지합니다. namespace map 자체는 model picker row를 만들지 않습니다. selector 검증,
충돌 규칙, privacy guidance는 [공급자 설정](/reference/configuration/providers/)을 참고하십시오.

## Combos (`config.combos`)

각 combo 키는 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`에 맞는 id입니다. 항상 `combo/<id>`로 직접 접근할 수 있고, 추가로 하나의 `alias`를 노출할 수 있습니다. alias는 유일해야 하고 `combo/` 네임스페이스를 차지할 수 없으며, `gpt-*`, `o1-*`, `o3-*`, `o4-*`, `codex-*` 같은 예약된 bare native family도 사용할 수 없습니다.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | required | 순서가 있는 concrete route입니다. `weight`는 1–10000이며 기본값은 `1`입니다. |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` | 선택 전략입니다. 대상 순서는 failover 우선순위이며, weight는 smooth weighted round-robin의 모양을 결정합니다. |
| `stickyLimit?` | `number` | `1` | 한 round-robin 배치에서 유지되는 성공 요청 수입니다. 범위는 1–100입니다. |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | unset | 호출자가 effort를 생략했고 선택된 대상이 요청한 rung를 광고할 때만 적용됩니다. |
| `alias?` | `string` | — | 정규화된 picker slug 대신 쓰는 선택적 공개 model id입니다. |

```json
{
  "defaultProvider": "openai",
  "combos": {
    "coding": {
      "targets": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openrouter", "model": "qwen/qwen3-coder-plus" }
      ],
      "strategy": "failover",
      "defaultEffort": "high",
      "alias": "coding-primary"
    }
  }
}
```

전략 동작, 재시도 가능한 실패, cooldown, 암호화된 v2 task limit, 관리 명령은 [Combos](/guides/combos/)를 참고하십시오.

### 카탈로그 적격성

combo는 목록에 오를 수 없더라도 계속 직접 라우팅할 수 있습니다. `ocx sync`, `/v1/models`, 그리고 Codex picker는 다음 조건을 모두 만족할 때만 이를 나열합니다:

- live metadata, registry hint, 또는 provider의 `modelContextWindows` / `contextWindow`에서 얻은 양수 `contextWindow`
- 비어 있지 않은 `inputModalities` 교집합. 생략된 member value는 `["text"]`로 취급합니다.

context metadata가 없는 bare relay id이거나 modalities가 서로 겹치지 않는 target이 있으면 combo가 catalog에서 빠집니다. sync는 summary warning을 내고 dashboard는 이를 **Needs attention**으로 표시합니다. context metadata를 추가하거나, modalities를 맞추거나, 발견 가능한 호환 capability를 가진 model을 대상으로 삼으십시오.
