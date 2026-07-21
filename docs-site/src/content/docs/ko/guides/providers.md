---
title: 프로바이더
description: opencodex가 LLM 프로바이더를 인증하고 통신하는 모든 방식 — OAuth, API 키, ChatGPT 포워드, 그리고 로컬.
---

**프로바이더**는 하나의 업스트림 LLM 엔드포인트와 거기에 도달하는 방법을 합친 것입니다: 어댑터, 베이스 URL, 인증
모드, 그리고 선택적인 모델 목록으로 구성됩니다. 프로바이더는 `~/.opencodex/config.json`의 `providers` 아래에 위치합니다.

## OpenAI 계정 모드

| 프로바이더 id | 용도 | 자격증명/계정 규칙 |
| --- | --- | --- |
| `openai` | Codex 로그인 | Pool(기본)은 메인+추가 계정을 선택하고 Direct는 현재 caller/메인 로그인만 사용합니다. |
| `openai-apikey` | OpenAI API | 설정된 API key/key pool만 사용하며 Codex 계정을 읽지 않습니다. |

bare `gpt-5.6-sol`은 Providers 페이지의 Pool/Direct 옵션을 따르고,
`openai-apikey/gpt-5.6-sol`은 API를 선택합니다. 자격증명 경로 간 fallback은 없습니다. API는 context 1,050,000 /
max input 922,000이며 `*-pro` virtual id는 공개 상태에 유지되고 wire에서 base 모델과
`reasoning.mode: "pro"`로 바뀝니다.

shipped v1 config는 marker 2의 단일 옵션 행으로 자동 이관됩니다. 원본은
`~/.opencodex/config.json.pre-openai-tiers-v2.bak`에 한 번 보존되며 다음 명령으로 복원합니다:
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`.

## 인증 모드

프로바이더 설정에서 쓸 수 있는 `authMode`는 세 가지이며, 기본값은 `key`입니다. 빌트인 레지스트리는
로컬 프리셋을 별도로 분류합니다. 로컬 프리셋에는 보통 `authMode`와 `apiKey`를 모두 쓰지 않습니다.

| `authMode` | 인증 방식 | 사용처 |
| --- | --- | --- |
| `key` | API 키를 전송합니다(`Authorization: Bearer …`, 또는 어댑터에 따라 `x-api-key` / `api-key`). 키는 리터럴이거나 `${ENV_VAR}` 참조일 수 있습니다. | 대부분의 프로바이더. |
| `forward` | **수신된 Codex 인증 헤더를** 프로바이더에 그대로 중계합니다 — 키를 저장하지 않습니다. ChatGPT 로그인 패스스루입니다. | OpenAI (`openai-responses` 어댑터). |
| `oauth` | 저장된 OAuth 액세스 토큰을 불러와 bearer 키로 사용하며, 만료 전에 자동 갱신합니다. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor. |

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

ChatGPT 패스스루 카탈로그에는 GPT-5.6 Sol/Terra/Luna의 네임스페이스 없는 slug
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`)도 들어갑니다. 실제 호출 가능 여부는 계정 권한에
따라 달라집니다.

## 2. 계정 로그인 (OAuth)

OAuth 로그인을 사용하는 프로바이더 프리셋은 여섯 개입니다. 자격 증명은
`~/.opencodex/auth.json`에 저장되고 자동으로 갱신됩니다. 로그인 CLI는 `chatgpt`도 받습니다.
이 명령은 ChatGPT 자격 증명을 발급받고 `forward` 모드 프로바이더 항목을 만듭니다.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # kiro-cli 자격 증명 가져오기(토큰 폴백 지원)
ocx login google-antigravity
ocx login cursor       # Cursor 전용 PKCE 로그인
ocx login chatgpt      # 별도 ChatGPT OAuth 로그인
ocx logout <provider>
```

| 프로바이더 | 어댑터 | 베이스 URL | 비고 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | 실시간 목록을 우선 사용하며, 폴백 기본 모델은 `grok-4.5`입니다. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 모델; 실시간 모델 목록은 `/v1/models`에서 가져옵니다. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 코딩 모델. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 설치된 `kiro-cli` 로그인을 먼저 가져옵니다. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth를 Cloud Code Assist wire로 사용합니다. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 실험적 PKCE 로그인, HTTP/2 전송, 계정별 모델 탐색을 지원합니다. |

[웹 대시보드](/opencodex/ko/guides/web-dashboard/)에서도 OAuth를 시작할 수 있습니다.

### 여러 OAuth 계정

자격 증명에 고정된 계정 id나 이메일이 있는 OAuth 프로바이더는 로그인을 여러 개 보관할 수 있습니다.
Providers 페이지에서 계정을 추가하고, 다른 계정을 로그아웃하지 않은 채 활성 계정만 바꿀 수 있습니다.
계정 식별 정보가 없는 Kimi와 Kiro는 활성 슬롯을 교체하며, `chatgpt`는 Codex 계정 풀에 별도 저장소가
있어 항상 단일 슬롯만 씁니다. 토큰은 `~/.opencodex/auth.json`에 저장되고,
`/api/oauth/accounts`는 마스킹된 메타데이터만 반환합니다.

## 3. API 키 카탈로그

opencodex v2.7.1에는 빌트인 프리셋이 50개 들어 있습니다. 키 방식 40개, OAuth 6개, 로컬 3개,
기본 ChatGPT 포워드 프리셋 1개입니다. 대시보드의 **Add provider** 선택기는 키 발급 페이지를 열고,
입력한 키를 검증한 뒤 저장합니다. 주요 항목은 다음과 같습니다:

| 프로바이더 | 베이스 URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
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
| Qwen Cloud | Token plan(기본): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · 종량제: `https://dashscope.aliyuncs.com/compatible-mode/v1` · 또는 사용자 지정 |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitHub Copilot · GitLab Duo | `https://api.githubcopilot.com` · `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …그 외 다수 | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

대부분은 bearer 키와 함께 `openai-chat` 어댑터를 사용하며, Anthropic 호환 엔드포인트만 노출하는 일부
(예: **Xiaomi MiMo**)는 `anthropic` 어댑터(`x-api-key`)를 사용합니다.

### 여러 API 키

키 기반 프로바이더도 여러 키를 보관할 수 있습니다. Providers 페이지에서 키를 추가하면
`provider.apiKeyPool`에 저장하고 이를 활성화하며, 라우팅과 어댑터가 이전처럼 같은 필드를 읽도록
`provider.apiKey`에도 반영합니다. 같은 드롭다운에서 키를 전환하거나 제거할 수 있습니다. 관리 API는
`/api/providers/keys`이며 마스킹된 키만 반환합니다.

### GPT-5.6 프리뷰 경로

실시간 모델 카탈로그 갱신이 늦어도 `ocx sync`에서 모델이 사라지지 않도록 GPT-5.6
Sol/Terra/Luna를 폴백 목록에 넣어 둡니다.

| Codex 경로 | 미리 등록된 모델 id | Codex에 표시되는 컨텍스트 |
| --- | --- | --- |
| Codex 로그인(Pool 또는 Direct) | `gpt-5.6-*` | 372,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*`와 `*-pro` | 1,050,000 (max input 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` | 1,050,000 |
| Cursor | `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` | 1,000,000 |

네이티브 GPT-5.6 항목은 고정된 업스트림 reasoning 단계를 그대로 따릅니다. 예를 들어 Luna에는
`max`는 있지만 `ultra`는 없습니다. 라우팅 모델은 각 프로바이더의 메타데이터와 reasoning 매핑을
사용합니다. 네 경로 모두 실제 사용 권한은 업스트림 계정이 결정하며, Cursor는 실시간 탐색 결과를
기준으로 현재 계정에서 쓸 수 있는 모델만 남깁니다.

:::note[게이트웨이 및 구독 프록시]
프로바이더 지원 여부는 "에이전트" 제품인지가 아니라 opencodex에 맞는 wire 어댑터가 있는지로
결정됩니다. 현재 어댑터 id는 `openai-chat`, `openai-responses`, `anthropic`, `google`(AI Studio,
Vertex, Antigravity/Cloud Code Assist 모드), `azure` / `azure-openai`, `kiro`, `cursor`입니다.
Amazon Bedrock 네이티브 API처럼 이 구현 중 어느 것과도 맞지 않는 독자 프로토콜은 직접 지원하지 않습니다.
**GitHub Copilot**과 **GitLab Duo**는 자신의 범용 OpenAI 호환 엔드포인트에 매핑된 멀티 모델
게이트웨이입니다. Copilot은 `ocx login github-copilot`으로 GitHub 디바이스 플로우 OAuth 로그인을
지원합니다(비공식 브리지 — VS Code 공개 클라이언트 id로 로그인 후 단기 Copilot API 토큰으로
교환하며, 활성 Copilot 구독이 필요하고 GitHub 정책 변경으로 막힐 수 있음). GitLab Duo는 Bearer
**구독 토큰**(일반 API 키가 아님)으로 인증합니다. **Cloudflare AI
Gateway**는 URL에 계정 + 게이트웨이 id를 채워야 합니다.

Cursor는 별도의 실험적 어댑터로 추적합니다. `adapter: "cursor"`는 `ocx init`과 dashboard Add
Provider picker에 실험적 local config 항목으로 표시되며, Cursor의 static fallback model catalog
metadata를 저장합니다. Cursor access token이 설정되면 opencodex는 Cursor live HTTP/2 transport를
사용합니다. v2.7.1 폴백 목록에는 1M 컨텍스트의 `gpt-5.6-sol` / `terra` / `luna`와 500K 컨텍스트의
`grok-4.5` / `grok-4.5-fast`가 들어 있으며, 실시간 탐색 결과에 따라 현재 계정에 표시할 모델을
결정합니다. Cursor 서버가 직접 보내는 native read/write/delete/ls/grep/shell/fetch 실행은 Codex
승인 및 sandbox 경로를 우회하므로 기본적으로 비활성화되어 있습니다. 신뢰한 로컬 실험에서만
`~/.opencodex/config.json`의 `providers.cursor`에 `unsafeAllowNativeLocalExec: true`를 설정하세요.
대시보드에서는 **Providers → Cursor → Edit JSON**에서 설정할 수 있습니다. 전체 예시는
[설정 레퍼런스](/opencodex/ko/reference/configuration/#cursor-provider-adapter-cursor)를 참고하세요.
MCP, 화면 녹화, computer-use는 executor hook으로 열려 있으며, 로컬
executor가 없으면 정책 차단이 아니라 typed no-executor 결과를 반환합니다. Cursor OAuth와 live
model discovery는 이 실험적 어댑터에서 활성화되어 있으며, Cursor는 여전히 key-login 목록에는
표시되지 않습니다.
:::

### Ollama Cloud

Ollama Cloud는 호스팅형(로컬이 아님) Ollama로, `https://ollama.com/v1`에서 OpenAI 호환이며 키는
[ollama.com/settings/keys](https://ollama.com/settings/keys)에서 발급받습니다. opencodex는 클라우드
라인업을 비전 기능에 따라 분류하여 [비전 사이드카](/opencodex/ko/guides/sidecars/)가 텍스트 전용 모델에만
작동하도록 합니다. 텍스트 전용 모델(예: `glm-5.2`, `deepseek-v4-pro`, `gpt-oss`, `qwen3-coder`,
`minimax-m2.x`, `nemotron-3-*`)은 `noVisionModels`에 나열되며, 비전 네이티브 모델(예:
`kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5`, `gemini-3-flash-preview`)은 포함되지 않습니다. 매칭은
Ollama의 `:size` 태그에 관대하므로 `gpt-oss`는 `gpt-oss:120b`와 `gpt-oss:20b`를 모두 포괄합니다.

### 수동 모델 입력

Add Provider 대화 상자에서 자동 감지 대신 **수동 설정**을 선택할 수 있습니다.
수동 모드는 프로바이더 설정에 `liveModels: false`와 `models` 목록을 저장하며, `/models` 요청은 발생하지 않습니다. 입력한 ID가 Codex에 보이는 전부입니다.
자세한 내용은 [설정 레퍼런스](/opencodex/ko/reference/configuration/)를 참고하세요.

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
