---
title: Форматы API прокси
description: Справочник протокольного уровня для Responses, Chat Completions, Anthropic Messages, каталога моделей, WebSocket, Realtime и компактизации.
---

opencodex предоставляет один локальный прокси сразу в нескольких клиентских диалектах. Клиент
Codex может говорить на Responses API, OpenAI-совместимое приложение — на Chat Completions, а
Claude Code — на Anthropic Messages, при этом от каждого upstream-провайдера не требуется
реализовывать все эти форматы.

Обычный путь преобразования такой:

```text
client dialect → internal Responses model → provider adapter → provider wire format
provider events → internal adapter events → client dialect
```

Представление Responses — центр этого моста. Нативно совместимые маршруты могут пропускать части
перевода и передавать запрос дальше почти как есть, но аутентификация, routing, admission
control и safety ответа всё равно происходят на границе прокси. Listener и admission key
настраиваются в [Конфигурации](/reference/configuration/); если один публичный id модели должен
выбирать между несколькими целями, используйте [Combos](/guides/combos/).

## Обзор endpoint'ов

| Клиентская поверхность | Endpoint | Успешный non-stream результат | Успешный результат потока или сокета |
| --- | --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses JSON | Responses SSE или текстовые Responses JSON frame'ы по WebSocket |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `chat.completion` JSON | `chat.completion.chunk` SSE, заканчивающийся `[DONE]` |
| Anthropic Messages | `POST /v1/messages` | Anthropic `message` JSON | Anthropic Messages SSE |
| Подсчёт токенов Anthropic | `POST /v1/messages/count_tokens` | `{ "input_tokens": number }` | Не применяется |
| Обнаружение моделей | `GET /v1/models` | Один из трёх контрактов каталога | Не применяется |
| Голос и Realtime | `POST /v1/live`, `POST /v1/realtime/calls` | Ответ создания вызова после ретрансляции | Отдельный sideband WebSocket ретранслирует frame'ы в обе стороны |
| Компактизация Responses | `POST /v1/responses/compact` | JSON истории-замены | Не применяется |

## `POST /v1/responses`

Это нативная форма data plane для opencodex. Тело запроса должно быть JSON-объектом с непустым
`model`. Поле `input` может быть строкой или массивом Responses item'ов.

### Разрешённые поля запроса

| Область | Допустимая форма |
| --- | --- |
| Модель и ввод | Обязательный непустой `model`; необязательный строковый `input` или массив item'ов |
| Элементы сообщений | Сообщения `user`, `developer`, `system` и `assistant`; строковое содержимое или типизированные content-блоки, допустимые для этой роли |
| Блоки содержимого | Текст, входные изображения, входные файлы, выходной текст, отказы и блоки сводки/текста рассуждений там, где их допускает родительский item |
| История инструментов | Item'ы `function_call`, `function_call_output`, `custom_tool_call` и `custom_tool_call_output` |
| Инструменты | Function tool'ы плюс свободные built-in или hosted tool entry; `tool_choice` принимает `auto`, `none`, `required`, именованные function/custom choice, hosted choice или `allowed_tools` |
| Рассуждения | `reasoning.effort` и `reasoning.summary` (`auto`, `concise`, `detailed` или `none`) |
| Продолжение и кэширование | `previous_response_id`, `store` и `prompt_cache_key` |
| Управление генерацией | `max_output_tokens`, `temperature`, `top_p`, `stop`, `presence_penalty` и `frequency_penalty` |
| Сервис и исполнение | `stream`, `service_tier`, `parallel_tool_calls`, `instructions`, `metadata` и `user` |
| Расширенные поля Responses | `background`, `include`, `prompt`, `text` и `truncation` принимаются на совместимых маршрутах |

Неизвестные типы item'ов принимаются как свободные typed-item'ы для forward compatibility.
Translated-adapter'ы обрабатывают только известные им типы и могут отвергнуть функцию, которую
их провайдер не умеет выразить.

### JSON и SSE-вывод

При `stream: true` ответ идёт как `text/event-stream`. Мост испускает события Responses вроде
`response.created`, delta-события для output item'ов и текста/tool'ов, а также ровно одно
терминальное событие `response.completed`, `response.failed` или `response.incomplete`. Обычный
поток заканчивается `data: [DONE]`.

При `stream: false` или при отсутствии `stream` те же события адаптера собираются в один JSON
Responses. Обе формы сохраняют выбранную модель, output item'ы, terminal status и usage.

Клиентские frame'ы Responses SSE ограничены 4 MiB на frame, считая сырые байты до разделителя SSE-блока. В HTTP незавершённый upstream-frame, превысивший этот предел, завершается fail-closed синтетическим событием `response.failed`, после которого идёт `data: [DONE]`. В мосте Responses WebSocket то же условие даёт 502 `websocket_protocol_error` и отменяет upstream-reader. Если полноценный terminal-frame Responses уже получен, он остаётся авторитетным: слишком большие или некорректные байты после него отбрасываются и не заменяют завершённый ход транспортной ошибкой.

Каждый terminal usage-объект Responses всегда включает оба detail-объекта, даже если провайдер их
не сообщил:

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

Когда данные есть, `input_tokens_details` может также содержать `cache_write_tokens`. Эти detail
объекты присутствуют всегда ради совместимости со strict-клиентами Responses; ноль может означать
«не сообщено», а не обязательно «провайдер такой работы не делал».

### WebSocket-upgrade на том же пути

Когда включён `websockets`, клиент может выполнить upgrade для `/v1/responses`, а не открывать
HTTP POST. Аутентификация и origin admission происходят во время WebSocket-handshake и не
повторяются внутри каждого frame'а.

Клиент отправляет текстовые JSON-frame'ы:

```json
{
  "type": "response.create",
  "model": "provider/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

Всё, кроме `type`, становится телом Responses-запроса, а proxy принудительно включает streaming
для этого хода. Новый `response.create` отменяет и вытесняет предыдущий ход на этом socket'е.
`response.processed` принимается как no-op acknowledgement. Неразбираемые frame'ы и посторонние
типы игнорируются.

Серверные frame'ы — это текстовые JSON-frame'ы. Успешный streamed-output использует те же JSON
payload'ы, которые появились бы в строках SSE `data:`, только без SSE-обёртки и без `[DONE]`.
Не-streaming внутренний результат переупаковывается в `response.created`, затем идёт ноль или
больше frame'ов `response.output_item.done`, после чего следует terminal frame. Ошибки используют
такую форму:

```json
{
  "type": "error",
  "status": 502,
  "error": {
    "type": "upstream_error",
    "message": "..."
  },
  "headers": {}
}
```

Warmup-frame с `generate: false` upstream не вызывает. Он возвращает синтетические
`response.created` и `response.completed` с пустым response id и без output.

:::note
Когда WebSocket отключён, попытка upgrade получает HTTP 426 с кодом `upgrade_required`. Codex
трактует результат такого handshake как сигнал откатиться к HTTP для этой сессии. Это не сбой
хода модели.
:::

## `POST /v1/chat/completions`

Этот endpoint принимает OpenAI-совместимые запросы Chat Completions с обязательным `model` и
непустым массивом `messages`. Он переводит system-, user-, assistant- и tool-сообщения во
внутренние Responses item'ы; переводит function tool'ы, tool choice, изображения, reasoning effort
и поддерживаемые response format'ы; запускает обычный pipeline маршрутизации Responses; а затем
переводит результат обратно.

Не-streaming output имеет `object: "chat.completion"`. Streaming-вывод идёт как SSE-объекты с
`object: "chat.completion.chunk"`, delta'ами choice, terminal choice с `finish_reason` и
`data: [DONE]`. Информация о tool call'ах и usage тоже переводится обратно там, где её несут
исходные события.

Поскольку внутренний путь исполнения основан на Responses, adapter провайдера может сузить
поддерживаемый набор функций. Например, если feature запроса нельзя выразить через выбранный
adapter, вместо тихого изменения смысла вернётся ошибка.

## `POST /v1/messages` и `count_tokens`

Эти endpoint'ы говорят на диалекте Anthropic Messages, который используют Claude Code и совместимые
клиенты. Большинство запросов переводится в Responses, маршрутизируется обычным образом, а затем
обратно в Anthropic JSON или Anthropic SSE.

Нативный Anthropic passthrough допустим только когда одновременно выполняются все условия:

- native passthrough не отключён в конфигурации Claude Code;
- запрошенная модель начинается с `claude` или `anthropic`;
- запрос несёт нативный bearer Anthropic или `x-api-key`;
- на non-loopback listener запрос также несёт валидный proxy admission только в
  `x-opencodex-api-key`; и
- ни один alias или model map не забирает этот model id в routed-цель.

Если запрос подходит, он пересылается в Anthropic dialect, и нативные beta-header'ы, thinking
signature'ы и subscription identity проходят сквозь систему end to end. В противном случае запрос
идёт через round-trip Responses.

Dedicated admission-header никогда не пересылается. Proxy admission secret в `Authorization` или
`x-api-key` также удаляется, а отдельный настоящий credential Anthropic сохраняется. Неоднозначные
credential-заголовки, объединённые запятыми, завершаются fail closed.

`POST /v1/messages/count_tokens` использует те же правила разрешения модели и то же решение о
passthrough. Native-eligible-запрос пересылается в count-endpoint Anthropic. Для остальных запросов
используется локальная документированная оценка по system content, messages и tools, и
возвращается:

```json
{ "input_tokens": 123 }
```

## `GET /v1/models`

Один и тот же маршрут обслуживает три клиента, ожидающих несовместимые envelope'ы каталога.
Форма Anthropic имеет приоритет, если только одновременно не присутствует `client_version`.

| Контракт | Триггер | Форма верхнего уровня | Поведение id модели |
| --- | --- | --- | --- |
| Список моделей Anthropic | Заголовок `anthropic-version` или `?flavor=anthropic`, без `client_version` | `{ "data": [...] }` с Anthropic model-info entry | Claude Code получает читаемые id; Desktop может получать семейство alias'ов, специфичное для профиля |
| Каталог Codex | Query-параметр `client_version` | `{ "models": [...] }` | Нативные и маршрутизируемые записи несут более богатые поля каталога Codex: visibility, effort, WebSocket и multi-agent metadata |
| Обычный список OpenAI | Ни один триггер не сработал | `{ "object": "list", "data": [...] }` | Видимые native-id идут без префикса; routed-id — как alias или `provider/model` |

## `POST /v1/live` и Realtime sideband

`POST /v1/live` принимает surface Frameless call-creation из ChatGPT/Codex App.
`POST /v1/realtime/calls` принимает surface call-creation OpenAI Realtime. opencodex выбирает
подходящий маршрут семейства OpenAI, нормализует запрос call-creation под нужный режим
upstream-аутентификации и ретранслирует ограниченный ответ.

После создания call клиент может подключиться к sideband WebSocket в любой поддерживаемой входной
форме:

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

Proxy нормализует upstream-join URL и затем прозрачно ретранслирует text- и binary-frame'ы в обе
стороны. Клиентские protocol-header'ы сохраняются, а upstream-аутентификацией владеет сам прокси.

## `POST /v1/responses/compact`

Compaction возвращает replacement history для клиентов, которым нужно сократить длинный Responses
conversation.

| Тип маршрута | Поведение |
| --- | --- |
| Canonical ChatGPT или официальный маршрут OpenAI | Пересылает запрос в нативный endpoint `/responses/compact` с разрешённым аккаунтом и model-authentication |
| Любая другая routed-модель | Запускает внутренний, не-streaming, без-tool'овый compaction-turn с `compaction_trigger`; требует ровно один синтетический item `compaction`, чей `encrypted_content` — это envelope `ocx1:`; затем декодирует это summary обратно в replacement history v1 |

Нативные compact-ответы буферизуются с максимумом 32 MiB, включая ответы, у которых один только
заявленный `Content-Length` уже превышает лимит. Для compaction есть такие специфические ошибки:

| Статус | Тип или код | Значение |
| --- | --- | --- |
| 400 | `invalid_request_error` | Некорректная форма JSON/body или отсутствует модель |
| 404 | `invalid_request_error` | Запрошенную модель нельзя маршрутизировать |
| 499 | `client_cancelled` | Клиент отменил запрос во время forwarding или buffering |
| 502 | `compact_response_too_large` | Нативный compact-output превысил 32 MiB |
| 502 | `upstream_error` | Сбой соединения, чтения или synthetic compaction-turn |
| 502 | `invalid_response_error` | Synthetic-turn не создал ровно один корректный непустой item compaction `ocx1:` |

## Матрица аутентификации

На bind'е только для loopback data-plane admission не требует настроенного ключа. На удалённой
привязке используйте матрицу ниже. «Dedicated» означает `X-OpenCodex-API-Key`; остальные столбцы —
это `Authorization: Bearer ...` и `x-api-key`.

| Поверхность | Выделенный | Bearer | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP и WebSocket | Обязателен | Отклоняется для proxy-admission | Отклоняется |
| `/v1/responses/compact` | Обязателен | Отклоняется для proxy-admission | Отклоняется |
| `/v1/chat/completions` | Обязателен | Отклоняется для proxy-admission | Отклоняется |
| `/v1/messages` и `/v1/messages/count_tokens` | Принимается | Принимается | Принимается |
| `/v1/models` | Принимается | Принимается | Принимается |
| `/v1/live`, `/v1/realtime/calls` и sideband-join'ы | Принимается | Принимается | Принимается |

Responses-family и Chat-запросы резервируют `Authorization` под passthrough провайдера или Codex
Direct, поэтому remote proxy key здесь обязан идти через dedicated-заголовок. Surface'ам Messages
и Realtime нужна более широкая совместимость с клиентами, поэтому там принимаются все три формы.

:::caution
Ключи data plane — это не management credentials. У management API свой отдельный admin-secret;
см. [Management API](/reference/management-api/). Никогда не используйте один и тот же секрет и
для plane данных, и для control plane.
:::

## Общий словарь ошибок

Когда это нужно, ошибки используют envelope клиентского диалекта, но значения status/code
остаются стабильными:

| Статус | Тип или код | Значение |
| --- | --- | --- |
| 401 | `authentication_error` | Отсутствует обязательный credential для proxy-admission или он неверен |
| 403 | `origin_rejected` | Data-plane запрос или WebSocket-upgrade Responses/OpenAI пришёл с запрещённого origin |
| 503 | `combo_unavailable` | Все цели выбранной combo недоступны, в cooldown, отключены или иным образом не подходят |
| 400 | `unreadable_encrypted_agent_task` | У шифрованной задачи воркера v2 нет подходящей нативной цели ChatGPT, способной её прочитать |
| 426 | `upgrade_required` | Транспорт Responses WebSocket выключен или upgrade не удался; используйте HTTP |

Сбои, пришедшие с Anthropic-side, отрисовываются в error envelope Anthropic, поэтому отклонение
origin превращается в 403 `permission_error`, а не в OpenAI-style body `origin_rejected`.

## Гигиена `encrypted_content`

Proxy относится к подлинному ciphertext backend'а как к непрозрачным данным. Структурно валидный
ciphertext сохраняется байт в байт: opencodex его не расшифровывает, не переводит содержимое и не
перешифровывает для другого провайдера.

Исторически некоторые agent hook'и клали plaintext control text в слот `encrypted_content`. Ради
совместимости proxy отделяет такой plaintext в текстовые части, сохраняя нетронутыми все
структурно валидные фрагменты Fernet. Если после такой починки у `agent_message` не остаётся ни
одной шифрованной части, сообщение становится обычным user-message. Если текущая задача v2
остаётся по-настоящему зашифрованной, а выбранная routed-цель не умеет читать ciphertext нативного
ChatGPT, opencodex завершит запрос ошибкой `unreadable_encrypted_agent_task`, вместо того чтобы
отправить нечитаемые байты этому провайдеру. О поведении клиента вокруг worker-task'ов см.
[Поверхность подагентов](/guides/sub-agent-surface/).
