---
title: 서브에이전트 서피스 (v1 / base / v2)
description: 모든 모델의 Codex 서브에이전트 생성·관리 방식을 전역으로 제어합니다.
---

opencodex에서는 카탈로그의 모든 모델이 사용할 멀티에이전트 협업 서피스를 선택할 수 있습니다. 대시보드와 모델 페이지의 **서브에이전트** 토글이 이 값을 전역으로 제어합니다.

:::note
v2 서피스(`multi_agent_v2`)의 서브에이전트는 **기본적으로** 부모 모델을 상속합니다. `fork_turns` 기본값이 `all`이고, 전체 히스토리 fork는 오버라이드를 거부하기 때문입니다. v2.7.2부터 opencodex가 상속을 깨는 방법을 가이드로 주입합니다. `fork_turns`를 `"none"`(또는 `"3"` 같은 부분 fork)으로 지정한 `spawn_agent` 호출은 `model` / `reasoning_effort` 인자를 전달할 수 있고, 공개된 툴 스키마에 이 인자가 안 보여도 Codex 런타임은 파싱해서 적용합니다. 알려진 전송 제한: **네이티브** 부모가 **비네이티브**(라우팅) 프로바이더의 자식을 스폰하면 Codex 클라이언트가 `NEW_TASK` 페이로드를 백엔드 암호화된 `encrypted_content`로만 볼 수 있습니다([#92](https://github.com/lidge-jun/opencodex/issues/92)). opencodex는 읽을 수 없는 작업을 외부 프로바이더로 전달하지 않습니다. 직접 라우팅은 HTTP 400과 `unreadable_encrypted_agent_task` 코드로 실패하고, 콤보는 복호화할 수 없는 대상은 제외하고 가능하면 정규 네이티브 ChatGPT 대상을 선택합니다. 이종 프로바이더 위임에는 v1을 쓰거나, 네이티브 ChatGPT 자식을 선택하거나, 작업을 평문 v2 `agent_message` 콘텐츠로 다시 볼 수 있습니다.
:::

## 모드

| 모드 | 서피스 | 동작 |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | 네임스페이스 방식의 클래식 에이전트 툴과 `send_input` / `close_agent` / `resume_agent`를 사용합니다. `spawn_agent` 모델 오버라이드로 다른 모델의 서브에이전트를 띄울 수 있습니다. |
| **base** (기본값) | 업스트림 핀 | 업스트림 모델 핀을 복원합니다. gpt-5.6-sol과 gpt-5.6-terra는 v2, gpt-5.6-luna는 v1을 쓰고, 핀이 없는 모델은 Codex `multi_agent_v2` 기능 플래그를 따릅니다. 실제 스폰 동작은 각 모델에 결정된 서피스를 따릅니다. |
| **v2** | `multi_agent_v2` | 플랫 `spawn_agent` 툴과 동시 세션, `send_message` / `followup_task` / `wait_agent` / `interrupt_agent`를 사용합니다. 전체 히스토리 fork에서는 자식이 부모 모델을 상속하고, `fork_turns: "none"`(또는 부분 fork)에서는 `model` / `reasoning_effort` 오버라이드가 적용됩니다. 네이티브→라우팅 자식이 백엔드 암호화된 작업 콘텐츠만 받으면 외부 라우팅은 `unreadable_encrypted_agent_task`를 반환하고, 혼합 콤보는 복호화 가능한 네이티브 대상을 우선합니다([#92](https://github.com/lidge-jun/opencodex/issues/92)). |

### 암호화된 v2 작업 전달

네이티브 ChatGPT 백엔드만 자신의 암호화된 작업 페이로드를 읽을 수 있습니다. 읽을 수 없는 v2 `agent_message`에 대해 opencodex는 프로바이더 디스패치 전에 다음 규칙을 적용합니다.

- 비네이티브 직접 라우팅은 HTTP 400과 `error.code = "unreadable_encrypted_agent_task"`를 반환합니다. 응답에 암호화된 페이로드를 담지 않습니다.
- 콤보는 재시도를 포함해 해당 작업에 정규 네이티브 ChatGPT 대상만 고려합니다. 복호화 가능한 대상이 없으면 외부 프로바이더로 빈 작업을 볼 수 있는 대신 같은 400 응답을 반환합니다.
- 읽을 수 있는 평문 작업은 기존 콤보 순서와 페일오버 동작을 그대로 따릅니다.

복구하려면 자식을 네이티브 ChatGPT 모델로 바꾸거나, 콤보에 네이티브 대상을 추가하거나, 이종 프로바이더 위임에 v1 서피스를 쓰거나, 호출자를 제어할 수 있으면 작업을 평문 v2 `agent_message` 콘텐츠로 다시 볼 수 있습니다.

## 동작 방식

선택한 모드는 Codex가 읽는 모든 카탈로그 항목의 `multi_agent_version` 필드를 설정합니다.

- **v1 모드**: 모든 항목에 `multi_agent_version = "v1"`을 강제해 업스트림 핀을 덮어씁니다.
- **base 모드**: 업스트림 기본값을 복원합니다. 핀이 있는 모델은 스냅샷 값을 쓰고, 핀이 없는 모델은 필드를 제거해 Codex 기능 플래그가 결정하게 합니다.
- **v2 모드**: 모든 항목에 `multi_agent_version = "v2"`를 강제해 업스트림 핀을 덮어씁니다.

이 오버라이드는 라이브 `/v1/models` 카탈로그 응답과 디스크 카탈로그 동기화 양쪽에서 마지막 패스로 실행됩니다. 따라서 항목이 어떤 경로로 만들어졌든 새 세션부터 같은 모드가 적용됩니다.

### 위임 모델과 추론 강도

대시보드의 **서브에이전트 위임** 선택기는 `injectionModel`과 선택 사항인 `injectionEffort`를 저장합니다. 이 값은 위임 가이드를 만드는 설정이지, 프록시가 스폰 요청을 다른 모델로 다시 라우팅하는 설정이 아닙니다. `injectionPrompt`를 지정하면 내장 가이드 문구 전체를 원하는 텍스트로 교체할 수 있습니다.

`multiAgentGuidanceText`는 요청에 들어온 툴 목록으로 서피스를 판별합니다. Codex Desktop의 WebSocket 경로(`responses_lite`)처럼 툴이 요청의 `tools` 배열 대신 `additional_tools` input 항목으로 도착하는 경우도 인식합니다.

**v2** 요청(base 모드의 Sol/Terra, v2 모드에서는 전체 모델)에서는 유효한 주입 모델이 설정되어 있거나 실효 서브에이전트 로스터가 비어 있지 않을 때 700자 이내의 간결한 가이드를 주입합니다. 가이드는 `model` / `reasoning_effort`가 현재 스키마에 노출되는지 단정하지 않고 조걸부로 override를 설명하며, `fork_turns: "none"`(또는 부분 fork) 규칙, 유효한 정규 slug의 선호 모델, Codex의 picker-visible·v2 호환·priority 순 상위 5개에 포함된 설정 모델과 사용 가능한 effort 사다리만 표시합니다.

**v1** 요청에서는 최고 추론 단계(max / ultra)에서 업스트림과 동일한 능동 위임 문구만 미러링합니다. 모델 지정, 로스터, 커스텀 프롬프트는 v1에 추가되지 않습니다.

내장 v2 가이드를 교체하려면 `injectionPrompt`(config 키 또는 `PUT /api/injection-model`의 `prompt` 값)를 설정하세요. `{{model}}`, `{{effort}}`, `{{roster}}` 플레이스홀더가 설정된 주입 모델, 추론 강도, 해석된 로스터로 치환됩니다. 발화 조건은 그대로라서, 커스텀 프롬프트가 원래 침묵할 요청을 발화시키지는 않습니다.

## 모드 변경

### GUI

- **대시보드** → 첫 번째 스탯 셀에서 **v1**, **base**, **v2**를 선택합니다.
- **모델** 페이지 → 상단 세그먼트 컨트롤에서 선택합니다.
- 두 페이지 모두 **?** 버튼을 누르면 이 문서로 연결되는 도움말 모달이 열립니다.
- **대시보드** → **서브에이전트 위임**에서 선호 모델과 선택 사항인 추론 강도를 고릅니다. v2에서는 주입된 가이드가 `fork_turns: "none"` 스폰을 지시해 모델 오버라이드가 적용되게 합니다 — 다만 네이티브→라우팅 자식은 작업 본문이 암호화 상태로 도착할 수 있습니다([#92](https://github.com/lidge-jun/opencodex/issues/92)).

### CLI

```bash
ocx v2 mode v1       # 모든 모델을 v1으로 강제
ocx v2 mode default  # 업스트림 핀 복원
ocx v2 mode v2       # 모든 모델을 v2로 강제
ocx v2 status        # 현재 모드 + Codex 기능 플래그 확인
```

### API

```bash
# 서피스 모드, 기능 플래그, 스레드 제한 조회
curl http://localhost:10100/api/v2

# 서피스 모드 설정
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

`/api/v2` PUT 엔드포인트는 `enabled`(불리언, Codex 기능 플래그)와 `maxConcurrentThreadsPerSession`(정수)도 받습니다. 요청을 검증하고 모드를 저장한 뒤 카탈로그를 다시 동기화하며, 변경 사항은 새 세션부터 적용됩니다.

위임 선택기는 별도 엔드포인트를 사용합니다.

```bash
# 현재 모델/추론 강도와 선택 가능한 값 조회
curl http://localhost:10100/api/injection-model

# 두 값 설정
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "effort": "xhigh"}'

# 커스텀 가이드 프롬프트 설정 ({{model}}/{{effort}}/{{roster}} 플레이스홀더)
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "prompt": "{{model}}에 위임해.{{roster}}"}'

# 두 값 모두 해제
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model`은 `model`, `effort`, `prompt`, 전역 `efforts` 단계, 활성화된 네이티브·라우팅 모델인 `available`을 반환합니다. PUT에서 `effort`나 `prompt`를 생략하면 기존 값을 유지하고, `null`이면 지웁니다. `model`을 지우면 추론 강도도 항상 함께 지워집니다. API는 전역 Codex 단계에 맞는 추론 강도인지 검증하고, Codex는 스폰 시 대상 카탈로그 항목이 그 강도를 지원하는지 다시 검증합니다.

## 추론 강도

서브에이전트 추론 강도는 `injectionEffort`에 저장되며 주입 모델이 있을 때만 의미가 있습니다. 이 값은 주입된 v2 가이드에 `reasoning_effort` 지시를 추가하며, 부모 세션의 추론 강도를 바꾸지는 않습니다. 오버라이드가 허용되는 fork에서는 `spawn_agent`에 전달된 `reasoning_effort`를 Codex가 그대로 적용합니다.

`ultra`는 Codex 카탈로그에서 `max`보다 높은 단계이며 자동 위임 의미가 더해지지만, 프로바이더 와이어에는 `ultra`라는 값이 그대로 전달되지 않습니다. Codex가 클라이언트 경계에서 `ultra`를 `max`로 바꾸고, opencodex가 프로바이더에 맞는 유효한 값으로 조정합니다.

| 모델 | 와이어의 `max` | `ultra` 선택 시 와이어 값 |
| --- | --- | --- |
| gpt-5.5, gpt-5.4, gpt-5.4-mini | xhigh | xhigh (max 변환 후 `nativeEffortClamp`) |
| gpt-5.6-sol, gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | 정확한 업스트림 단계에 노출되지 않음 |
| 라우팅 모델 | 어댑터가 매핑하거나 클램프 | max로 변환한 뒤 어댑터가 매핑하거나 클램프 |

카탈로그에 어떤 추론 강도를 노출할지는 v1/v2 모드와 무관합니다. 추론 가능한 생성 항목에는 직접 지정한 서브에이전트 강도가 검증을 통과하도록 `max`가 들어가며, 현재 생성되는 라우팅 항목에는 `ultra`도 들어갑니다. 다만 정확한 업스트림 모델 단계는 그대로 보존하므로 gpt-5.6-luna는 `max`에서 끝납니다.

## 컨텍스트 상한

전역 컨텍스트 상한 값의 기본값은 350k입니다. 상한을 켠 라우팅 프로바이더의 `context_window`만 제한하며, 네이티브 OpenAI 모델은 실제 컨텍스트 윈도우를 그대로 사용합니다.

모델 페이지에서 값이나 전체 프로바이더 설정을 바꾸거나, 각 프로바이더 그룹 헤더 옆에서 상한을 개별적으로 켜고 끌 수 있습니다.
