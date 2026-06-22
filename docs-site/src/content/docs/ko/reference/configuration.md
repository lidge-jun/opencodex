---
title: 설정 레퍼런스
description: ~/.opencodex/config.json의 모든 필드 — 최상위 옵션, 프로바이더, 사이드카.
---

opencodex는 `~/.opencodex/config.json`으로 설정됩니다. 이 파일은 `ocx init`과 대시보드가
작성하지만, 직접 편집할 수도 있습니다. 프록시는 시작 시 이 파일을 다시 읽습니다. 파일이 없거나
유효하지 않으면 기본값(단일 `openai` 포워드 프로바이더)으로 폴백합니다.

## 최상위 (`OcxConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 프록시가 수신 대기하는 포트. |
| `providers` | `Record<string, OcxProviderConfig>` | — | 프로바이더 이름 → 설정 맵. |
| `defaultProvider` | `string` | `"openai"` | 라우팅에서 더 나은 매치를 찾지 못했을 때 사용하는 프로바이더. |
| `subagentModels?` | `string[]` | — | Codex의 서브에이전트 선택기에서 가장 먼저 노출되는 최대 5개의 `provider/model` id. |
| `disabledModels?` | `string[]` | — | Codex에서 숨겨지는 라우팅된 `provider/model` id (카탈로그와 `/v1/models`에서 제외됨). |
| `websockets?` | `boolean` | `false` | Codex가 Responses WebSocket 경로를 사용하도록 `supports_websockets`를 광고합니다. 생략하거나 `false`로 두면 HTTP/SSE를 유지합니다. |
| `syncResumeHistory?` | `boolean` | `false` | Codex App 히스토리 호환 모드. 켜면 opencodex가 원래 Codex thread metadata를 백업하고, 기존 OpenAI interactive row를 `opencodex`로 remap하며, opencodex가 만든 `exec` row를 App에 보이는 source로 임시 승격합니다. `ocx stop` / `ocx restore`는 백업된 OpenAI row를 복원하고, 남은 opencodex user thread는 OpenAI로 eject해서 `config.toml`에서 프록시 provider가 제거된 뒤에도 native Codex가 resume할 수 있게 합니다. |
| `modelCacheTtlMs?` | `number` | `300000` | 프로바이더별 `/models` 캐시의 유효 기간 (5분). |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on | 웹 검색 사이드카 옵션 (아래 참조). |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on | 비전 사이드카 옵션 (아래 참조). |

백업 지원 이전의 개발 빌드에서 이미 `syncResumeHistory`를 실행했다면,
`ocx recover-history --legacy-openai`로 같은 native-provider 복구를 명시 실행할 수도 있습니다.

## 프로바이더 (`OcxProviderConfig`)

| Field | Type | Meaning |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`, `openai-responses`, `anthropic`, `google`, `azure` 중 하나. |
| `baseUrl` | `string` | 업스트림 API 기본 URL. |
| `apiKey?` | `string` | API 키, 또는 요청 시점에 해석되는 `${ENV_VAR}` / `$ENV_VAR` 참조. |
| `defaultModel?` | `string` | 명시적인 모델 없이 이 프로바이더가 선택되었을 때 사용하는 모델. |
| `models?` | `string[]` | 시드/폴백 모델 목록. `liveModels`가 `false`이면 Codex 카탈로그에 노출할 정확한 allowlist가 됩니다. |
| `liveModels?` | `boolean` | 시작/동기화 시 프로바이더의 실시간 `/models` 카탈로그를 가져옵니다(기본 `true`). `false`로 두면 설정된 `models`만 사용합니다. |
| `contextWindow?` | `number` | routed catalog entry에 표시할 프로바이더 전체 context-window cap. 실시간 metadata가 이보다 작으면 그대로 둡니다. |
| `modelContextWindows?` | `Record<string,number>` | 모델별 context-window cap. 매칭되는 모델에서는 `contextWindow`보다 우선하며, 더 작은 실시간 metadata를 올리지 않습니다. |
| `modelInputModalities?` | `Record<string,string[]>` | `["text"]` 또는 `["text", "image"]` 같은 모델별 catalog input hint. |
| `headers?` | `Record<string,string>` | 업스트림으로 전송되는 추가 HTTP 헤더. |
| `authMode?` | `"key" \| "forward" \| "oauth"` | 인증 방식 (기본 `key`). [프로바이더](/opencodex/ko/guides/providers/#auth-modes) 참조. |
| `noReasoningModels?` | `string[]` | reasoning/thinking 파라미터를 거부하는 모델 — 어댑터가 이들에 대해 `reasoning_effort`를 제거함. |
| `noVisionModels?` | `string[]` | 텍스트 전용 모델 — [비전 사이드카](/opencodex/ko/guides/sidecars/)가 이들을 위해 이미지를 설명함. 매칭 시 Ollama의 `:size` 태그를 허용함. |
| `escapeBuiltinToolNames?` | `boolean` | Umans 같은 Anthropic 호환 게이트웨이가 wire에서 도구명 escape를 요구할 때 사용합니다. opencodex는 Codex에 tool call을 돌려주기 전에 prefix를 제거합니다. |

## 정적 모델 allowlist

일부 프로바이더는 실시간 모델 카탈로그가 매우 크거나 느릴 수 있습니다. Codex에 `models`에
고정한 모델만 노출하려면 `liveModels`를 `false`로 설정하세요.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## 사이드카

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 포워드 프로바이더 + 로그인이 존재할 때 on | 메인 스위치. |
| `model?` | `string` | `gpt-5.4-mini` | 실제 `web_search`를 실행하는 사이드카 모델 (네이티브 ChatGPT 모델이어야 함). |
| `reasoning?` | `string` | `low` | 사이드카의 reasoning effort (`minimal`은 웹 검색과 함께 거부됨). |
| `maxSearchesPerTurn?` | `number` | `3` | 메인 모델 턴당 실제 검색의 총 횟수 (루프 가드). |
| `timeoutMs?` | `number` | `30000` | 사이드카 fetch 타임아웃. |

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 포워드 프로바이더 + 로그인이 존재할 때 on | 메인 스위치. |
| `model?` | `string` | `gpt-5.4-mini` | 이미지를 설명하는 비전 모델 (이미지 입력을 받아들여야 함). |
| `timeoutMs?` | `number` | `45000` | 사이드카 fetch 타임아웃. |

## 전체 예시

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-4-8", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": { "maxSearchesPerTurn": 3 },
  "visionSidecar": { "enabled": true }
}
```

:::tip[시크릿]
키에는 `${ENV_VAR}` 참조를 사용하여 `config.json`에 시크릿이 남지 않도록 하세요. OAuth와 포워드
프로바이더는 키를 전혀 저장하지 않습니다.
:::

:::note[원자적 쓰기]
모든 설정 및 카탈로그 파일(`config.toml`, `opencodex-catalog.json`)은 `atomicWriteFile`(임시 파일 +
이름 바꾸기)을 통해 원자적으로 기록됩니다. 이는 동시 작성자 — 예를 들어 `ocx stop`과 프록시의
자체 종료 핸들러 — 가 동시에 Codex를 복원할 때 반쯤 기록된 파일이 생기는 것을 방지합니다.
:::
