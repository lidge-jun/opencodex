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

내장 `openai` 제공자가 없거나 비활성화된 경우 대시보드 Accounts 선택기와 Codex Auth 페이지에서 복구할 수 있습니다. 없는 항목은 정규 프리셋으로 만들고, 비활성화된 정규 항목은 저장된 모드/모델 설정을 바꾸지 않고 다시 켜며, 비정규 `openai` 항목에는 그 복구 경로를 제공하지 않습니다.

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
OpenAI beta/originator/session — [어댑터](/ko/reference/adapters/) 참고). 이 경로는
[웹 검색 및 비전 사이드카](/ko/guides/sidecars/)를 구동하는 경로이기도 합니다.

ChatGPT 패스스루 카탈로그에는 GPT-5.6 Sol/Terra/Luna의 네임스페이스 없는 slug
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`)도 들어갑니다. 실제 호출 가능 여부는 계정 권한에
따라 달라집니다.

## 2. 계정 로그인 (OAuth)

OAuth 로그인을 사용하는 프로바이더 프리셋은 여섯 개이며, 여기에 실험적 비공식 디바이스 플로우
브리지를 쓰는 GitHub Copilot이 추가됩니다. 자격 증명은 `~/.opencodex/auth.json`에 저장되고
자동으로 갱신됩니다. 로그인 CLI는 `chatgpt`도 받습니다. 이 명령은 ChatGPT 자격 증명을
발급받고 `forward` 모드 프로바이더 항목을 만듭니다.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # kiro-cli 자격 증명 가져오기(토큰 폴백 지원)
ocx login google-antigravity
ocx login cursor       # Cursor 전용 PKCE 로그인
ocx login github-copilot  # GitHub 디바이스 플로우 → Copilot 토큰 (Copilot Pro/Business)
ocx login chatgpt      # 별도 ChatGPT OAuth 로그인
ocx logout <provider>
```

| 프로바이더 | 어댑터 | 베이스 URL | 비고 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | 실시간 목록을 우선 사용하며, 폴백 기본 모델은 `grok-4.5`입니다. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 모델; 실시간 모델 목록은 `/v1/models`에서 가져옵니다. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 코딩 모델. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 최초 로그인은 설치하고 로그인한 `kiro-cli` 세션을 가져옵니다(Unix에서는 `curl -fsSL https://cli.kiro.dev/install | bash`, Windows PowerShell에서는 `irm 'https://cli.kiro.dev/install.ps1' | iex`로 설치한 뒤 `kiro-cli login` 실행). **계정 추가**는 `kiro-cli`에서 로그아웃한 뒤 새 브라우저 로그인을 시작하여 `kiro-cli` 자체의 계정을 전환하고, 계정별 프로필 메타데이터를 저장합니다. 기존 OpenCodex 계정은 유지되며, 취소되거나 실패하면 이전 `kiro-cli` 세션을 복원합니다. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth를 Cloud Code Assist wire로 사용합니다. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 실험적 PKCE 로그인, HTTP/2 전송, 계정별 모델 탐색을 지원합니다. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | 실험적. GitHub 디바이스 플로우 + `copilot_internal` 교환(VS Code OAuth 클라이언트). 활성 Copilot 구독 필요; 공식 서드파티 API가 아닙니다. |

정식 Kimi Coding Plan 프리셋(`kimi` 계정 로그인과 `kimi-code` API key)의 경우, opencodex는
호출자가 제공한 안정적인 `prompt_cache_key`만 Chat Completions 요청으로 전달하며 직접 생성하지
않습니다. Kimi 문서는 Code Plan 캐시 적중률을 높이기 위해 안정적인 세션/작업 key가 필요하다고
명시합니다. key가 없는 요청은 keyless 상태로 유지됩니다. opt-in한 업스트림이 이 필드를 거부해도
opencodex는 필드를 제거해 재시도하거나 저장된 설정을 변경하지 않습니다. 다른 프로바이더는
deny-by-default 상태로 유지됩니다.

[웹 대시보드](/ko/guides/web-dashboard/)에서도 OAuth를 시작할 수 있습니다.

### 여러 OAuth 계정

자격 증명에 고정된 계정 id나 이메일이 있는 OAuth 프로바이더는 로그인을 여러 개 보관할 수 있습니다.
Providers 페이지에서 계정을 추가하고, 다른 계정을 로그아웃하지 않은 채 활성 계정만 바꿀 수 있습니다.
계정 식별 정보가 없는 Kimi 자격 증명만 활성 슬롯을 교체하며, Kiro 계정은 프로필 ARN을 키로 저장됩니다.
`chatgpt`는 Codex 계정 풀에 별도 저장소가 있어 항상 단일 슬롯만 씁니다. 토큰은 `~/.opencodex/auth.json`에 저장되고,
`/api/oauth/accounts`는 마스킹된 메타데이터만 반환합니다.

### Kiro 자격 증명 가져오기

Kiro 로그인에는 Kiro CLI가 필요합니다. Unix에서는 `curl -fsSL https://cli.kiro.dev/install | bash`, Windows PowerShell에서는 `irm 'https://cli.kiro.dev/install.ps1' | iex`로 설치한 뒤 먼저 `kiro-cli login`으로 로그인하세요. `kiro-cli` 세션이 없으면 `ocx login kiro`는 붙여 넣은 액세스 토큰이나 `KIRO_ACCESS_TOKEN` 환경 변수로 폴백합니다.

일반 `ocx login kiro` 가져오기는 CLI SQLite 데이터베이스를 읽기 전용으로 열며 데이터베이스, WAL, SHM을 수정하지 않습니다.

- `KIROCLI_DB_PATH`는 비표준 Kiro CLI SQLite 데이터베이스를 선택하며, 지정한 데이터베이스는 이미 존재해야 합니다.
- `KIROCLI_TOKEN_KEY`는 모호한 토큰 행이 여러 개일 때 가져올 정확한 `auth_kv` 행의 키를 선택합니다. 선택값이 없으면 추측하지 않고 로그인이 실패합니다.

가져온 자격 증명은 `~/.opencodex/auth.json`에 저장됩니다. **계정 추가** 롤백은 별도 절차로, 이전 스냅샷을 복원할 때 데이터베이스를 교체하고 현재 WAL, SHM, journal 사이드카를 제거합니다.

롤백은 스냅샷이 있을 때만 가능하므로, 세션 저장소가 존재하지만 캡처할 수 없는 경우(파일을 읽을 수 없음, 스키마 불일치, 토큰 선택 모호), `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE`이 실제 CLI 저장소와 다른 가져오기 경로를 가리키는 경우, 또는 기본 CLI 데이터베이스에 인식 가능한 토큰 행이 없는 경우 **계정 추가**는 `kiro-cli` 로그아웃을 거부합니다. 일반 `kiro-cli` 데이터 경로의 손상된 데이터베이스를 수리하거나 제거하고, 가져오기 전용 선택자가 설정돼 있으면 해제한 뒤 다시 시도하세요. 기존 `kiro-cli` 세션이 아예 없는 환경에서는 영향이 없습니다.

## 3. API 키 카탈로그

opencodex에는 빌트인 프리셋이 66개 들어 있습니다. 키 방식 55개, OAuth 7개, 로컬 3개,
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
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen Cloud | Token plan(기본): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · 종량제: `https://dashscope.aliyuncs.com/compatible-mode/v1` · 또는 사용자 지정 |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …그 외 다수 | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

대부분은 bearer 키와 함께 `openai-chat` 어댑터를 사용하며, Anthropic 호환 엔드포인트만 노출하는 일부
(예: **Xiaomi MiMo**)는 `anthropic` 어댑터(`x-api-key`)를 사용합니다.
Volcengine Agent Plan은 `openai-responses` 어댑터로 네이티브 Responses 엔드포인트를 사용합니다.

> **Volcengine의 세 가지 과금 경로:** `volcengine`은 종량제 Ark API,
> `volcengine-coding-plan`은 Coding Plan 할당량, `volcengine-agent-plan`은 Agent Plan
> 할당량을 사용합니다. 같은 상품에서 발급된 키와 엔드포인트를 함께 사용해야 하며, Plan 구독이
> 있어도 일반 `/api/v3` 엔드포인트 호출에는 종량제 요금이 발생할 수 있습니다.
> 세 preset은 선별된 정적 모델 카탈로그를 사용합니다. Ark의 `/models`는 텍스트와 함께
> Embedding, 이미지, 비디오, 3D 리소스도 반환하고 Coding 게이트웨이도 같은 광범위한 카탈로그를
> 반환합니다. Agent Plan 게이트웨이에는 `/models` 리소스가 없습니다. 종량제 기본값은
> `doubao-seed-2-1-pro-260628`이며 정적 카탈로그에는 현재 DeepSeek와 GLM 텍스트 모델도
> 포함됩니다. Coding Plan의 기본값은 `ark-code-latest`, Agent Plan은 `deepseek-v4-pro`입니다.

**DeepInfra 검색:** 키 기반 OpenAI Chat Completions 제공자인 `deepinfra`는 `openai-chat` 어댑터와
Bearer API 키를 사용합니다. registry가 소유하는 DeepInfra 모델 목록 URL에서 `chat` 태그가 있는 행만
유지하고, 슬래시가 포함된 네이티브 모델 ID를 보존합니다. live discovery는 512 KiB 및 raw 512행으로
제한합니다. 키는 [DeepInfra dashboard](https://deepinfra.com/dash/api_keys)에서 생성합니다.

**Hyperbolic 검색:** 프리셋은 설정된 bearer 키로 `/v1/models`를 읽고, 슬래시가 포함된 네이티브 모델 ID를
보존하며 live discovery를 256 KiB와 raw 행 256개로 제한합니다. serverless text 및 vision-language chat만
대상으로 하며 별도 image, audio, GPU 엔드포인트는 범위에서 제외합니다. 키는
[Hyperbolic](https://app.hyperbolic.ai)에서 생성합니다.

> **Baseten 범위:** 이 프리셋은 Baseten의 공유 [Model APIs](https://docs.baseten.co/inference/model-apis/overview)만
> 지원합니다. 로컬 사용에는 개인 [API 키](https://docs.baseten.co/organization/api-keys)를, 공유/프로덕션
> 사용에는 **Call Model APIs** 권한이 있는 팀 키를 사용하세요. 전용 Truss `predict` 엔드포인트는
> 호스트와 스키마가 다르므로 이 프리셋으로 라우팅되지 않습니다.
> 이 프리셋의 실시간 검색은 응답 1 MiB와 원시 모델 행 256개로 제한됩니다.

> **Tencent Cloud Coding Plan 사용 제한:** Tencent는 이 구독을 대화형 코딩 도구 전용으로
> 안내합니다. 일반 API 자동화, 사용자 애플리케이션 백엔드 및 비대화형 일괄 호출은 금지되며
> 플랜 키가 정지될 수 있습니다.

> **GLM 경로는 두 개입니다:** `zai`는 Z.AI 국제 코딩 플랜 구독이고, `zhipu-bigmodel`은
> Zhipu의 중국 내수 BigModel 종량제 엔드포인트입니다. 호스트도 키도 과금도 다르며, 한쪽에서
> 발급한 키는 다른 쪽에서 인증되지 않습니다.

### 여러 API 키

키 기반 프로바이더도 여러 키를 보관할 수 있습니다. Providers 페이지에서 키를 추가하면
`provider.apiKeyPool`에 저장하고 이를 활성화하며, 라우팅과 어댑터가 이전처럼 같은 필드를 읽도록
`provider.apiKey`에도 반영합니다. 같은 드롭다운에서 키를 전환하거나 제거할 수 있습니다. 관리 API는
`/api/providers/keys`이며 마스킹된 키만 반환합니다.

### 터미널에서 계정 전환하기

대시보드를 열지 않고도 `ocx account list`, `ocx account current`, `ocx account use`로 같은 Codex,
OAuth, API-key pool을 확인하고 전환할 수 있습니다. 전체 명령, JSON 출력, 새 세션 적용 방식은
[CLI 레퍼런스](/ko/reference/cli/#ocx-account-subcommand)를 참고하세요.

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
사용합니다. v2.7.1 폴백 목록에는 1M 컨텍스트의 `gpt-5.6-sol` / `terra` / `luna`, 500K 컨텍스트의
`grok-4.5` / `grok-4.5-fast`, 262K 컨텍스트의 `kimi-k3`가 들어 있으며, 실시간 탐색 결과에 따라
현재 계정에 표시할 모델을 결정합니다. Cursor는 Kimi K3를 effort 접미사가 붙은 wire id로만
제공하므로 `cursor/kimi-k3`는 `low` / `high` / `max` 래더를 노출하고 기본값은 모델 문서의 API
기본값과 같은 `max`입니다. Cursor 서버가 직접 보내는 native read/write/delete/ls/grep/shell/fetch 실행은 Codex
승인 및 sandbox 경로를 우회하므로 기본적으로 비활성화되어 있습니다. 신뢰한 로컬 실험에서만
`~/.opencodex/config.json`의 `providers.cursor`에 `unsafeAllowNativeLocalExec: true`를 설정하세요.
대시보드에서는 **Providers → Cursor → Edit JSON**에서 설정할 수 있습니다. 전체 예시는
[설정 레퍼런스](/ko/reference/configuration/#cursor-provider-adapter-cursor)를 참고하세요.
MCP, 화면 녹화, computer-use는 executor hook으로 열려 있으며, 로컬
executor가 없으면 정책 차단이 아니라 typed no-executor 결과를 반환합니다. Cursor OAuth와 live
model discovery는 이 실험적 어댑터에서 활성화되어 있으며, Cursor는 여전히 key-login 목록에는
표시되지 않습니다.
:::

### Ollama Cloud

Ollama Cloud는 호스팅형(로컬이 아님) Ollama로, `https://ollama.com/v1`에서 OpenAI 호환이며 키는
[ollama.com/settings/keys](https://ollama.com/settings/keys)에서 발급받습니다. opencodex는 클라우드
라인업을 비전 기능에 따라 분류하여 [비전 사이드카](/ko/guides/sidecars/)가 텍스트 전용 모델에만
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
[설정 레퍼런스](/ko/reference/configuration/)를 참고하세요.
