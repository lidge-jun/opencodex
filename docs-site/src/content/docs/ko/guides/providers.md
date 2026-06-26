---
title: 프로바이더
description: opencodex가 LLM 프로바이더를 인증하고 통신하는 모든 방식 — OAuth, API 키, ChatGPT 포워드, 그리고 로컬.
---

**프로바이더**는 하나의 업스트림 LLM 엔드포인트와 거기에 도달하는 방법을 합친 것입니다: 어댑터, 베이스 URL, 인증
모드, 그리고 선택적인 모델 목록으로 구성됩니다. 프로바이더는 `~/.opencodex/config.json`의 `providers` 아래에 위치합니다.

## 인증 모드

모든 프로바이더에는 `authMode`가 있습니다(기본값 `key`):

| `authMode` | 인증 방식 | 사용처 |
| --- | --- | --- |
| `key` | API 키를 전송합니다(`Authorization: Bearer …`, 또는 어댑터에 따라 `x-api-key` / `api-key`). 키는 리터럴이거나 `${ENV_VAR}` 참조일 수 있습니다. | 대부분의 프로바이더. |
| `forward` | **수신된 Codex 인증 헤더를** 프로바이더에 그대로 중계합니다 — 키를 저장하지 않습니다. ChatGPT 로그인 패스스루입니다. | OpenAI (`openai-responses` 어댑터). |
| `oauth` | 저장된 OAuth 액세스 토큰을 해석하고(만료 전 자동 갱신) 이를 bearer 키로 사용합니다. | xAI, Anthropic, Kimi. |

## 1. ChatGPT 로그인 (forward / 패스스루)

기본 프로바이더는 **API 키가 필요 없습니다**. 기존 `codex login`의 자격 증명을 OpenAI Responses 백엔드로
그대로 포워딩합니다:

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

엄선된 헤더 집합만 포워딩됩니다(`FORWARD_HEADERS`: authorization, ChatGPT account id,
OpenAI beta/originator/session — [어댑터](/opencodex/ko/reference/adapters/) 참고). 이 경로는
[웹 검색 및 비전 사이드카](/opencodex/ko/guides/sidecars/)를 구동하는 경로이기도 합니다.

## 2. 계정 로그인 (OAuth)

세 개의 프로바이더가 실제 계정 로그인을 지원합니다. opencodex는 자격 증명을 `~/.opencodex/auth.json`에 저장하고
자동으로 갱신합니다:

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx logout <provider>
```

| 프로바이더 | 어댑터 | 베이스 URL | 비고 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | Grok 모델; 일부는 reasoning 파라미터가 없습니다(자동 처리됨). |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 모델; 실시간 모델 목록은 `/v1/models`에서 가져옵니다. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2 제품군. |

[웹 대시보드](/opencodex/ko/guides/web-dashboard/)에서도 OAuth를 시작할 수 있습니다.

## 3. API 키 카탈로그

opencodex는 키 기반 프로바이더 카탈로그를 제공합니다(대부분 OpenAI 호환이며, 일부는
Anthropic 호환입니다). 대시보드의 **Add provider** 선택기는 해당 프로바이더의 키 대시보드를 열고,
키를 검증한 뒤 저장합니다. 주요 항목은 다음과 같습니다:

| 프로바이더 | 베이스 URL |
| --- | --- |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Qwen Portal | `https://portal.qwen.ai/v1` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitHub Copilot · GitLab Duo | `https://api.githubcopilot.com` · `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic` |
| …그 외 다수 | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

대부분은 bearer 키와 함께 `openai-chat` 어댑터를 사용하며, Anthropic 호환 엔드포인트만 노출하는 일부
(예: **Xiaomi MiMo**)는 `anthropic` 어댑터(`x-api-key`)를 사용합니다.

:::note[게이트웨이 및 구독 프록시]
프로바이더는 opencodex가 프록시할 수 있는 표준 streaming API를 사용하는 경우 포함됩니다
(`openai-completions`, `anthropic-messages`, `openai-responses`, Azure, 또는 Gemini) — "에이전트"
제품인지 여부는 **기준이 아닙니다**. opencodex 어댑터가 없는 독자 프로토콜의 프로바이더는
제외됩니다: Gemini CLI / Antigravity, Vertex AI, Amazon Bedrock, 그리고 Codex 백엔드 자체.
**GitHub Copilot**과 **GitLab Duo**는 자신의 범용 OpenAI 호환 엔드포인트에 매핑된 멀티 모델
게이트웨이입니다. 이들은 Bearer **구독 토큰**(일반 API 키가 아님)으로 인증하며,
Copilot은 프로바이더의 `headers`를 통해 `User-Agent` 헤더 설정이 필요할 수 있습니다. **Cloudflare AI
Gateway**는 URL에 계정 + 게이트웨이 id를 채워야 합니다.

Cursor는 별도의 실험적 어댑터 scaffold로 추적합니다. source에는 `adapter: "cursor"`가 있지만,
live OAuth, live 모델 discovery, HTTP/2 transport, native tool 실행은 bridge 감사가 끝날 때까지
비활성화되어 있습니다. Cursor는 `ocx init`과 dashboard Add Provider picker에 실험적 local config
항목으로 표시되며, static `cursor/auto` catalog metadata를 저장합니다. key-login 또는 OAuth login
목록에는 표시되지 않습니다. Cursor config는 live transport가 별도 감사 단계에서 명시적으로 열릴 때까지
disabled-transport error로 fail-closed 처리됩니다.
:::

### Ollama Cloud

Ollama Cloud는 호스팅형(로컬이 아님) Ollama로, `https://ollama.com/v1`에서 OpenAI 호환이며 키는
[ollama.com/settings/keys](https://ollama.com/settings/keys)에서 발급받습니다. opencodex는 클라우드
라인업을 비전 기능에 따라 분류하여 [비전 사이드카](/opencodex/ko/guides/sidecars/)가 텍스트 전용 모델에만
작동하도록 합니다. 텍스트 전용 모델(예: `glm-5.2`, `deepseek-v4-pro`, `gpt-oss`, `qwen3-coder`,
`minimax-m2.x`, `nemotron-3-*`)은 `noVisionModels`에 나열되며, 비전 네이티브 모델(예:
`kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5`, `gemini-3-flash-preview`)은 포함되지 않습니다. 매칭은
Ollama의 `:size` 태그에 관대하므로 `gpt-oss`는 `gpt-oss:120b`와 `gpt-oss:20b`를 모두 포괄합니다.

## 4. 로컬 프로바이더

opencodex를 로컬 OpenAI 호환 서버로 향하게 하세요 — 보통은 빈 키와 함께 사용합니다:

| 프로바이더 | 베이스 URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## 모든 OpenAI 호환 엔드포인트

프로바이더가 Chat Completions를 사용한다면 `openai-chat` 어댑터가 이를 처리합니다 — 대시보드에서
**Custom**을 선택하거나 `ocx init`에서 `custom`을 선택한 뒤 베이스 URL을 입력하세요. 모든 프로바이더 필드
(`headers`, `noReasoningModels`, `noVisionModels`, `models`, …)는
[설정 레퍼런스](/opencodex/ko/reference/configuration/)를 참고하세요.
