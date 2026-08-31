---
title: Адаптеры
description: Адаптеры провайдеров — назначение каждого, способ построения запросов и особенности.
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
с последующим одним потоком ответа. Затем [`bridge.ts`](/ru/reference/architecture/#мост)
превращает события в Responses SSE.

## `openai-chat`

**Назначение:** OpenAI **Chat Completions** (`POST {baseUrl}/chat/completions`) и все совместимые
провайдеры — xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama (локально) и другие.
**Аутентификация:** `key` (Bearer).

- Преобразует внутренние сообщения в роли OpenAI; инструменты отображаются в
  `{type:"function", function:{…}}` и `tool_choice` (`auto`/`none`/`required` или именованная
  функция).
- **Изображения из результатов инструментов** отправляются отдельным последующим user-сообщением
  (части `image_url`) после закрытия раунда инструментов, так как содержимое `role:"tool"` может
  быть только текстом; маркер `[image]` остаётся в сообщении инструмента как якорь.
- **Переписывает идентификационный промпт Codex про GPT-5** в модельно-нейтральное вступление,
  чтобы маршрутизируемые модели не заявляли, что они от OpenAI.
- **Прижимает `reasoning_effort`** к объявленному моделью подмножеству, когда точный уровень
  недоступен; `xhigh` и `max` остаются разными метками, если провайдер явно не настроил alias. Для
  id из `provider.noReasoningModels` адаптер **полностью опускает** этот параметр.
- Стримит `delta.content` (текст), `delta.reasoning_content` (thinking) и `delta.tool_calls[]`;
  собирает `usage`.
- ClinePass использует проверенный на живом API формат шлюза
  `reasoning: { enabled: true, effort }` (или `{ enabled: false }`, когда reasoning отключён);
  в публичной документации API этот формат запроса пока не указан. Адаптер сохраняет запрошенный
  уровень `low`, `medium`, `high`, `xhigh` или `max`, принимает reasoning delta из
  `delta.reasoning_content` или `delta.reasoning`, запрашивает usage потока через
  `stream_options.include_usage` и читает usage из envelope нестримингового ответа.

## `ollama-native`

**Цели:** собственный **Chat API** Ollama (`POST /api/chat`) вместо его OpenAI-совместимой
поверхности. Встроенный провайдер `ollama-cloud` выбирается на этот адаптер реестром; его также
можно настроить для отдельного пользовательского или self-hosted провайдера Ollama с
`adapter: "ollama-native"`.
**Аутентификация:** `key` (Bearer) для cloud/пользовательских адресов; учётные данные не
отправляются на loopback-цели и при `authMode: "local"`.

- **Выбор через реестр имеет решающее значение.** Встроенная строка `ollama-cloud` сохраняет
  базовый URL `https://ollama.com/v1` для живого обнаружения через `/v1/models`, тогда как вывод
  нормализуется на `POST https://ollama.com/api/chat`. Настроенный уровень `adapter` для этой
  строки провайдера отбрасывается. Обычный встроенный локальный Ollama остаётся на `openai-chat`;
  выбор `ollama-native` для локального или self-hosted адреса — это явное решение конфигурации
  провайдера, определяемое по хосту, так что не-Ollama назначение никогда не переписывается молча.
- **Метаданные моделей:** `/v1/models` не несёт метаданных по моделям, поэтому для канонического
  Ollama Cloud провайдер дополняет каждый обнаружённый id через *ограниченный* `POST /api/show`
  (256 KiB на ответ, 8 с на запрос, параллельность 4, 48 запросов, дедлайн 12 с на всю фазу), чтобы
  получить реальное окно контекста и поддержку зрения. Запрос show — того же источника и никогда
  не следует за перенаправлением; сбой деградирует только эту модель и не ломает обнаружение.
- **Стриминг:** нативный NDJSON Ollama. Дельты текста и `message.thinking` пересылаются по мере
  поступления; ход завершается только по терминальной записи `done: true`, а буферизованный
  `done: false` или отсутствующий терминал полностью подавляют частичный текст и вызовы
  инструментов.
- **Reasoning:** отображается на нативное поле `think` Ollama (`low`/`medium`/`high`/`max`, плюс
  булевы значения), зажимается до заявленной лестницы модели и соблюдает семантику sentinel
  `__omit__`, настроенную выше по стеку.
- **Изображения:** отправляются нативно в массиве `images` сообщения, если модель поддерживает
  зрение; видео отклоняется, а не отправляется неверно, удалённые URL изображений не загружаются.
- **Инструменты:** объявляются в нативной форме Ollama; стриминговые вызовы инструментов —
  цельные записи с `arguments` в виде объекта, а повтор результатов инструментов строго
  сопоставляется по id вызова и имени инструмента. `tool_choice: "none"` и `auto` работают
  обычно; **`required` или точное именованное значение завершается ошибкой**, потому что
  `/api/chat` Ollama не имеет поля `tool_choice`, которым его можно было бы навязать.
- **Структурированный вывод отклоняется на каноническом Ollama Cloud.** Ollama в документации
  указывает, что структурированные выходные данные сейчас не поддерживаются в его Cloud, и Cloud не
  соблюдает поле `format`, поэтому OpenCodex закрывает такой запрос с ошибкой, а не возвращает
  свободную прозу в ответ на запрос с указанием схемы. Локальные и пользовательские
  `ollama-native` конечные точки сохраняют нативное отображение `format` Ollama
  (`json_object` → `"json"`, `json_schema` → сам объект схемы).

## `openai-responses`

**Назначение:** OpenAI **Responses API**. **`passthrough: true`** — пересылает исходное тело
запроса и стримит ответ обратно **без преобразования**.
**Аутентификация:** `forward` (ретрансляция заголовков вызывающей стороны) или `key`.

При `key`-аутентификации [`retryOn429`](/ru/reference/configuration/) действует и здесь: 429 до
начала потока ждёт и, до любой другой обработки или фейловера, повторяет идентичный запрос на
том же ключе, как и в переводимом пути `openai-chat`/Anthropic. Пользовательские транспорты
`runTurn` в цикл HTTP-повторов не входят.

- Stateless-парсер DeepSeek Responses получает нормализацию истории на уровне провайдера:
  контекст, внедрённый хуком, переносится после однозначного батча call/result. Параллельные вызовы
  остаются сгруппированными перед своими результатами, поэтому каждый вызов сохраняет свой
  один assistant-ход с рассуждениями. Толерантные провайдеры и неоднозначные (дублирующиеся,
  отсутствующие или неупорядоченные) идентификаторы call сохраняют исходный порядок входа.

- URL для `forward` → `{baseUrl}/responses`. Провайдер с `key` по умолчанию сохраняет прежнее построение `{baseUrl}/v1/responses`.
- Провайдер с `key` может задать проверенный относительный `responsesPath`: адаптер удаляет один завершающий `/` из `baseUrl` и отправляет запрос на `{trimmedBaseUrl}{responsesPath}`. Для Ark Agent Plan используйте `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` и `responsesPath: "/responses"`.
- В режиме `forward` ретранслируется только безопасный allowlist заголовков (`FORWARD_HEADERS`):
  authorization, ChatGPT account id и заголовки OpenAI beta/originator/session. Это путь входа
  через ChatGPT, на котором также работают [сайдкары](/ru/guides/sidecars/).

## `anthropic`

**Назначение:** Anthropic **Messages** (`/v1/messages`).
**Аутентификация:** `key` (по умолчанию `x-api-key`, либо `Authorization: Bearer` при `apiKeyTransport: "bearer"`) или `oauth` (Bearer + `anthropic-beta`, для Claude Pro/Max).

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
- Идентификаторы вызовов инструментов синтезируются, когда Gemini их опускает. Vertex и Antigravity
  сохраняют и повторно передают непрозрачные значения `thoughtSignature`, чтобы непрерывность
  рассуждений сохранялась после возврата результата инструмента. Кэш подписей сохраняется в каталог
  конфигурации, поэтому последующие ходы переживают и перезапуск прокси.

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
### Завершение и нативный stop reason

Текст ассистента Kiro сам по себе не даёт надёжного признака конца хода. Однако завершающий
`metadataEvent` может нести нативный `stopReason`, но Kiro иногда помечает `END_TURN` обычный текст
о прогрессе. Поэтому в ходе с инструментами такой текст остаётся commentary и проходит одну
проверку приватным инструментом завершения.

Путь совместимости может использоваться для `END_TURN`, `STOP_SEQUENCE` или отсутствующего stop reason. Любая другая явная причина уже
завершила вывод на стороне провайдера, поэтому адаптер сообщает о ней, а не отправляет ещё один
запрос: лимит выходных токенов становится продолжаемым incomplete, исчерпание контекстного окна —
неповторяемой ошибкой context-length, фильтрация и срабатывание guardrail — отфильтрованным
incomplete. `TOOL_USE` без фактического вызова инструмента трактуется как противоречие, а не прогресс.

В ходе с инструментами opencodex добавляет приватный `codex_kiro_final_answer`. Повторная попытка не
создаёт пустые assistant/user-сообщения, сохраняет исходный user/tool-result и перед отправкой проверяет
чередование ролей, непустые структурные сообщения и пары tool use/result. Ответ инструмента завершения
всегда выдаётся как `final_answer`, даже если он совпадает с предыдущим commentary.
Если продолжить нельзя без решения, сведений или уточнения, которые может дать только пользователь, контракт предписывает отправить этот вопрос через инструмент завершения и остановиться. Такой ход тоже приходит как `final_answer` с завершённым ходом, а не как commentary.

### Reasoning effort

`gpt-5.6-sol` и `claude-opus-5` поддерживают нативный effort, но называют поле запроса по-разному.
Значения `low` / `medium` / `high` / `xhigh` / `max` отправляются как
`additionalModelRequestFields.reasoning.effort` и `output_config.effort` соответственно.


## `cursor`

**Назначение:** по умолчанию `agent.v1.AgentService/Run` Cursor поверх потокового HTTP/2 Connect
на `api2.cursor.sh`. При `upstreamHttpVersion: "http1.1"` (или `"h1"`) используется совместимый
транспорт HTTP/1.1: `agent.v1.AgentService/RunSSE` для вывода сервера и
`aiserver.v1.BidiService/BidiAppend` для сообщений клиента. Эта настройка применяется и к
inference, и к live model discovery.
**Аутентификация:** Cursor OAuth/access token из `provider.apiKey` или из переданного заголовка
authorization.

- Использует `runTurn` вместо обычного пути fetch/parse. Запросы, серверные события, аргументы
  инструментов, контрольные точки использования и ответы клиента кодируются схемами
  `@bufbuild/protobuf` из `cursor/gen/agent_pb.ts` и оформляются как сообщения Connect.
- Воспроизводит состояние диалога через content-addressed blob'ы, отображает серверные вызовы
  инструментов обратно в Codex, обнаруживает актуальные модели Cursor через protobuf RPC
  `GetUsableModels` и повторяет попытки только до того, как run-запрос зафиксирован на wire.
- После успешно завершённого хода без инструментов хранит возвращённую ConversationStateStructure
  локально в процессе и повторно использует checkpoint для проверенного линейного продолжения. Ходы
  с результатом инструмента используют checkpoint последнего завершённого хода и только ещё не
  охваченный suffix, когда известна граница охваченных сообщений. Поиск по префиксу без ref разрешён
  только при наличии запомненного разговора Cursor или стабильного идентификатора client thread
  (включая ограниченный fallback по Desktop session/thread) и единственного совпадающего checkpoint,
  принадлежащего тому же разговору provider; иначе выполняется full replay. Compaction, изоляция
  helper/shadow, несовпадение account/model, отсутствие ref, ошибки decode, forced-fresh recovery и
  повтор после invalid_argument также используют full replay. Перезапуск процесса удаляет хранилище
  из памяти и приводит к full replay. Cursor Connect не предоставляет достоверный
  cache_read_tokens, поэтому usage OpenCodex не является счётчиком cache hit. Ограниченный Desktop
  fallback хранит только владельца, выведенного через HMAC локально в процессе; исходные заголовки
  session/thread и данные OAuth/authorization в checkpoint state не записываются. Live transport с
  OAuth и фильтрация live model discovery по аккаунту остаются экспериментальными. Настройки входа
  и transport описаны в [руководстве по провайдерам](/ru/guides/providers/) и
  [конфигурации провайдера Cursor](/ru/reference/configuration/providers/#cursor-provider-adapter-cursor).
  Повторное использование checkpoint выполняется автоматически и не имеет пользовательской настройки.
- Сохраняет `cursor/grok-4.5-fast` доступной для выбора, но отправляет Cursor каноническую модель
  `grok-4.5`, помещая отдельные значения `effort` и `fast=true` в `requested_model.parameters`.
- Нативное для Cursor локальное выполнение операций с файловой системой/shell/сетью по умолчанию
  запрещено. Явные интеграции `mcpServers` и `desktopExecutor` включаются отдельно;
  `nativeLocalExec: "on"` включает более широкий встроенный executor и обходит семантику
  одобрений/песочницы Codex; устаревший `unsafeAllowNativeLocalExec: true` эквивалентен только
  если `nativeLocalExec` не задан.

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
