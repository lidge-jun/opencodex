# 007 — Provider and model ID delta

> Comparison base: OpenCodex `0167b415` and the fingerprinted 2026-07-17 local jawcode snapshot.

## Provider namespace

jawcode `models.json`에는 48개 top-level provider key가 있고, OCX `PROVIDER_REGISTRY`에는 52개 provider ID가 있다. 숫자나 문자열 차이는 곧 missing provider가 아니다.

### jawcode generated catalog에만 있는 ID

`alibaba-coding-plan`, `amazon-bedrock`, `deepinfra`, `google-gemini-cli`, `minimax-code`, `minimax-code-cn`, `openai-codex`, `opencode`

### OCX registry에만 있는 ID

`alibaba`, `anthropic-apikey`, `kimi`, `lm-studio`, `mimo-free`, `neuralwatt`, `ollama`, `openai-apikey`, `opencode-free`, `parallel`, `umans`, `vllm`

### 의미상 대응을 먼저 봐야 하는 이름

| OCX | jawcode 쪽 비교 대상 | 주의점 |
|---|---|---|
| `alibaba` | `alibaba-coding-plan` | ID가 아니라 endpoint/auth/plan 계약으로 비교 |
| `openai` | `openai-codex` | OCX `openai`는 forwarded Codex auth |
| `openai-apikey` | `openai` | API key Responses transport가 가까움 |
| `anthropic`, `anthropic-apikey` | `anthropic` | OCX는 auth mode를 provider ID로 분리 |
| `kimi`, `kimi-code`, `moonshot` | `kimi-code`, `moonshot` | OAuth/code endpoint/API endpoint를 분리해 비교 |
| `opencode-free`, `opencode-go`, `opencode-zen` | `opencode`, `opencode-go`, `opencode-zen` | 무료 catalog, Go plan, Zen endpoint를 이름만으로 합치지 않음 |

## jawcode metadata bridge의 실제 범위

OCX는 `anthropic`, `google`, `minimax`, `moonshot`, `opencode-go`, `openrouter`, `xai`의 7개 jawcode bundle을 매핑한다. `src/codex/catalog.ts:304`의 append allowlist는 `opencode-go` 하나뿐이다.

- `opencode-go`: jawcode에만 있는 row를 OCX routed catalog에 추가할 수 있다.
- 나머지 6개: 이미 live/static discovery에 존재하는 row의 context/input만 보강한다.
- generated metadata의 `maxTokens`, `reasoning`, `wireModelId`는 현재 catalog에 적용되지 않는다.

따라서 `bun run generate:jawcode-metadata`로 파일이 바뀌었다고 새 OpenRouter 모델이 자동 노출되는 것은 아니다.

## OpenRouter source-only 17 IDs

jawcode source `models.json`에는 있으나 현재 OCX generated snapshot에는 없는 ID다.

| 분류 | ID | OCX 효과 |
|---|---|---|
| 이미 OCX static seed | `openai/gpt-5.6-luna`, `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra` | 이름 추가 불필요. source metadata refresh는 기존 row 보강만 가능 |
| 신규 tier variant | `openai/gpt-5.6-luna-pro`, `openai/gpt-5.6-sol-pro`, `openai/gpt-5.6-terra-pro` | metadata만으로 append되지 않음. live discovery 또는 static 제품 결정 필요 |
| xAI namespaced/alias | `x-ai/grok-4.5`, `~x-ai/grok-latest` | direct OCX `xai/grok-4.5`와 별개. OpenRouter live result로만 노출 판단 |
| Aion | `aion-labs/aion-2.0`, `aion-labs/aion-3.0`, `aion-labs/aion-3.0-mini` | discovery-only candidate |
| Nex AGI | `nex-agi/nex-n2-mini`, `nex-agi/nex-n2-pro` | discovery-only candidate |
| Poolside | `poolside/laguna-xs-2.1`, `poolside/laguna-xs-2.1:free` | discovery-only candidate |
| Tencent | `tencent/hy3`, `tencent/hy3:free` | discovery-only candidate; 기존 `hy3-preview`와 동일시하지 않음 |

`sakana/fugu-ultra`는 이미 현재 OCX generated jawcode snapshot에도 존재하므로 이 17개에는 포함되지 않는다. 다만 OpenRouter는 metadata append 대상이 아니어서, 그 row가 picker에 나타나려면 live/static discovery가 먼저 모델을 제공해야 한다.

## OpenRouter `maxTokens` delta 11개

아래 값은 `source -> current generated snapshot` 비교다. 현재 OCX catalog가 generated `maxTokens`를 소비하지 않으므로 **즉시 런타임 변화가 아닌 contract gap**이다.

| ID | jawcode source | OCX generated snapshot |
|---|---:|---:|
| `minimax/minimax-m2` | 131,072 | 196,608 |
| `minimax/minimax-m2.1` | 131,072 | 196,608 |
| `minimax/minimax-m3` | 131,072 | 512,000 |
| `moonshotai/kimi-k2-thinking` | 100,352 | 262,144 |
| `moonshotai/kimi-k2.7-code` | 262,144 | 16,384 |
| `nvidia/nemotron-3-super-120b-a12b` | 262,144 | 16,384 |
| `openai/gpt-oss-120b` | 65,536 | 131,072 |
| `qwen/qwen3-235b-a22b-thinking-2507` | 8,888 | 262,144 |
| `qwen/qwen3-30b-a3b-thinking-2507` | 32,768 | 131,072 |
| `z-ai/glm-5.1` | 128,000 | 131,072 |
| `z-ai/glm-5.2` | 131,072 | 32,768 |

이 값을 사용하려면 먼저 `CatalogModel`/Codex consumer에서 max output의 의미와 precedence를 정의해야 한다. context window와 output cap을 섞어 적용하면 안 된다.

## GPT-5.6 Luna/Sol/Terra

### 이름

세 모델 이름은 양쪽에 이미 있다: `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`. 신규 ID 이식 대상이 아니다.

### jawcode 단계별 값

| 단계/transport | context | max output |
|---|---:|---:|
| generated OpenAI API row, policy 적용 전 | 1,050,000 | 128,000 |
| generated `openai-codex` row, policy 적용 전 | 373,000 | 128,000 |
| `applyGpt56ContextWindow` 적용 후 | 373,000 | 기존 max output 유지 |

### OCX 현재 값

| OCX route | context |
|---|---:|
| native Codex catalog | 372,000 |
| `openai-apikey` | 372,000 |
| `openrouter/openai/*` | 1,050,000 |
| Cursor tier rows | live/registry owner, 현재 test seed 1,000,000 |

372K와 373K를 1K 오타로 단정하지 않는다. usable prompt budget, reserved tokens, provider-advertised context가 서로 다른 개념일 수 있으므로 transport별 live evidence가 필요하다.

### jawcode cost metadata

| ID | input | output | cache read | cache write |
|---|---:|---:|---:|---:|
| Luna | 1 | 6 | 0.1 | 1.25 |
| Sol | 5 | 30 | 0.5 | 6.25 |
| Terra | 2.5 | 15 | 0.25 | 3.125 |

OCX에는 이 jawcode cost shape의 runtime/catalog consumer가 없으므로 현재 범위에서는 가져오지 않는다.

## Anthropic source/generated delta

- ID 수는 25개로 같다.
- OCX generator는 `claude-sonnet-4-6`과 `[1m]`의 context를 의도적으로 200K로 override한다.
- Sonnet 4.5에는 같은 override가 없으므로 source refresh 전에 1M 계약을 별도 검증해야 한다.

| ID | jawcode source context/output | OCX snapshot context/output | 해석 |
|---|---:|---:|---|
| `claude-sonnet-4-5` | 1,000,000 / 64,000 | 200,000 / 64,000 | override 없음; refresh 전 live proof 필요 |
| `claude-sonnet-4-5-20250929` | 1,000,000 / 64,000 | 200,000 / 64,000 | override 없음; refresh 전 live proof 필요 |
| `claude-sonnet-4-6` | 1,000,000 / 128,000 | 200,000 / 64,000 | context override는 의도적; output은 unconsumed delta |
| `claude-sonnet-4-6[1m]` | 1,000,000 / 64,000 | 200,000 / 64,000 | 이름과 snapshot context가 불일치하므로 별도 계약 확인 |

## xAI delta

jawcode source의 `grok-4.5`는 current generated xAI bundle에는 아직 없지만, OCX `xai` registry가 이미 `grok-4.5`와 500K context, low/medium/high reasoning을 명시한다. generated refresh는 현재 direct xAI 노출에 필수 조건이 아니다.
