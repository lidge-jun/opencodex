---
title: 에이전트 설정
description: 멀티 에이전트 표면, 위임 안내, 선호 모델, 대체 체인, 기본값 동기화, 노력 상한을 다룹니다.
---

에이전트 설정은 어떤 Codex 협업 표면을 노출할지와, opencodex가 위임 작업을 어떻게 안내하고, 라우팅하고, 제한할지를 제어합니다.

## 에이전트 필드

| 필드 | 형식 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1`은 카탈로그의 모든 모델에 v1을 표시하고, `v2`는 모든 모델에 v2를 표시합니다. `default`는 상위 고정값(Sol/Terra는 v2, Luna는 v1)을 복원하고, 그 외에는 네이티브 `multi_agent_v2` 플래그를 따릅니다. 새 세션에 적용됩니다. |
| `subagentModels?` | `string[]` | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | 최대 다섯 개의 bare native id, account-qualified `<selector>/<native-openai-model>` id 또는 routed `provider/model` id를 서브에이전트 선택기에서 우선 표시합니다. Subagents 페이지는 bare native와 routed id만 제공하며 저장할 때 exact account-qualified 선택을 제외합니다. exact 선택은 `ocx agent subagents set`을 사용하거나 설정을 직접 편집하세요. 명시적인 빈 목록도 그대로 보존됩니다. |
| `injectionModel?` | `string` | — | 프록시가 작성한 v2 위임 안내에서 사용하는 선호 네이티브 또는 라우팅된 서브에이전트 모델입니다. |
| `injectionEffort?` | `string` | — | 선호 노력(`low`부터 `ultra`까지)입니다. `injectionModel`이 있을 때만 의미가 있습니다. |
| `injectionPrompt?` | `string` | — | 내장 v2 안내 본문을 대체합니다. `{{model}}`, `{{effort}}`, `{{roster}}`, `{{fallback}}`를 지원합니다. `injectionModel`만 설정되어 있어도 사용자 정의 프롬프트가 발동합니다. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | opencodex가 작성하는 v1/v2 개발자 안내만 제어합니다. 네이티브 에이전트 기본값, 도구, 라우팅, 로스터, 노력 상한은 바꾸지 않습니다. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | 동기화 또는 재시작 시 `injectionModel`과 선택적 `injectionEffort`를 Codex의 네이티브 기본값으로 기록하도록 선택합니다. `injectionModel`이 필요합니다. |
| `subagentModelFallback?` | `string[]` | `[]` | 생성된 하위 턴에 적용되는 전역 대체 모델 우선순위 목록입니다. |
| `subagentModelFallbackByModel?` | `Record<string, string[]>` | `{}` | 요청한 기본 모델 id를 키로 하는 모델별 대체 체인입니다. 역할별 대체 메타데이터의 지원 위치입니다. Codex agent TOML에 `model_fallback`을 쓰면 Codex 0.146+가 역할을 건너뜁니다 (#1190). |
| `subagentModelFallbackPollMs?` | `number` | `60000` | 사용 가능성 검사 캐시 간격입니다. 1000 ms 미만의 값은 기본값으로 돌아갑니다. |
| `effortCap?` | `string` | — | 자격을 갖춘 v2 메인 턴과 표시된 생성 하위 턴에 대한 하드 상한입니다. `low`부터 `ultra`까지 허용합니다. |
| `subagentEffortCap?` | `string` | — | 생성된 하위 턴에만 적용되는 추가 상한입니다. 두 상한이 모두 적용되면 더 낮은 값이 이깁니다. |

이 표면은 대시보드나 `ocx v2 status|on|off|mode <v1|default|v2>|threads <n>`로 관리합니다. 모드 변경은 새 세션에 적용됩니다. `maxConcurrentThreadsPerSession`은 `config.json` 키가 아니라 `PUT /api/v2` 필드입니다. `ocx v2 threads <n>`는 v2가 활성화된 뒤 Codex의 `$CODEX_HOME/config.toml` 안 `[features.multi_agent_v2]` 아래에 `max_concurrent_threads_per_session`을 기록합니다.

관리 API는 `GET`/`PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`를 제공합니다. injection-model 업데이트는 부분 업데이트입니다. 사용자 지정 프롬프트는 이 API의 `prompt` 필드입니다.

## 로스터와 안내

실제 v2 로스터는 설정되어 있고, 선택기에 보이며, 우선순위로 정렬된 상위 다섯 모델 중 v2와 호환되고 주입된 카탈로그에 존재하는 모델입니다. v2 적격성은 명시적인 `"v2"`, `null`, 또는 생략된 상위 고정값을 적격으로 보고, 실제 `"v1"` 고정값은 제외합니다. 제외된 항목은 나중에 적격이 될 수 있도록 설정에 그대로 남습니다.

표면 판별은 도구 형태를 기준으로 합니다. 네임스페이스가 붙은 `spawn_agent`에 `send_input`, `resume_agent`, `close_agent`가 있으면 v1입니다. 평평한 `spawn_agent`에 `send_message`, `followup_task`, `interrupt_agent`, `list_agents`가 있으면 v2입니다.

V1 안내는 `max` 또는 `ultra`에서만 선제 텍스트로 제공됩니다. V2는 선호 모델, 적격 로스터, 대체 체인 중 하나가 있을 때만 프록시가 작성한 개발자 메시지를 받습니다. 내장 v2 안내에는 700자 예산이 있고, 필요하면 로스터를 먼저 줄입니다. 안내는 replay prefix 전반에서 중복 제거되며, 뒤에 오는 `compaction_trigger` 앞에 삽입됩니다.

`injectionModel`과 `injectionEffort`는 네이티브 기본값 동기화가 활성화되지 않으면 권고 수준입니다. 내장 v2 텍스트는 Codex에게 지원되는 모델/노력 오버라이드를 `fork_turns: "none"`과 함께 `spawn_agent`로 전달하라고 요청합니다. 사용자 지정 `injectionPrompt`는 누락된 값을 빈 문자열로 대체합니다.

## Codex 기본값 동기화

활성화되면 `syncCodexSubagentDefaults`는 마커가 소유한 `[agents] default_subagent_model` 및 `default_subagent_reasoning_effort` 필드를 기록합니다. 기존의 표시 없는 사용자 소유 대상 필드는 충돌로 간주하며 그대로 우선합니다. 일부만 지정됐거나 모호한 TOML 쓰기는 보수적으로 실패합니다. `injectionModel`을 지우면 이 옵트인도 함께 해제됩니다. 이 기본값은 새로 만들어지는 Codex 작업에만 영향을 주며, 그 자체로 위임을 일으키지는 않습니다.

## 대체 체인

생성된 하위 작업의 대체 순서는 다음과 같습니다.

1. 요청된 기본 모델
2. `subagentModelFallbackByModel`의 모델별 체인 (기본 모델이 키)
3. 전역 `subagentModelFallback` 항목

역할별 폴백 체인은 opencodex 설정에 있어야 합니다. `model_fallback`을
`$CODEX_HOME/agents/*.toml`에 쓰면 Codex 0.146+가 알 수 없는 필드로 역할 파일 전체를
거부하고 역할을 건너뜁니다 (#1190). TOML의 기존 `model_fallback` 줄은 하위 호환성을 위해
계속 읽히지만 `ocx doctor`가 이를 표시합니다.

opencodex는 비활성, 라우팅 불가, 비정상, 쿨다운 중, 또는 할당량 임계값에 걸린 후보를 건너뜁니다. 사용 가능성 스냅샷은 `subagentModelFallbackPollMs` 동안 캐시됩니다. 암호화된 하위 작업은 체인을 정규 네이티브 ChatGPT 대상으로만 제한할 수 있습니다. 어떤 대상도 암호화된 페이로드를 읽을 수 없으면, 읽을 수 없는 암호문을 다른 곳으로 라우팅하는 대신 요청이 실패합니다.

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackByModel": {
    "gpt-5.5": ["gpt-5.4-mini"]
  },
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## 노력 상한

상한은 v2 협업 기능에만 적용됩니다. 메인 턴은 도구가 v2를 노출할 때 적격이 되고, 하위 턴은 leaf 도구가 더 이상 협업을 노출하지 않더라도 `x-codex-turn-metadata` 안에 codex-rs의 정확한 `x-openai-subagent: collab_spawn` 또는 `"subagent_kind": "thread_spawn"` 표시가 있으면 적격이 됩니다. V1 메인 턴, `multiAgentMode: "v1"`, compaction, review, memory-consolidation 턴은 상한을 적용받지 않습니다.

상한은 노력만 낮춥니다. 모델이 광고한 단계 중 상한 이하에서 가장 높은 단계로 맞춥니다. 모델에 노력 제어가 없거나 맞는 지원 단계가 없으면, opencodex는 노력을 제거하고 제공자 기본값을 적용합니다. `max`와 `ultra`는 허용되며, 대시보드는 `low`부터 `xhigh`까지 제공합니다.

v1, default, v2 동작에 대한 초보자용 설명은 [Sub-agent surfaces](/guides/sub-agent-surface/)를 참고하세요.
