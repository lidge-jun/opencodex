---
title: 설정 레퍼런스
description: ~/.opencodex/config.json의 모든 필드 — 최상위 옵션, 프로바이더, 사이드카.
---

opencodex는 `~/.opencodex/config.json`으로 설정됩니다. 이 파일은 `ocx init`과 대시보드가
작성하지만, 직접 편집할 수도 있습니다. 프록시는 시작 시 이 파일을 다시 읽습니다. 파일을 파싱할 수
없는 경우(잘못된 JSON 등) opencodex는 `config.json.invalid-<timestamp>`로 백업하고 콘솔에 경고를
출력한 뒤 기본값으로 시작합니다. 파일이 아예 없으면 기본값(단일 `openai` 포워드 프로바이더)으로
폴백합니다.

## 최상위 (`OcxConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 프록시가 수신 대기하는 포트. |
| `hostname?` | `string` | `"127.0.0.1"` | 바인드 주소. LAN에 노출하려면 `"0.0.0.0"` 설정 (`OPENCODEX_API_AUTH_TOKEN` 필수; 아래 [원격 접근](#원격-접근) 참조). |
| `providers` | `Record<string, OcxProviderConfig>` | — | 프로바이더 이름 → 설정 맵. |
| `defaultProvider` | `string` | `"openai"` | 라우팅에서 더 나은 매치를 찾지 못했을 때 사용하는 프로바이더. |
| `subagentModels?` | `string[]` | — | Codex의 서브에이전트 선택기에서 가장 먼저 노출되는 최대 5개의 `provider/model` id. |
| `disabledModels?` | `string[]` | — | Codex에서 숨기는 모델. 라우팅된 `provider/model` id는 카탈로그와 `/v1/models`에서 제외되고, bare 네이티브 GPT slug(예: `gpt-5.4`)는 카탈로그 항목이 `visibility: "hide"`로 바뀌며 bare `/v1/models` 목록에서 빠집니다. 대시보드 Models 페이지에서 모델별로 토글할 수 있습니다. |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | 3단계 multi-agent surface override. `"v1"`은 모든 모델을 v1 surface로 강제합니다(업스트림 pin보다 우선). `"default"`는 업스트림 model pin을 따릅니다(sol/terra=v2, luna=v1). `"v2"`는 모든 모델을 v2로 강제합니다. 대시보드 Models 페이지 또는 `ocx v2 mode`에서 설정할 수 있습니다. |
| `websockets?` | `boolean` | `false` | Codex가 Responses WebSocket 경로를 사용하도록 `supports_websockets`를 광고합니다. 생략하거나 `false`로 두면 HTTP/SSE를 유지합니다. |
| `syncResumeHistory?` | `boolean` | `true` | Codex App 히스토리 호환 모드. opencodex가 원래 Codex thread metadata를 백업하고, 기존 OpenAI interactive row를 `opencodex`로 remap하며, opencodex가 만든 `exec` row를 App에 보이는 source로 임시 승격합니다. `ocx stop` / `ocx restore`는 백업된 OpenAI row를 복원하고, 남은 opencodex user thread는 OpenAI로 eject합니다. `false`로 설정하면 히스토리 remap을 끕니다. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Codex Auth 대시보드가 관리하는 ChatGPT/Codex pool 계정 metadata. 시크릿은 별도의 `codex-accounts.json`에 저장됩니다. |
| `activeCodexAccountId?` | `string` | — | 다음 새 Codex thread에 사용할 pool 계정. 기존 thread affinity는 처음 선택된 계정을 유지합니다. |
| `autoSwitchThreshold?` | `number` | `80` | 새 세션 자동 전환에 사용할 사용률 임계값. 점수는 알려진 5시간, 주간, 30일 할당량 중 가장 높은 사용률을 사용합니다. `0`으로 설정하면 할당량 기반 auto-switch를 끕니다. |
| `upstreamFailoverThreshold?` | `number` | `3` | 일시적 업스트림 실패가 연속으로 몇 번 발생하면 이후 새 세션을 다른 정상 pool 계정으로 failover할지 정합니다. `0`으로 설정하면 실패 기반 failover를 끕니다. |
| `modelCacheTtlMs?` | `number` | `300000` | 프로바이더별 `/models` 캐시의 유효 기간 (5분). |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on | 웹 검색 사이드카 옵션 (아래 참조). |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on | 비전 사이드카 옵션 (아래 참조). |

백업 지원 이전의 개발 빌드에서 이미 `syncResumeHistory`를 실행했다면,
`ocx recover-history --legacy-openai`로 같은 native-provider 복구를 명시 실행할 수도 있습니다.

:::note[Codex 계정 풀]
pool 계정 추가와 할당량 재조회는 대시보드의 **Codex Auth** 페이지에서 처리하세요. config에는
시크릿이 아닌 계정 metadata만 저장되고, access/refresh token은 강화된 Codex account credential
store에 따로 저장됩니다. 기존 thread id는 계정 affinity를 유지하고, 새 세션은 할당량, cooldown,
health를 기준으로 자동 라우팅할 수 있습니다.
:::

## 원격 접근

기본적으로 opencodex는 `127.0.0.1`(루프백 전용)에 바인딩됩니다. `hostname`을 `0.0.0.0` 같은
비루프백 주소로 설정하면, opencodex는 관리 API(`/api/*`)와 데이터 플레인(`/v1/responses`) **모두**에
토큰 인증을 강제합니다.

시작 전에 `OPENCODEX_API_AUTH_TOKEN` 환경 변수를 설정하세요:

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

비루프백 바인딩 시 이 변수가 없으면 프록시 시작이 거부됩니다. LAN 접근용 백그라운드 서비스를
설치할 때도 같은 변수를 먼저 export한 뒤 `ocx service install`을 실행해야 launchd, systemd,
Task Scheduler에 토큰이 전달됩니다. 클라이언트는 모든 요청에 `x-opencodex-api-key` 헤더로
토큰을 포함해야 합니다:

```
x-opencodex-api-key: your-secret-token
```

토큰은 타이밍 사이드 채널 방지를 위해 상수 시간(`timingSafeEqual`)으로 비교됩니다.

:::caution[LAN 노출]
`0.0.0.0`으로 바인딩하면 프록시와 설정된 모든 프로바이더 인증 정보가 로컬 네트워크에 노출됩니다.
신뢰할 수 있는 네트워크에서만 사용하고, 항상 강력한 `OPENCODEX_API_AUTH_TOKEN`을 설정하세요.
:::

## 프로바이더 (`OcxProviderConfig`)

| Field | Type | Meaning |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`, `openai-responses`, `anthropic`, `google`, `azure-openai` 중 하나. |
| `baseUrl` | `string` | 업스트림 API 기본 URL. |
| `apiKey?` | `string` | API 키, 또는 요청 시점에 해석되는 `${ENV_VAR}` / `$ENV_VAR` 참조. |
| `defaultModel?` | `string` | 명시적인 모델 없이 이 프로바이더가 선택되었을 때 사용하는 모델. |
| `models?` | `string[]` | 시드/폴백 모델 목록. `liveModels`가 `false`이면 Codex 카탈로그에 노출할 정확한 allowlist가 됩니다. |
| `liveModels?` | `boolean` | 시작/동기화 시 프로바이더의 실시간 `/models` 카탈로그를 가져옵니다(기본 `true`). `false`로 두면 설정된 `models`만 사용합니다. |
| `contextWindow?` | `number` | routed catalog entry에 표시할 프로바이더 전체 context-window cap. 실시간 metadata가 이보다 작으면 그대로 둡니다. |
| `modelContextWindows?` | `Record<string,number>` | 모델별 context-window cap. 매칭되는 모델에서는 `contextWindow`보다 우선하며, 더 작은 실시간 metadata를 올리지 않습니다. |
| `modelInputModalities?` | `Record<string,string[]>` | `["text"]` 또는 `["text", "image"]` 같은 모델별 catalog input hint. |
| `reasoningEfforts?` | `string[]` | 프로바이더 전체에 광고할 Codex reasoning tier (`low`, `medium`, `high`, `xhigh`, `max`). |
| `modelReasoningEfforts?` | `Record<string,string[]>` | 모델별 reasoning tier override. 빈 배열은 해당 모델의 effort control을 숨깁니다. |
| `reasoningEffortMap?` | `Record<string,string>` | Codex tier를 업스트림 wire 값으로 바꾸는 프로바이더 단위 alias map. `xhigh`와 `max`는 기본적으로 서로 다른 tier입니다. |
| `modelReasoningEffortMap?` | `Record<string,Record<string,string>>` | 모델별 reasoning alias map. |
| `headers?` | `Record<string,string>` | 업스트림으로 전송되는 추가 HTTP 헤더. |
| `authMode?` | `"key" \| "forward" \| "oauth"` | 인증 방식 (기본 `key`). [프로바이더](/opencodex/ko/guides/providers/#auth-modes) 참조. |
| `noReasoningModels?` | `string[]` | reasoning/thinking 파라미터를 거부하는 모델 — 어댑터가 이들에 대해 `reasoning_effort`를 제거함. |
| `noVisionModels?` | `string[]` | 텍스트 전용 모델 — [비전 사이드카](/opencodex/ko/guides/sidecars/)가 이들을 위해 이미지를 설명함. 매칭 시 Ollama의 `:size` 태그를 허용함. |
| `escapeBuiltinToolNames?` | `boolean` | Umans 같은 Anthropic 호환 게이트웨이가 wire에서 도구명 escape를 요구할 때 사용합니다. opencodex는 Codex에 tool call을 돌려주기 전에 prefix를 제거합니다. |

## 정적 모델 allowlist

일부 프로바이더는 실시간 모델 카탈로그가 매우 크거나 느릴 수 있습니다. Codex에 `models`에
고정한 모델만 노출하려면 `liveModels`를 `false`로 설정하세요.

`liveModels`가 `false`인데 `models`가 비어 있거나 생략되면, opencodex는 해당 프로바이더의
routed model을 노출하지 않습니다.

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

## GPT-5.6 seed/fallback 모델

내장 **OpenAI (API key)** 프로바이더는 OpenAI Responses API(`https://api.openai.com/v1`)를 사용하며
fallback 모델 목록에 `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`를 포함합니다.
OpenRouter는 같은 preview 모델을 `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`,
`openai/gpt-5.6-luna` 이름으로 seed합니다. GPT-5.6 세 모델의 `modelContextWindows` 값은
`372000`이며, `max` reasoning tier는 `xhigh`와 별개로 유지됩니다.

이 값들은 rollout 준비용 metadata입니다. 실제 호출은 연결된 OpenAI API 키, OpenRouter 계정, 또는
native ChatGPT/Codex 계정에 GPT-5.6 preview 권한이 있을 때만 성공합니다.

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
