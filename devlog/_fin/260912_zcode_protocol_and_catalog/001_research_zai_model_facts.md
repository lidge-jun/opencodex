# 001 — Z.AI GLM-5.3 계열 1차 근거 (Aside 세션 조사)

수집 경로: `aside exec --permission full-access` (CLI 1.26.902, 세션 `cye9q0tV093bZeFJ`), 2026-09-12.
아래 인용은 Aside 에이전트가 실제로 연 공식 문서 페이지에서 그대로 가져온 문장이다.

## 입력 모달리티

| 모델 | 입력 모달리티 | 컨텍스트 | 최대 출력 | reasoning 사다리 | 출처 |
|---|---|---|---|---|---|
| GLM-5.3 | text only | 1M | 128K | low / high / max (비활성화 불가) | https://docs.z.ai/guides/llm/glm-5.3 |
| GLM-5.3-Flash | video / image / text / file | 1M | 128K | low / high / max (비활성화 불가) | https://docs.z.ai/guides/vlm/glm-5.3-flash |

verbatim:

> "GLM-5.3 currently supports text-only inputs, with a 1M-token context window and a maximum output length of 128K tokens."
> — https://docs.z.ai/guides/llm/glm-5.3

> "GLM-5.3 目前仅支持处理文本模态信息，支持 1M 上下文窗口，最大输出 Tokens 为 128K。"
> — https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3

> "GLM-5.3-Flash is the first native multimodal model in the GLM-5 series"
> "Input Modality: Video / Image / Text / File"
> — https://docs.z.ai/guides/vlm/glm-5.3-flash

> "GLM-5.3 is a text-only model, so uncheck Support Images; GLM-5.3-FLASH is a multimodal model, so Support Images can be checked"
> — https://docs.z.ai/devpack/latest-model

이미지 입력 전달 방식:

> "Image Parameters: Add a content block with type: image_url to messages[].content[], and pass the image URL (recommended) or a Base64 Data URL through image_url.url."
> — https://docs.z.ai/guides/vlm/glm-5.3-flash

## reasoning effort

> "reasoning_effort: Controls the degree of reasoning within the thought chain... Available values: max (default and recommended, deep inference), high (enhanced inference), low (mild inference, only supported by GLM-5.3 and GLM-5.3-FLASH)"
> "For GLM-5.3 and GLM-5.3-FLASH, only max, high and low are supported. Any other input will result in an error."
> — https://docs.z.ai/guides/capabilities/thinking

리포지토리의 `ZAI_GLM_53_REASONING_EFFORTS = ["low", "high", "max"]` 와 일치한다.

## 프로토콜 엔드포인트 (세 갈래)

> "| Protocol | Base URL |
> | OpenAI Chat Completion Protocol | https://api.z.ai/api/coding/paas/v4 |
> | OpenAI Response Protocol | https://api.z.ai/api/v1 |
> | Anthropic Message Protocol | https://api.z.ai/api/anthropic |"
> — https://docs.z.ai/guides/llm/glm-5.3

> "Claude Code / Goose (Anthropic-compatible): https://api.z.ai/api/anthropic
> Codex: https://api.z.ai/api/v1
> Other OpenAI-compatible tools: https://api.z.ai/api/coding/paas/v4"
> — https://docs.z.ai/devpack/latest-model

상충하는 단서 하나 (해결 필요):

> "If you have previously subscribed to a GLM Coding Plan, including an expired subscription, you can currently access the model API only through the OpenAI Chat Completion-compatible protocol."
> — https://docs.z.ai/guides/llm/glm-5.3

즉 Coding Plan 구독 이력이 있는 키는 Responses 엔드포인트에서 거절될 수 있다. Responses 전환을
제안하기 전에 실제 키로 확인이 필요하다.

