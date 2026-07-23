---
title: Адаптеры
description: Семь адаптеров провайдеров — назначение каждого, способ построения запросов и особенности.
---

**Адаптер** выполняет преобразование между внутренней моделью запросов/ответов opencodex и
wire-форматом одного провайдера. Каждый адаптер реализует интерфейс `ProviderAdapter`
(`src/adapters/base.ts`):

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request, context): Promise<Response>;   // custom retry/transport
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // non-streaming
  runTurn?(parsed, incoming, emit): Promise<void>;      // bidirectional transport
}
```

`buildRequest` понижает `OcxParsedRequest` до HTTP-запроса к вышестоящему провайдеру;
`parseStream` / `parseResponse` поднимают ответ провайдера обратно во внутренние события
`AdapterEvent`. `fetchResponse` позволяет адаптеру самому управлять повторными попытками и
таймаутами, а `runTurn` поддерживает транспорты, которые нельзя представить как один HTTP-запрос
с последующим одним потоком ответа. Затем [`bridge.ts`](/opencodex/ru/reference/architecture/#мост)
превращает события в Responses SSE.

## `openai-chat`

**Назначение:** OpenAI **Chat Completions** (`POST {baseUrl}/chat/completions`) и все совместимые
провайдеры — xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama (локально и в облаке) и другие.
**Аутентификация:** `key` (Bearer).

- Преобразует внутренние сообщения в роли OpenAI; инструменты отображаются в
  `{type:"function", function:{…}}` и `tool_choice` (`auto`/`none`/`required` или именованная
  функция).
- **Переписывает идентификационный промпт Codex про GPT-5** в модельно-нейтральное вступление,
  чтобы маршрутизируемые модели не заявляли, что они от OpenAI.
- **Прижимает `reasoning_effort`** к объявленному моделью подмножеству, когда точный уровень
  недоступен; `xhigh` и `max` остаются разными метками, если провайдер явно не настроил alias. Для
  id из `provider.noReasoningModels` адаптер **полностью опускает** этот параметр.
- Стримит `delta.content` (текст), `delta.reasoning_content` (thinking) и `delta.tool_calls[]`;
  собирает `usage`.

## `openai-responses`

**Назначение:** OpenAI **Responses API**. **`passthrough: true`** — пересылает исходное тело
запроса и стримит ответ обратно **без преобразования**.
**Аутентификация:** `forward` (ретрансляция заголовков вызывающей стороны) или `key`.

- URL для `forward` → `{baseUrl}/responses`. Провайдер с `key` по умолчанию сохраняет прежнее построение `{baseUrl}/v1/responses`.
- Провайдер с `key` может задать проверенный относительный `responsesPath`: адаптер удаляет один завершающий `/` из `baseUrl` и отправляет запрос на `{trimmedBaseUrl}{responsesPath}`. Для Ark Agent Plan используйте `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` и `responsesPath: "/responses"`.
- В режиме `forward` ретранслируется только безопасный allowlist заголовков (`FORWARD_HEADERS`):
  authorization, ChatGPT account id и заголовки OpenAI beta/originator/session. Это путь входа
  через ChatGPT, на котором также работают [сайдкары](/opencodex/ru/guides/sidecars/).

## `anthropic`

**Назначение:** Anthropic **Messages** (`/v1/messages`).
**Аутентификация:** `key` (`x-api-key`) или `oauth` (Bearer + `anthropic-beta`, для Claude Pro/Max).

- Преобразует сообщения в блоки контента Anthropic (text, base64 image, `tool_use`, `thinking`).
- **Арифметика extended thinking:** Anthropic требует `max_tokens > thinking.budget_tokens`.
  Адаптер отображает уровень рассуждений в бюджет (minimal 1024 … max 32000), затем вычисляет
  безопасный `max_tokens` с запасом на вывод и **удаляет `temperature`/`top_p`**, когда thinking
  включён (Anthropic запрещает их в этом режиме).
- Всегда отправляет `anthropic-version: 2023-06-01`. Стримит `content_block_delta` (`text_delta`,
  `thinking_delta`, `input_json_delta`).

## `google`

**Назначение:** Google **Gemini**, **Vertex AI** и Antigravity **Cloud Code Assist**. AI Studio
использует `/v1beta/models/{model}:streamGenerateContent`; остальные режимы используют свои
нативные конечные точки Google.
**Аутентификация:** API-ключ, Vertex ADC или Google Antigravity OAuth — выбирается через
`googleMode`.

- Системный промпт → `systemInstruction`; сообщения → `contents[]` (assistant → `model`);
  инструменты → `functionDeclarations`. Изображения из data-URL → `inline_data`.
- Идентификаторы вызовов инструментов синтезируются, когда Gemini их опускает. Antigravity
  сохраняет и повторно передаёт настоящие значения `thoughtSignature`, чтобы непрерывность
  рассуждений сохранялась в последующих ходах.

## `kiro`

**Назначение:** сервис Amazon CodeWhisperer Streaming `GenerateAssistantResponse`, используемый
Kiro (`https://runtime.{region}.kiro.dev/`).
**Аутентификация:** Kiro OAuth access token как Bearer, с метаданными region/profile из учётных
данных Kiro.

- Формирует Kiro `conversationState`, отображает инструменты Codex и результаты их вызовов и
  отправляет блоки изображений, поддерживаемые wire-форматом Kiro.
- Декодирует `application/vnd.amazon.eventstream`, восстанавливает события text/thinking/tool,
  обнаруживает усечённый JSON инструментов и оценивает использование, потому что вышестоящий
  сервис не возвращает количество токенов.
- Через `fetchResponse` сам управляет ограниченными повторными попытками и классифицированными
  ошибками с удалением чувствительных данных; его непотоковый парсер вычитывает тот же поток
  событий для цикла веб-поиска.

## `cursor`

**Назначение:** `agent.v1.AgentService/Run` Cursor поверх потокового HTTP/2 Connect на
`api2.cursor.sh`.
**Аутентификация:** Cursor OAuth/access token из `provider.apiKey` или из переданного заголовка
authorization.

- Использует `runTurn` вместо обычного пути fetch/parse. Запросы, серверные события, аргументы
  инструментов, контрольные точки использования и ответы клиента кодируются схемами
  `@bufbuild/protobuf` из `cursor/gen/agent_pb.ts` и оформляются как сообщения Connect.
- Воспроизводит состояние диалога через content-addressed blob'ы, отображает серверные вызовы
  инструментов обратно в Codex, обнаруживает актуальные модели Cursor через protobuf RPC
  `GetUsableModels` и повторяет попытки только до того, как run-запрос зафиксирован на wire.
- Нативное для Cursor локальное выполнение операций с файловой системой/shell/сетью по умолчанию
  запрещено. Явные интеграции `mcpServers` и `desktopExecutor` включаются отдельно;
  `unsafeAllowNativeLocalExec` включает более широкий встроенный executor и обходит семантику
  одобрений/песочницы Codex.

## `azure-openai` (алиас: `azure`)

**Назначение:** **Azure OpenAI**. Обёртка над `openai-responses` (поэтому тоже
`passthrough: true`).
**Аутентификация:** `key` через заголовок `api-key` (не Bearer).

- Делегирует построение запроса passthrough-адаптеру Responses, проверяет, что `baseUrl` не
  содержит неразрешённых плейсхолдеров шаблона, и заменяет `Authorization` на `api-key`.
  Настроенный URL указывает напрямую на Azure v1 Responses API, поэтому адаптер не добавляет
  `api-version`.

## Утилиты для изображений (`image.ts`)

Общие хелперы, используемые адаптерами с поддержкой изображений:

- `parseDataUrl(url)` — разбивает URL вида `data:<type>;base64,<data>` на `{ mediaType, base64 }`
  для блоков изображений Anthropic/Google.
- `contentPartsToText(content)` — сплющивает части контента в текст для текстовых сообщений
  инструментов (изображение без описания становится коротким маркером `[image]`, а не
  раздувающим токены base64-блобом).
