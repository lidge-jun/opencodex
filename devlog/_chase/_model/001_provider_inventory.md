# 001 — Provider inventory

> Snapshot: 2026-07-17, `dev` @ `31fabf96`

이 문서는 모델 dump가 아니다. built-in provider의 현재 구조와 소유권만 기록한다. 정확한 모델 ID와 capability는 `src/providers/registry.ts`, live `/models`, `src/generated/jawcode-model-metadata.ts`를 순서대로 확인한다.

## 현재 수치

`PROVIDER_REGISTRY`를 직접 import해 센 결과다.

| 축 | 수치 |
|---|---|
| built-in provider | 52 |
| auth | key 42, oauth 6, local 3, forward 1 |
| adapter | openai-chat 38, anthropic 5, google 3, openai-responses 2, cursor 1, kiro 1, azure-openai 1, mimo-free 1 |

Provider ID:

```text
openai, cursor, xai, anthropic, anthropic-apikey, kimi, kiro, openai-apikey,
umans, opencode-go, neuralwatt, openrouter, groq, google, google-vertex,
google-antigravity, azure-openai, ollama, vllm, lm-studio, deepseek, cerebras,
together, fireworks, firepass, moonshot, huggingface, nvidia, venice, zai,
nanogpt, synthetic, qwen-portal, qianfan, alibaba, parallel, zenmux, litellm,
ollama-cloud, mistral, minimax, minimax-cn, kimi-code, opencode-zen,
vercel-ai-gateway, opencode-free, xiaomi, kilo, mimo-free,
cloudflare-ai-gateway, github-copilot, gitlab-duo
```

## Provider 계층

| 계층 | 역할 | 현재 소유자 |
|---|---|---|
| registry | id, adapter, base URL, auth kind, static model/capability seed | `src/providers/registry.ts:9-77`, `src/providers/registry.ts:221-679` |
| derived preset | init, dashboard, key-login, OAuth config로 registry 값을 복제 | `src/providers/derive.ts:59-199` |
| persisted config | 사용자 override, selected/disabled models, context cap, key pool | `src/types.ts:348-428`, `src/types.ts:559-607` |
| router | 명시적 namespace와 bare model을 활성 provider에 연결 | `src/router.ts:162-234` |
| adapter | OpenAI/Anthropic/Google/Cursor/Kiro/Azure/MiMo wire로 변환 | `src/server/adapter-resolve.ts:27-49` |
| catalog | live discovery, static fallback, metadata augmentation, Codex sync | `src/codex/catalog.ts:990-1328`, `src/codex/catalog.ts:1478-1569` |

## Provider군별 성격

| 군 | 예 | 주의점 |
|---|---|---|
| native passthrough | `openai` | Pool(기본)은 메인+추가 계정 풀을, Direct는 caller/main만 사용한다. 모드는 provider option이다. |
| OAuth/product token | `xai`, `anthropic`, `kimi`, `kiro`, `google-antigravity`, `cursor` | registry seed와 `src/oauth/index.ts` 구현이 모두 있어야 한다. |
| direct API key | `openai-apikey`, `anthropic-apikey`, `google`, `zai`, `openrouter` | 대부분 registry + 기존 adapter로 충분하다. |
| local/self-hosted | `ollama`, `vllm`, `lm-studio`, `litellm` | private destination 허용과 optional key 정책을 따로 본다. |
| product-specific adapter | `cursor`, `kiro`, `mimo-free` | OpenAI-compatible로 가정하면 안 된다. |
| gateway/aggregator | `openrouter`, `vercel-ai-gateway`, `cloudflare-ai-gateway`, `litellm` | upstream model metadata가 서로 다른 형태로 올 수 있다. |

OpenAI의 공개 provider는 Pool/Direct 옵션을 가진 `openai`와 API `openai-apikey`다.
레거시 `chatgpt`와 과거 Multi id는 migration 입력일 뿐 public registry provider가 아니다.

## jawcode metadata bridge

현재 registry alias가 가리키는 jawcode bundle은 7개다: `xai`, `anthropic`, `moonshot`, `opencode-go`, `openrouter`, `google`, `minimax`.

2026-07-17 생성 snapshot의 row 수는 각각 30, 25, 1, 19, 349, 34, 9다. 이 수치는 provider 지원 수가 아니라 catalog metadata row 수이며, jawcode 생성물을 갱신하면 달라진다.

## 검증

```bash
bun -e 'import { PROVIDER_REGISTRY } from "./src/providers/registry.ts"; console.log(PROVIDER_REGISTRY.length)'
bun -e 'import { PROVIDER_REGISTRY } from "./src/providers/registry.ts"; console.log(Object.fromEntries(Object.entries(Object.groupBy(PROVIDER_REGISTRY, x => x.adapter)).map(([k,v]) => [k,v.length])))'
rg -n "export const PROVIDER_REGISTRY|export function routeModel|export function resolveAdapter" src/providers/registry.ts src/router.ts src/server/adapter-resolve.ts
```
