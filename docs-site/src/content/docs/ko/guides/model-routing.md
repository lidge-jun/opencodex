---
title: 모델 라우팅
description: opencodex가 주어진 모델 id를 어느 프로바이더가 처리할지 결정하는 방식.
---

Codex가 모델을 요청하면 `router.ts`가 이를 정확히 하나의 설정된 프로바이더로 해석합니다. 규칙은
**순서대로** 검사되며, 첫 번째로 일치하는 것이 적용됩니다.

OpenAI에서는 설정된 `<selector>/gpt-*` id가 combo 또는 provider 네임스페이스보다 먼저
`codexAccountNamespaces`를 통해 정확히 하나의 저장된 Codex 계정에 매핑됩니다. bare `gpt-*` id는
대신 canonical `openai` provider를 선택합니다. 해당 provider의 `codexAccountMode`가 Pool(기본,
메인+추가 계정) 또는 Direct(현재 caller/메인 bearer)를 정하며 model id는 그대로입니다.
`openai-apikey/<model>`은 API key transport를 명시적으로 선택합니다. 이 credential route들은 서로
fallback하지 않습니다.

## 우선순위

1. **정확한 Codex account selector** — id가 `<selector>/<native-openai-model>`이고 selector가
   `codexAccountNamespaces`에 설정되어 있으면 요청은 매핑된 저장 account만 사용하고 bare native
   model을 upstream으로 보냅니다. exact target을 사용할 수 없으면 Pool, Direct 또는 provider routing의
   다음 규칙으로 넘어가지 않고 fail closed합니다.

   ```text
   side/gpt-5.6-sol → provider "openai", model "gpt-5.6-sol", account selector "side"
   ```

2. **Combo id 또는 alias** — combo가 하나 이상 설정되어 있는 동안에는 canonical `combo/<id>` 또는
   설정된 combo alias가 provider namespace보다 먼저 concrete target을 선택합니다. 설정된 combo가
   하나도 없으면 이름이 정확히 `combo`인 legacy physical provider는 일반 provider namespace로
   유지됩니다. target selection과 failover 동작은 [Combos](/ko/guides/combos/)를 참고하십시오.

3. **명시적 `provider/model`** — id에 `/`가 포함되어 있고 그 앞부분이 설정된 프로바이더의 이름이면,
   해당 프로바이더가 사용되며 id는 슬래시 뒷부분으로 잘립니다.

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   이는 routed provider를 명시하는 형식이며 Codex model picker가 라우팅된 모델에 사용하는 형식입니다.
   같은 public id가 설정된 combo alias이기도 하면 규칙 2가 먼저 적용됩니다. 지정한 provider가
   비활성화돼 있으면 라우팅하지 않고 오류를 냅니다.

4. **Bare native OpenAI-family id** — `gpt-*`, `o1-*`, `o3-*`, `o4-*` 같은 id는 canonical active
   `openai` provider와 설정된 Pool 또는 Direct account mode를 사용합니다.

5. **프로바이더의 `defaultModel`** — 어떤 프로바이더의 `defaultModel`이 id와 일치하면 해당 프로바이더가
   사용됩니다(id는 변경 없이 그대로 전달됩니다).

6. **빌트인 프리픽스 패턴** — id를 알려진 모델 제품군 프리픽스와 대조한 뒤, 해당 이름(또는 이름
   프리픽스)의 설정된 프로바이더로 라우팅합니다:

   | 프리픽스 | 프로바이더 |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

   이 검사는 이름만 봅니다. `defaultModel` / `models[]` 검사와 달리, 현재는 이름이 일치한 프로바이더의
   `disabled` 값이 true여도 건너뛰지 않습니다.

7. **프로바이더의 `models[]`** — 프리픽스 규칙과 일치하지 않고 활성 프로바이더의 `models[]`에 id가
   있으면 그 프로바이더를 사용합니다. 규칙 4가 bare `gpt-*` id를 다른 provider의 `models[]`가
   일치하기 전에 canonical active `openai` provider로 보냅니다.

8. **기본 프로바이더** — 어느 것도 일치하지 않으면 id는 변경 없이 `config.defaultProvider`로 전송됩니다.
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
  아무 변화가 없고 `providerContextCaps`에 프로바이더가 들어 있어야 적용됩니다. 대시보드 값을 변경하면
  '모든 라우팅 대상 프로바이더에 적용' 토글이 켜져 있을 때만 모든 활성 프로바이더에 다시 적용되며,
  그렇지 않으면 각 프로바이더는 자체 한도를 유지합니다. 이미 알려진 컨텍스트 크기를 낮추기만 하며,
  더 키우거나 업스트림 모델의 실제 한도를 바꾸지는 않습니다.

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

- **Codex account를 명시적으로 지정하려면** `<selector>/<native-openai-model>`(규칙 1)을 사용하십시오.
  이 route는 exact하고 fail closed하므로 다른 account로 조용히 전환하지 않습니다.
- **라우팅된 모델에는 명시적으로 작성하세요.** exact public id가 combo alias가 아닐 때
  `provider/model`(규칙 3)을 선호하십시오. provider를 직접 지정하며 catalog 동기화 후 Codex가
  picker에 표시하는 것과 일치합니다.
- 프로바이더에 **`models[]` 또는 `defaultModel`을 미리 채워두면** 짧은 id(규칙 5/7)가 `provider/`
  프리픽스 없이 해석됩니다.
- **프리픽스 패턴은 편의 기능**일 뿐 보장이 아닙니다: 해당 이름(예: `anthropic`, `groq`)의
  프로바이더가 실제로 설정되어 있을 때만 해석됩니다.

이 규칙들이 읽는 프로바이더 필드는 [설정](/ko/reference/configuration/)을 참고하세요.
