---
title: Codex App 모델 선택기
description: 공유 Codex 카탈로그를 통해 opencodex 모델이 Codex App, Codex CLI, Codex TUI에 표시되는 방식.
---

opencodex는 Codex App을 패치하지 않습니다. Codex CLI/TUI가 이미 읽는 Codex 설정과 모델
카탈로그를 같은 위치에 작성합니다. Codex App이 이 공유 상태를 읽기 때문에 라우팅된 모델이 일반
Codex 카탈로그 항목처럼 App의 모델 선택기에 표시될 수 있습니다.

## 통합 경로

`ocx init`, `ocx start`, `ocx sync`는 해석된 `CODEX_HOME` 디렉터리 아래의 다음 파일을 맞춥니다:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

활성 프로바이더는 루트 설정 키로 설치됩니다:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
```

프로바이더 자체는 Responses 호환 엔드포인트로 등록됩니다:

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

`websockets`는 기본적으로 꺼져 있습니다. `"websockets": true`일 때만 opencodex가
`supports_websockets = true`를 provider 테이블과 카탈로그 항목에 광고합니다.

## 라우팅 모델이 표시되는 이유

Codex 모델 선택기는 Codex 형태의 카탈로그 항목을 기대합니다. opencodex는 네이티브 Codex 모델
템플릿을 복제한 뒤 라우팅 모델 정체성만 바꿔 해당 항목을 만듭니다:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

복제된 항목은 reasoning 레벨, shell 타입, API 지원 플래그, base instructions 같은 엄격한 파서
필드를 유지합니다. 그래서 각 라우팅 항목은 선택기에 표시 가능한 유효한 Codex 모델처럼 보입니다.

## GPT-5.6 rollout metadata

GPT-5.6 Sol, Terra, Luna는 preview-gated rollout으로 처리됩니다. opencodex는 설치된 Codex 카탈로그가
아직 뒤처져 있어도 documented native additions로 `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`를
추가할 수 있습니다. 이 항목들은 `context_window`와 `max_context_window`를 372,000 usable tokens로
고정하고, `auto_compact_token_limit`은 그 90%로 계산합니다.

이 세 native 항목과 OpenAI API key/OpenRouter routed fallback 항목은 `max` reasoning을 별도 tier로
노출합니다. 이름이 선택기에 보인다는 뜻은 opencodex가 카탈로그를 준비했다는 의미이며, 실제 요청 성공은
연결된 계정 또는 프로바이더의 preview 권한에 달려 있습니다.

## Multi-agent surface mode

opencodex는 모든 카탈로그 항목의 `multi_agent_version` 필드를 제어하는 3단계 multi-agent surface
override를 추가합니다:

| Mode | Effect |
| --- | --- |
| **All v1** | 모든 모델을 v1 multi-agent surface로 강제합니다. 업스트림 pin(sol/terra 포함)보다 우선합니다. |
| **Default** (설치 기본값) | 업스트림 model pin을 따릅니다. sol/terra는 v2, luna는 v1을 사용하고, 나머지는 codex의 `multi_agent_v2` 기능 플래그를 따릅니다. |
| **All v2** | 모든 모델을 v2 multi-agent surface로 강제합니다. 업스트림 pin(luna 포함)보다 우선합니다. |

대시보드 Models 페이지의 segmented control, `ocx v2 mode v1|default|v2`, 또는
`PUT /api/v2`와 `{ "multiAgentMode": "v1" }`로 설정할 수 있습니다. 변경 사항은 새 Codex 세션에
적용됩니다.

## Ultra reasoning

Ultra는 `multi_agent_v2` 토글 상태와 관계없이 항상 카탈로그에 광고됩니다. v2 토글은 ultra 표시 여부가
아니라 multi-agent collab surface만 제어합니다. wire에서는 opencodex가 `nativeEffortClamp`로 ultra를
각 모델의 실제 최상위 단계에 맞춥니다(예: gpt-5.5 ultra는 xhigh).

## 서브에이전트 선택

Codex의 `spawn_agent`는 카탈로그에서 우선순위가 높은 처음 5개 모델만 노출합니다. `subagentModels`
또는 웹 대시보드에서 최대 5개의 `provider/model` 또는 네이티브 모델 id를 고르면 opencodex가 해당
항목을 카탈로그 앞쪽에 정렬합니다.

## 모델 상태 새로고침

선택기에 오래된 항목이 남아 있으면 카탈로그를 새로 쓰고 대상 Codex 표면을 다시 여세요:

```bash
ocx sync
```

opencodex는 라우팅 모델의 표시 여부나 카탈로그 메타데이터를 바꿀 때 Codex의 `models_cache.json`도
무효화합니다.
