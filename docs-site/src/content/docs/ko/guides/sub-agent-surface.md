---
title: 서브에이전트 서피스 (v1 / base / v2)
description: Codex가 모든 모델에서 서브에이전트를 생성하고 관리하는 방식을 제어합니다.
---

## 서브에이전트란

서브에이전트는 메인 에이전트가 집중된 작업을 맡기기 위해 생성할 수 있는 별도의 Codex 작업자입니다. 자체 컨텍스트와 도구를 가지므로 서로 독립적인 작업을 병렬로 진행할 수 있습니다. opencodex는 어떤 Codex 협업 서피스가 이 작업자들을 노출할지, Codex가 서브에이전트에 어떤 모델을 제공할지, 실패한 모델이 어떻게 대체 경로로 넘어갈지를 제어합니다. 다만 메인 에이전트가 언제 위임해야 하는지는 결정하지 않습니다.

## 모드

새 세션에는 원하는 모드를 고르세요. 이미 시작된 세션은 시작할 때의 서피스를 유지합니다.

| 모드 | Codex에 제공되는 것 | 누구에게 적합한가 |
| --- | --- | --- |
| **v1** | 네임스페이스 방식의 클래식 `spawn_agent`, `send_input`, `resume_agent`, `close_agent` 툴을 제공합니다. 스폰 시 다른 모델을 직접 고를 수 있습니다. | 서로 다른 프로바이더를 넘나드는 위임을 안정적으로 써야 하는 초보자에게 적합합니다. 특히 네이티브에서 라우팅된 자식으로 넘어가는 경우에 좋습니다. |
| **base** (기본값) | 업스트림 모델 핀을 따릅니다. GPT-5.6 Sol/Terra는 v2를, Luna는 v1을 사용하고, 핀이 없는 모델은 Codex의 `multi_agent_v2` 기능 플래그를 따릅니다. | 대부분의 사용자에게 적합합니다. 전역 강제 없이 각 모델에 대해 Codex가 의도한 서피스를 따릅니다. |
| **v2** | 플랫 `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, 에이전트 목록 툴을 제공하며, 동시 세션을 지원합니다. | 더 새로운 동시 워크플로를 원하고, 모델 상속과 아래의 암호화 작업 제한을 이해하는 사용자에게 적합합니다. |

:::tip[헷갈리시나요?]
**base**부터 시작하세요. 서로 다른 프로바이더를 안정적으로 넘나드는 위임이 필요하면 **v1**을 고르세요. 모든 카탈로그 항목에서 더 새로운 세션 모델을 명시적으로 쓰고 싶을 때만 **v2**를 강제로 선택하세요.
:::

## 동작 방식

선택한 모드는 Codex가 읽는 모든 카탈로그 항목의 `multi_agent_version` 필드를 결정합니다.

- **v1**은 모든 모델에 `multi_agent_version = "v1"`을 설정합니다.
- **base**는 업스트림 핀을 복원합니다. 핀이 없는 항목은 기본 `multi_agent_v2` 기능 플래그를 따릅니다.
- **v2**는 모든 모델에 `multi_agent_version = "v2"`를 설정합니다. 단 **ChatGPT를 v1로 유지**를 켜면 예외입니다: ChatGPT 네이티브 항목은 `"v1"`로 남고, 라우팅/콤보 항목은 `"v2"`가 됩니다.

opencodex는 이 값을 Codex가 읽는 실시간 `/v1/models` 카탈로그와 디스크에 동기화된 카탈로그 모두에 마지막 단계로 적용합니다. 그래서 모드를 바꾸면 새로 만들어지는 App, CLI, TUI 세션에 일관되게 반영됩니다.

v2 로스터의 경우 적합성은 세 가지 상태로 나뉩니다. `"v2"`로 표시된 항목, 명시적으로 `null`로 설정된 항목, 또는 `multi_agent_version` 필드가 없는 항목은 사용 가능합니다. 진짜 `"v1"` 핀은 해당 모델이 다른 협업 서피스에 속한다고 명시하므로 제외됩니다.

## 위임 모델과 추론 강도

대시보드의 **서브에이전트 위임** 설정은 다음 세 가지 값을 제어합니다.

- `injectionModel`은 opencodex 가이드에서 선호하는 작업자 모델입니다.
- `injectionEffort`는 해당 모델에 요청할 선택적 `reasoning_effort`입니다.
- `injectionPrompt`는 내장 v2 가이드 문구를 바꿉니다.

`multiAgentGuidanceEnabled`는 기본적으로 켜져 있으며, opencodex가 작성한 가이드에 대한 전역 스위치입니다. 이 값을 끄면 v2 지정 블록과 v1의 능동적 안내 문구가 모두 사라집니다.

이 값들은 메인 에이전트에 대한 지시이며, 프록시 쪽 스폰 라우터가 아닙니다. v2에서는 전체 히스토리 fork가 부모 모델을 상속하고 모델 또는 추론 강도 오버라이드를 거부합니다. 그래서 가이드는 `model` 또는 `reasoning_effort`를 넘길 때 `fork_turns: "none"`(또는 `"3"` 같은 양수 부분 turn 수)을 사용하고, 작업 메시지를 자체 완결형으로 만들라고 안내합니다.

사용자 정의 `injectionPrompt`에는 다음 네 개의 플레이스홀더를 모두 쓸 수 있습니다.

| 플레이스홀더 | 대체되는 값 |
| --- | --- |
| `{{model}}` | 이 요청에 적용되는 선호 모델. 선택자가 없는 네이티브 `injectionModel`은 요청 자체가 명시적 계정 선택자를 대상으로 할 때만 해당 계정으로 한정됩니다. 선택자가 없는 값을 해석할 수 없거나 결과가 모호하면 빈 문자열이 되며, 명시적으로 계정이 한정되었거나 라우팅된 ID는 해석되지 않아도 원래 값을 유지합니다 |
| `{{effort}}` | 설정된 `injectionEffort`, 또는 빈 문자열 |
| `{{roster}}` | 해석된 선택기 표시 가능, 서피스 호환 로스터 |
| `{{fallback}}` | 설정된 전역 폴백 가이드 |

내장 v2 가이드는 700자 예산을 가집니다. 이 한도를 넘기면 opencodex는 핵심 스폰 지시를 자르는 대신 로스터를 먼저 제거합니다. 내장 가이드는 선호 모델, 적합한 로스터 또는 폴백 체인이 해석될 때만 발화합니다. 사용자 정의 프롬프트는 `injectionModel`만 설정되어 있어도 발화하며, 선택자가 없는 값을 하나로 해석할 수 없으면 `{{model}}`은 빈 문자열로 치환됩니다.

v1에서는 opencodex가 `max` 또는 `ultra` 추론 강도에서만 업스트림 스타일의 능동 위임 가이드만 주입합니다. v1에는 선호 모델, 로스터, 폴백 목록, 사용자 정의 프롬프트를 추가하지 않습니다.

기본값이 꺼진 `syncCodexSubagentDefaults` 옵션은 가이드와 별개입니다. opencodex가 활성 Codex 라우팅을 소유하는 경우, 동기화나 재시작 시 선택한 값을 Codex TOML의 표식이 붙은 `[agents] default_subagent_model` 및 `default_subagent_reasoning_effort` 항목으로 쓸 수 있습니다. opencodex는 자신이 붙인 표식이 있는 필드만 갱신하거나 제거합니다. 대상 필드 중 하나라도 사용자 소유라면 부분 쓰기는 하지 않고 쌍을 그대로 둡니다. 애매한 TOML은 쓰기 없이 거부합니다. 외부 프로바이더 관리자와 사용자 소유 루트 라우팅도 여전히 최종 권한을 가집니다.

## Fallback 체인

스폰된 작업자에 대해 opencodex는 다음 우선순위를 적용합니다.

1. 요청한 기본 모델
2. opencodex 설정의 `subagentModelFallbackByModel`에 있는 모델별 체인 (요청한 기본 모델이 키)
3. opencodex 설정의 전역 `subagentModelFallback` 목록

역할별 폴백 체인은 `$CODEX_HOME/agents/*.toml`이 아니라 opencodex 설정에 두어야 합니다. Codex 0.146+는 에이전트 역할 파일을 엄격하게 역직렬화하며 `model_fallback`을 알 수 없는 필드로 거부해 역할 정의 전체를 건너뜁니다 (#1190). opencodex는 하위 호환성을 위해 TOML의 기존 `model_fallback` 줄을 계속 읽을 수 있지만, `ocx doctor`가 경고하며 Codex 자체는 해당 역할을 무시합니다.

중복 모델 id는 첫 번째 출현을 유지한 채 제거합니다. 선택 과정에서 opencodex는 비활성화된 후보, 라우팅 불가 후보, 비활성화된 프로바이더가 받쳐주는 후보, unhealthy로 표시된 후보, cooldown 중인 후보, 사용할 수 있는 pooled Codex 계정이 없는 후보, 또는 설정된 quota 임계치를 넘는 후보를 건너뜁니다. 가용성 프로브는 기본값 60초인 `subagentModelFallbackPollMs` 동안 캐시됩니다.

폴백이 호환되지 않는 암호화 작업을 읽을 수 있게 만들어 주지는 않습니다. 자식 작업이 ChatGPT용으로 암호화되어 있으면, 체인 앞쪽에 외부 모델이 있더라도 선택은 정규 네이티브 ChatGPT 대상만 허용됩니다.

## 암호화된 v2 작업 전달

Codex는 v2 네이티브→라우팅 자식 작업을 백엔드 암호화된 `encrypted_content`로만 보낼 수 있습니다. 이 페이로드는 네이티브 ChatGPT 백엔드가 읽을 수 있지만 외부 프로바이더는 읽을 수 없습니다. 이것이 알려진 [#92 제한](https://github.com/lidge-jun/opencodex/issues/92)입니다.

opencodex는 읽을 수 없거나 빈 작업을 그대로 넘기지 않고 안전하게 실패합니다.

- 비네이티브 직접 라우팅은 HTTP 400과 `error.code = "unreadable_encrypted_agent_task"`를 반환하며, 암호문을 에코하지 않습니다.
- 콤보는 해당 작업에 대해 재시도를 포함해 정규 네이티브 ChatGPT 대상만 고려합니다. 사용할 수 있는 대상이 없으면 같은 400 오류를 반환합니다.
- 읽을 수 있는 평문 작업은 정상 라우트와 폴백 동작을 그대로 유지합니다.

복구 방법은 네이티브 ChatGPT 자식을 선택하거나, 콤보에 네이티브 ChatGPT 대상을 추가하거나, 이종 프로바이더 위임에는 v1을 사용하거나, 호출자를 제어할 수 있을 때 작업을 평문 v2 `agent_message` 콘텐츠로 다시 보내는 것입니다.

실험적인 `agentTaskRecovery`는 기본적으로 꺼져 있습니다. 명시적으로 켜면 고정된 ChatGPT 엔드포인트로 인증된 요청을 하나 더 보내 이 형식을 복구할 수 있지만, 할당량과 지연 시간이 늘고 비공개 백엔드 동작에 의존합니다. 실패하면 기존 `unreadable_encrypted_agent_task` 오류를 그대로 유지합니다. 자세한 내용은 [영문 설정 참고 문서](/reference/configuration/agents/#encrypted-v2-task-recovery)를 보세요.

## 모드 변경

### GUI

- **Dashboard** → 첫 번째 상태 셀: **v1**, **base**, **v2**를 고릅니다.
- **Models** → 맨 위 행의 세그먼트 선택기: 같은 전역 모드를 고릅니다.
- **Dashboard** → **Sub-agent delegation**: 가이드 모델/추론 강도와 네이티브 기본값 사용 여부를 설정합니다.
- **Subagents**: 로스터를 선택하고 순서를 정한 뒤 전역 폴백 체인을 설정합니다.

### CLI

서피스 협업 설정과 네이티브 기능 설정에는 `ocx v2`를 사용합니다.

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 mode v2
ocx v2 threads 8
```

위임, 로스터, 추론 상한, 폴백 설정에는 `ocx agent`를 사용합니다.

```bash
ocx agent status
ocx agent injection set --model anthropic/claude-sonnet-5 --effort xhigh
ocx agent subagents set gpt-5.6-sol,anthropic/claude-sonnet-5
ocx agent fallback set gpt-5.4-mini,xai/grok-4.5 --poll-ms 60000
ocx agent effort set --subagent max
```

널 값이 가능한 `ocx agent injection` 값을 지우려면 `-`를 넘기거나, 로스터나 폴백 목록에는 해당 `clear` 액션을 사용하세요. 모든 명령 패밀리는 [CLI reference](/reference/cli/)를 참고하세요.

### API

관리 API는 대응하는 `GET`과 `PUT` 엔드포인트를 제공합니다.

| 엔드포인트 | 관리하는 항목 |
| --- | --- |
| `/api/v2` | 서피스 모드, 네이티브 기능 플래그, 스레드 설정 |
| `/api/injection-model` | 선호 모델, 추론 강도, 사용자 정의 프롬프트, 가이드, 네이티브 기본값 동기화 |
| `/api/effort-caps` | 메인 에이전트와 서브에이전트의 추론 상한 |
| `/api/subagent-models` | 최대 다섯 모델의 순서가 있는 로스터 |
| `/api/subagent-model-fallback` | 전역 폴백 순서와 폴링 간격 |

예를 들면 다음과 같습니다.

```bash
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode":"v2"}'

curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","effort":"xhigh"}'
```

## FAQ

### 위임 모델을 고르면 Codex가 반드시 그 모델을 스폰하나요?

아닙니다. 가이드는 모델을 추천할 수 있고, 네이티브 기본값 동기화는 Codex 기본값을 제공할 수 있지만, 실제로 위임할지는 여전히 메인 에이전트가 결정합니다.

### v2 자식이 왜 부모 모델을 썼나요?

전체 히스토리 v2 fork는 부모 모델을 상속합니다. `fork_turns`를 `"none"` 또는 양수의 부분 turn 수로 설정한 spawn을 사용한 뒤 모델이나 추론 강도 오버라이드를 넘기세요.

### 왜 설정한 모델이 v2 로스터에서 빠지나요?

선택기에서 숨겨져 있거나, 다섯 모델 표시 한도를 넘었거나, 카탈로그에 없거나, v1에 고정되어 있을 수 있습니다. `v2`, `null`, 또는 값이 없는 서피스 값은 사용할 수 있지만, 실제 `"v1"` 핀은 사용할 수 없습니다.

### 모드를 바꾸면 실행 중인 세션에도 반영되나요?

아닙니다. 모드를 바꾼 뒤에는 새 Codex 세션을 시작하세요. 오래 실행 중인 App 호스트에 오래된 카탈로그 상태가 남아 있으면 `ocx sync`를 실행한 뒤 해당 Codex 서피스를 다시 시작하세요.

### 추론 강도

`injectionEffort`는 위임된 작업자 가이드와, 명시적으로 활성화한 경우 네이티브 Codex 서브에이전트 기본값에만 영향을 줍니다. 부모 세션의 추론 강도는 바꾸지 않습니다. `ultra`는 Codex가 `max`로 변환하는 클라이언트 노출 상위 단계이며, opencodex는 그 값을 선택한 프로바이더에 맞게 매핑하거나 클램프합니다.

### 컨텍스트 상한

모델 컨텍스트 상한은 서브에이전트 모드와 무관합니다. Models 페이지에서 설정하세요. 네이티브 OpenAI 모델은 실제 컨텍스트 윈도우를 그대로 유지합니다.
