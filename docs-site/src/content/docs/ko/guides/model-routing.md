---
title: 모델 라우팅
description: opencodex가 주어진 모델 id를 어느 프로바이더가 처리할지 결정하는 방식.
---

Codex가 모델을 요청하면 `router.ts`가 이를 정확히 하나의 설정된 프로바이더로 해석합니다. 규칙은
**순서대로** 검사되며, 첫 번째로 일치하는 것이 적용됩니다.

OpenAI bare `gpt-*`는 단일 `openai` 프로바이더를 선택합니다. `codexAccountMode`가
Pool(기본, 메인+추가 계정) 또는 Direct(현재 caller/메인 bearer)를 정하며 모델 id는 그대로입니다.
`openai-apikey/<model>`은 API key transport를 명시적으로 선택하고 두 자격증명 경로는 fallback하지 않습니다.

## 우선순위

1. **명시적 `provider/model`** — id에 `/`가 포함되어 있고 그 앞부분이 설정된 프로바이더의 이름이면,
   해당 프로바이더가 사용되며 id는 슬래시 뒷부분으로 잘립니다.

   ```text
   anthropic/claude-opus-4-8   →  provider "anthropic",   model "claude-opus-4-8"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   이는 명확한 형식이며, Codex의 모델 선택기가 라우팅된 모델에 사용하는 형식입니다. 지정한 프로바이더가
   비활성화돼 있으면 라우팅하지 않고 오류를 냅니다.

2. **프로바이더의 `defaultModel`** — 어떤 프로바이더의 `defaultModel`이 id와 일치하면 해당 프로바이더가
   사용됩니다(id는 변경 없이 그대로 전달됩니다).

3. **빌트인 프리픽스 패턴** — id를 알려진 모델 제품군 프리픽스와 대조한 뒤, 해당 이름(또는 이름
   프리픽스)의 설정된 프로바이더로 라우팅합니다:

   | 프리픽스 | 프로바이더 |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `gpt-`, `o1-`, `o3-`, `o4-` | bare id는 설정된 `openai` 계정 모드, API key는 `openai-apikey/`를 명시 |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

   이 검사는 이름만 봅니다. `defaultModel` / `models[]` 검사와 달리, 현재는 이름이 일치한 프로바이더의
   `disabled` 값이 true여도 건너뛰지 않습니다.

4. **프로바이더의 `models[]`** — 프리픽스 규칙과 일치하지 않고 활성 프로바이더의 `models[]`에 id가
   있으면 그 프로바이더를 사용합니다. 순서에 주의하세요. OpenAI 이름의 프로바이더가 설정돼 있으면
   네임스페이스 없는
   `gpt-*` id는 다른 프로바이더의 `models[]`보다 먼저 OpenAI 쪽으로 갑니다.

5. **기본 프로바이더** — 어느 것도 일치하지 않으면 id는 변경 없이 `config.defaultProvider`로 전송됩니다.
   (기본 프로바이더가 없거나 비활성화돼 있으면 오류를 냅니다.)

## API 키와 환경 변수

어느 경로가 선택되든, 프로바이더의 `apiKey`는 `resolveEnvValue()`를 통해 해석됩니다:
`${OPENAI_API_KEY}` 또는 `$OPENAI_API_KEY` 값은 요청 시점에 환경에서 확장되므로 비밀 값을
`config.json`에 둘 필요가 전혀 없습니다.

## 카탈로그 표시와 컨텍스트 제한

요청 라우팅과 카탈로그 노출은 서로 다른 설정입니다.

- `disabledModels`에 프로바이더 네임스페이스가 붙은 id를 넣으면 Codex 카탈로그와 `/v1/models`에서
  빠집니다. 네임스페이스 없는 네이티브 GPT slug는 카탈로그에 남되 `visibility: "hide"`로 바뀝니다.
  이 설정만으로 해당 모델의 직접 요청을
  막지는 않습니다.
- 프로바이더의 `selectedModels`가 비어 있지 않으면 카탈로그 허용 목록으로 동작합니다. 실시간 모델 탐색과
  직접 라우팅은 그대로 두고, 카탈로그와 `/v1/models`에 내보낼 모델만 줄입니다.
- `provider.disabled: true`인 프로바이더는 카탈로그 탐색에서 제외됩니다. 명시적 `provider/model` 요청은
  실패하고, `defaultModel` / `models[]` 검사에서도 건너뜁니다.
- `providerContextCaps`는 프로바이더별로 Codex에 표시할 컨텍스트 상한을 지정합니다.
  `contextCapValue`는 대시보드가 함께 쓰는 값이며 기본값은 350,000입니다. 다만 이 값만 설정해서는
  아무 변화가 없고 `providerContextCaps`에 프로바이더가 들어 있어야 적용됩니다. 이미 알려진 컨텍스트
  크기를 낮추기만 하며, 더 키우거나 업스트림 모델의 실제 한도를 바꾸지는 않습니다.

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## 팁

- **라우팅된 모델에는 명시적으로 작성하세요.** `provider/model`(규칙 1)을 선호하세요 — 명확하고 카탈로그
  동기화 후 Codex가 선택기에 표시하는 것과 일치합니다.
- 프로바이더에 **`models[]` 또는 `defaultModel`을 미리 채워두면** 짧은 id(규칙 2/4)가 `provider/`
  프리픽스 없이 해석됩니다.
- **프리픽스 패턴은 편의 기능**일 뿐 보장이 아닙니다: 해당 이름(예: `anthropic`, `openai`, `groq`)의
  프로바이더가 실제로 설정되어 있을 때만 해석됩니다.

이 규칙들이 읽는 프로바이더 필드는 [설정](/opencodex/ko/reference/configuration/)을 참고하세요.
