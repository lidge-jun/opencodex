---
title: Codex App 모델 선택기
description: 공유 Codex 카탈로그를 통해 opencodex 모델이 Codex App, Codex CLI, Codex TUI에 표시되는 방식.
---

opencodex는 Codex App을 패치하지 않습니다. Codex CLI/TUI가 이미 쓰는 설정과 모델 카탈로그를
같은 위치에 기록합니다. Codex App도 이 상태를 공유하므로 라우팅 모델이 일반 Codex 카탈로그
항목처럼 App의 모델 선택기에 나타날 수 있습니다.

OpenAI id는 두 가지로 고정됩니다. bare native id는 `codexAccountMode`로 Pool(기본)/Direct를
선택하는 단일 `openai` 그룹이고, `openai-apikey/<model>`은 API key입니다. 모드를 바꿔도 모델
id는 변하지 않습니다. API GPT-5.6은 context 1,050,000 / max input 922,000이고,
`*-pro` picker id는 공개 상태를 유지하면서 wire에서 base 모델 + `reasoning.mode: "pro"`가 됩니다.

## 통합 경로

`ocx init`, `ocx start`, `ocx sync`는 해석된 `CODEX_HOME` 아래의 파일을 맞춥니다.

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

기본 루프백 바인드에서는 Codex의 내장 `openai` 프로바이더 id를 그대로 둡니다. 대신 다음 루트
키로 프로바이더와 모델 카탈로그를 opencodex에 연결합니다.

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

루프백이 아닌 hostname을 쓰면 Codex가 생성된 API 인증 헤더도 보내야 합니다. 이때는 루트의
`model_provider = "opencodex"`와 Responses 호환 전용 프로바이더를 사용합니다.

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
```

`websockets`는 기본적으로 꺼져 있습니다. 전용 프로바이더와 카탈로그 항목은
`"websockets": true`일 때만 `supports_websockets = true`를 광고합니다. 루프백에서는 Codex의
내장 프로바이더가 WebSocket을 먼저 시도할 수 있으며, 기능이 꺼진 프록시는 `426`을 반환해
HTTP/SSE로 폴백시킵니다. 주입과 복원 전체 흐름은
[Codex 통합](/opencodex/ko/guides/codex-integration/)을 참고하세요.

## 라우팅 모델이 표시되는 이유

Codex 모델 선택기는 Codex 형식의 카탈로그 항목을 요구합니다. opencodex는 네이티브 Codex 모델
템플릿을 복제한 뒤 라우팅 모델의 식별 정보를 바꿉니다.

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

복제본에는 reasoning 단계, shell 타입, API 지원 플래그, base instructions처럼 엄격한 파서가
요구하는 필드가 남습니다. 그다음 OpenAI service tier 메타데이터처럼 해당 라우트가 처리할 수 없는
네이티브 전용 기능은 제거합니다.

## v2.7.1 모델 범위

네이티브 폴백 목록에는 `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark`, GPT-5.6 Sol/Terra/Luna가 들어 있습니다. GPT-5.5/5.4 계열은 설치된
Codex 카탈로그의 더 풍부한 실시간 항목을 보존하고, 빠진 항목만 합성합니다. 번들 업스트림
스냅샷은 GPT-5.6에만 사용합니다. 오래된 템플릿으로 근사하지 않고 모델별 실제 식별 정보와
메타데이터를 적용하기 위해서입니다.

| 라우트 | 선택기 id와 카탈로그 메타데이터 |
| --- | --- |
| Codex 로그인(Pool 또는 Direct) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`(372,000 토큰) |
| OpenAI(API key) | `openai-apikey/gpt-5.6-*`와 `openai-apikey/gpt-5.6-*-pro`(1,050,000; max input 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna`(1,050,000) |
| Cursor | 정적 폴백에 `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna`(1,000,000)와 `cursor/grok-4.5`, `cursor/grok-4.5-fast`(500,000)가 들어갑니다. 실제 표시 목록은 계정별 실시간 탐색 결과로 거릅니다. |
| xAI | 실시간 탐색 결과가 우선입니다. 폴백 카탈로그의 기본값은 컨텍스트 500,000과 `low` / `medium` / `high` reasoning을 갖는 `xai/grok-4.5`입니다. |

고정된 GPT-5.6 항목은 업스트림 reasoning 단계를 그대로 보존합니다. Sol과 Terra는 `low`부터
`ultra`까지, Luna는 `max`까지 노출합니다. 기본값은 Sol이 `low`, Terra와 Luna가 `medium`입니다.
`ultra`는 최대 reasoning과 선제적 위임을 묶은 클라이언트 선택지이며 백엔드에는 `max`로
전달됩니다. 모델이 선택기에 보이더라도 연결된 계정이나 API key에 실제 사용 권한이 있어야 합니다.

## 네이티브 및 라우팅 모델 토글

대시보드 Models 페이지는 두 모델 계열 모두 `disabledModels`로 관리합니다.

- 라우팅 id는 `provider/model` 형식입니다. 끄면 동기화 카탈로그와 `/v1/models`에서 제외됩니다.
- 네이티브 GPT id는 `/`가 없는 slug입니다. 끄더라도 항목은 남겨 두고 `visibility`만 `hide`로
  바꿉니다. 나중에 켰을 때 원래 항목을 그대로 복원하기 위해서입니다. 비활성 상태에서는 OpenAI
  목록 형식에서도 빠집니다.
- 네이티브 행은 지원되는 정적 목록에서 가져오므로, 모델을 끈 뒤에도 대시보드에서 다시 켤 수
  있습니다.

표시 여부 처리는 스냅샷 업그레이드보다 뒤에 실행됩니다. 관리 API는 토글 뒤 카탈로그를 다시
쓰고 Codex 모델 캐시를 강제로 오래된 상태로 만듭니다.

## Multi-agent surface 모드

opencodex는 모든 카탈로그 항목의 `multi_agent_version`을 제어하는 3단계 override를 제공합니다.

| 모드 | 동작 |
| --- | --- |
| **v1** | 업스트림 pin보다 우선해 모든 모델을 v1 multi-agent surface로 강제합니다(Sol/Terra 포함). |
| **base**(설치 기본값) | 업스트림 pin을 복원합니다. Sol/Terra는 v2, Luna는 v1을 쓰며, pin이 없는 모델은 Codex `multi_agent_v2` 기능 플래그를 따릅니다. |
| **v2** | 업스트림 pin보다 우선해 모든 모델을 v2 multi-agent surface로 강제합니다(Luna 포함). |

Dashboard나 Models 페이지, `ocx v2 mode v1|default|v2`, 또는
`PUT /api/v2`와 `{ "multiAgentMode": "v1" }`로 설정할 수 있습니다. 변경 사항은 새 Codex
세션부터 적용됩니다.

:::caution
v2(`multi_agent_v2`) 서피스에서 생성된 서브에이전트는 부모 세션의 모델을 상속합니다. 대시보드의
위임 모델/강도 선택기는 v1 프롬프트 안내이며, 프록시가 스폰마다 다른 모델로 라우팅하는 기능이
아닙니다. 정확한 동작은 [서브에이전트 서피스](/opencodex/ko/guides/sub-agent-surface/)를
참고하세요.
:::

## 최상위 reasoning 단계

카탈로그에 어떤 reasoning 단계를 표시할지는 v1/base/v2 서피스 모드와 무관합니다. 생성되는
reasoning 지원 항목에는 서브에이전트가 직접 지정한 강도를 검증할 수 있도록 `max`가 들어갑니다.
현재 생성되는 라우팅 항목과 이전 세대 네이티브 GPT 항목에는 `ultra`도 들어갑니다. 다만 GPT-5.6의
정확한 업스트림 단계는 그대로 유지하므로 Luna는 `max`에서 끝납니다.

실제 요청에서는 라우팅 어댑터가 지원하지 않는 단계를 매핑하거나 제한합니다. 실제 최상위 단계가
`xhigh`인 이전 네이티브 모델은 `nativeEffortClamp`가 직접 지정한 `max` 또는 `ultra` 선택을
`xhigh`로 바꿉니다(예: GPT-5.5). Sol, Terra, Luna에는 실제 `max` 단계가 있습니다.

## Fast tier 규칙

Codex 설정 파일은 fast 모드를 다음처럼 저장합니다.

```toml
service_tier = "fast"

[features]
fast_mode = true
```

반면 모델 카탈로그와 런타임 요청의 tier id는 `priority`입니다. opencodex는 이 차이를 유지합니다.
네이티브 OpenAI 패스스루 모델은 fast 지원을 보존하고, 라우팅된 비 OpenAI 모델에서는 service-tier
메타데이터를 지워 처리할 수 없는 fast 옵션이 표시되지 않게 합니다.

## 서브에이전트 선택

Codex는 선택기에 표시되는 카탈로그 항목을 `priority` 오름차순으로 정렬한 뒤 처음 5개를
`spawn_agent` 모델 override로 노출합니다. `subagentModels`나 대시보드 Subagents 페이지에서
네이티브 id 또는 `provider/model` id를 최대 5개 고르면 opencodex가 선택 순서대로 priority 0-4를
부여합니다. 나머지 모델도 정확한 id로 직접 호출할 수 있습니다.

featured 모델 목록은 Dashboard의 **Sub-agent delegation** 안내와 별개입니다. 특히 featured 모델
override로 v2의 부모 모델 상속 규칙을 우회할 수 없습니다.

## 모델 상태 새로고침

선택기에 오래된 항목이 남아 있으면 카탈로그를 새로 쓰고 대상 Codex 화면을 다시 여세요.

```bash
ocx sync
```

opencodex는 카탈로그의 표시 여부, priority, 메타데이터가 바뀔 때마다 `models_cache.json`을 의도적으로
오래된 캐시 wrapper로 다시 씁니다. 다음 Codex 모델 새로고침이 새 카탈로그를 읽도록 하기 위해서입니다.
