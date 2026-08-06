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
않고 fail closed하며 active Pool account도 변경하지 않습니다. 적격 selector가 하나 이상 설정되면
Codex catalog는 bare native picker row를 숨기고 각 selector마다 별도의
`<selector>/<native-openai-model>` row를 표시합니다. bare native model id는 명시적으로 비활성화하지
않는 한 기존 Pool / Direct routing을 유지하고 raw `/v1/models`에도 남습니다. 매핑된 저장 계정이 없는
selector는 표시되지 않습니다. selector 검증, 충돌 규칙, privacy guidance는
[공급자 설정](/reference/configuration/providers/)을 참고하십시오.

## Combos (`config.combos`)

각 combo 키는 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`에 맞는 id입니다. 항상 `combo/<id>`로 직접 접근할 수 있고, 추가로 하나의 `alias`를 노출할 수 있습니다. alias는 유일해야 하고 `combo/` 네임스페이스를 차지할 수 없으며, 일반적으로 `gpt-*`, `o1-*`, `o3-*`, `o4-*`, `codex-*` 같은 예약된 bare native family를 사용할 수 없습니다. 명시적 `nativeAlias: true` Desktop 호환 계약만 예외입니다.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | required | 순서가 있는 concrete route입니다. `weight`는 1–10000이며 기본값은 `1`입니다. |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` | 선택 전략입니다. 대상 순서는 failover 우선순위이며, weight는 smooth weighted round-robin의 모양을 결정합니다. |
| `stickyLimit?` | `number` | `1` | 한 round-robin 배치에서 유지되는 성공 요청 수입니다. 범위는 1–100입니다. |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | unset | 호출자가 effort를 생략했고 선택된 대상이 요청한 rung를 광고할 때만 적용됩니다. |
| `alias?` | `string` | — | 정규화된 picker slug 대신 쓰는 선택적 공개 model id입니다. |
| `nativeAlias?` | `boolean` | `false` | 현재 지원되는 bare native id가 해당 비수식 id에만 우선하도록 합니다. 계정 또는 프로바이더로 수식된 OpenAI route는 별도로 유지됩니다. |
| `displayName?` | `string` | — | catalog 표시 전용 label이며 native alias에서는 비어 있지 않아야 합니다. |

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

## 라우팅 정책 프로필 (`config.routingProfiles`)

명시적으로 요청된 `policy/<id>`(또는 설정된 별칭)가 고정된 후보 허용 목록에서 하드 능력 요구사항과 결정적·설명 가능한 점수로 선택합니다. 기존 모델 ID가 암시적으로 프로필을 통과하지 않습니다. `candidates`(명시적 허용 목록), 선택적 `alias`, `require`(`minContextWindow`, `minQuotaHeadroom`, `tools`, `imageInput`, `structuredOutput`, `localOnly`, `remoteAllowed`, `encryptedCodexTasks`, `reasoningEffort`, `serviceTier`), `optimize`(latency/health/cost/quota 가중치), `limits.maxEstimatedCostUsd`, `unknownEvidence`(allow/penalize/exclude)를 지원합니다. 알 수 없음은 0이나 무료가 되지 않습니다.

CLI: `ocx route policy list`, `ocx route policy show <id>`, `ocx route policy dry-run <id> --model-context <tokens> --tools`, `ocx route policy evaluate <id>`.

콤보는 명시적인 순서·가중치 대상 라우팅 및 장애 조치입니다. 정책 프로필은 후보 간 증거 기반 선택입니다.

## 요청 기록 및 라우팅 분석

- `GET /api/request-history` - 파생 인덱스(`routing-history.sqlite`)에서 커서 페이지네이션으로 전체 기록을 조회. 필터: `provider`, `model`, `requestedModel`, `status`, `conversationId`, `surface`, `inboundProtocol`, `apiKeyId`, `profileId`, `fallback`, `from`, `to`.
- `GET /api/request-history/:requestId/route-decision` - 이 경로가 선택된 이유(추적, 후보, 제외, 점수, 프로필+리비전, 실행 시도, 결과).
- `GET /api/routing-analytics` - 성공/실패/취소/폴백 비율, p50/p95/p99 소요 시간 및 TTFT, 불완전 스트림 비율, 쿨다운 실패 수, 성공 요청당 추정 비용, 커버리지, 신뢰도, 잘림 플래그.
- `GET /api/routing-profiles`, `POST /api/routing-profiles/dry-run` - 프로필 조회와 드라이런 평가(업스트림 전송 없음).

반환되는 히스토리와 라우트 결정 페이로드는 마스킹된 요청 메타데이터만 노출합니다(예: 불투명한 `apiKeyId` 라벨). 자격 증명, 원본 프롬프트 본문, 공급자 시크릿은 포함하지 않습니다.

CLI: `ocx logs explain <request-id>`, `ocx logs rebuild-index`, `ocx logs index-status`.

## 마이그레이션

`routingProfiles`는 선택적 추가 설정입니다. 기존 설정 파일과 이전 `usage.jsonl` 행은 그대로 읽힙니다. 인덱스는 일회용이며 삭제 시 다음 쿼리에서 `usage.jsonl`로 자동 재구축됩니다. 자동 튜닝은 없습니다.
