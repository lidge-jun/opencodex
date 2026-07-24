---
title: Архитектура
description: Внутреннее устройство opencodex — карта модулей, мост AdapterEvent, парсер запросов и кэширование.
---

opencodex — это один процесс Bun. Запрос приходит как OpenAI Responses, нормализуется во
внутреннюю модель, маршрутизируется, отправляется провайдеру через адаптер и мостом
преобразуется обратно в Responses SSE. Сквозной поток описан в разделе
[Как это работает](/opencodex/ru/getting-started/how-it-works/).

## Карта модулей

```
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # seven wire adapters, shared guards/utilities, Cursor protobuf transport
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── usage/              # request usage extraction, JSONL logs, summaries, totals
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
├── vision/             # vision sidecar (describe + plan)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # AdapterEvent stream → Responses SSE / JSON
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

Три прежних крупных входных файла теперь служат фасадами совместимости: `codex/catalog.ts`
экспортирует семь модулей `codex/catalog/*.ts`, `server/management-api.ts` направляет запросы в
девять модулей `server/management/*.ts`, а `server/responses.ts` экспортирует пять модулей
`server/responses/*.ts`.

## Поток запроса

`server/index.ts` владеет HTTP-границей и делегирует плоскость данных Responses в
фасад `server/responses.ts` и его модули `server/responses/*.ts`:

1. `server/index.ts` применяет CORS и аутентификацию API, отклоняет новую работу во время
   завершения (drain) и записывает метаданные жизненного цикла запроса. Он обслуживает
   `GET /v1/models`, `POST /v1/responses`,
   `POST /v1/responses/compact`, `POST /v1/images/generations` / `POST /v1/images/edits`
   (ретранслируются модулем `server/images.ts` вышестоящему провайдеру семейства OpenAI для
   встроенного инструмента codex `image_gen`), `POST /v1/live` / `POST /v1/realtime/calls`
   (создание голосового/Realtime-вызова ChatGPT / Codex App, ретранслируется `server/live.ts`),
   sideband WebSocket на `/v1/live/{callId}`, а также необязательный WebSocket-апгрейд на
   `/v1/responses`.
2. `server/responses/core.ts` распаковывает и парсит JSON, разворачивает локально запомненный вход
   `previous_response_id`, когда он доступен, затем вызывает `responses/parser.ts`.
3. `router.ts` разрешает «голый» id или id вида `provider/model`. Затем сервер определяет
   привязку (affinity) аккаунта Codex, при необходимости обновляет OAuth провайдера и применяет
   выбранные учётные данные к маршруту.
4. Перед основным вызовом `vision/` описывает изображения для моделей из `noVisionModels`; если
   безопасного пути через сайдкар нет, изображения удаляются, а не отправляются текстовому
   вышестоящему провайдеру.
5. `server/adapter-resolve.ts` применяет переопределение wire-формата для конкретной модели и
   конструирует один из семи адаптеров. Passthrough Responses ретранслирует нативное тело, Cursor
   запускает свой двунаправленный транспорт `runTurn`, а транслирующие адаптеры выполняют
   build/fetch/parse запроса к вышестоящему провайдеру.
6. Для маршрутизируемых моделей с hosted-инструментом `web_search` модуль `web-search/`
   предоставляет синтетическую функцию, выполняет настоящий поиск через сайдкар ChatGPT,
   возвращает результаты маршрутизируемой модели и повторяет это в пределах настроенного лимита
   цикла.
7. `bridge.ts` формирует Responses SSE или JSON. `server/request-log.ts` и `usage/` собирают
   итоговый статус, задержку, метки провайдера/модели и оценку использования токенов, не изменяя
   ответ.

## Парсер

`responses/parser.ts` валидирует входящий запрос через `responses/schema.ts` (Zod), затем строит
`OcxParsedRequest`:

- **Сообщения** — элементы `input` становятся нормализованным `OcxMessage[]`: user / developer /
  assistant / toolResult. Элементы `reasoning` становятся блоками thinking; элементы
  `function_call`, `custom_tool_call` и `tool_search_call` становятся вызовами инструментов; их
  аналоги `*_output` становятся результатами инструментов.
- **Инструменты** — function-инструменты проходят как есть; **инструменты с пространствами имён
  (MCP) сплющиваются** в `namespace__name` (и восстанавливаются на обратном пути);
  **freeform**-инструменты (например, `apply_patch`) и discovery-инструменты **tool_search**
  помечаются флагами; **hosted-инструменты** (`web_search`, генерация изображений, …)
  отбрасываются и повторно внедряются сайдкаром только если он будет их обрабатывать.
- **Изображения** — сохраняются как настоящие части контента (data URL или удалённый https),
  никогда не встраиваются как текст.
- **Флаги возможностей** — `_webSearch` (запрошен hosted-веб-поиск), `_structuredOutput`
  (`text.format` — json_schema / json_object) и `_compactionRequest` (remote compaction v2).

## Мост

`bridge.ts` превращает поток внутренних событий `AdapterEvent` адаптера обратно в Responses SSE,
понятный Codex:

| AdapterEvent | Responses SSE emitted |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`, `response.content_part.done`, `response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`, закрытие элемента |
| `reasoning_raw_delta` | «Сырой» элемент `reasoning_text` (или скрытый round-trip-конверт) |
| `thinking_signature` / `redacted_thinking` | Сохраняются в reasoning-конверте `encrypted_content` |
| `tool_call_start` | `response.output_item.added` (type: `function_call` / `custom_tool_call` / `tool_search_call`) |
| `tool_call_delta` | `response.function_call_arguments.delta` (пропускается для freeform / tool_search) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `web_search_call_begin` / `web_search_call_end` | Один живой элемент `web_search_call` плюс URL-цитаты |
| `heartbeat` | Отмечает активность вышестоящей стороны; видимого пользователю выходного элемента нет |
| `done` | `response.completed` (с usage) |
| `error` | `response.failed` (с `last_error`) |

Мост также выполняет **heartbeat keep-alive** (RC3): пока вышестоящая сторона молчит, он каждые
2 секунды генерирует игнорируемое парсером SSE-событие `response.heartbeat`, чтобы перезапускать
таймер простоя Codex. **Дедлайн зависания** по умолчанию — 300 секунд (`stallTimeoutSec`); по его
достижении запрос к вышестоящей стороне прерывается и генерируется `response.incomplete` с
причиной `upstream_stall_timeout`, что не даёт зависшему соединению блокировать Codex бесконечно.

Вызовы инструментов различаются между тремя типами элементов Responses с помощью карты
пространств имён, множества freeform и множества tool-search, зафиксированных парсером — поэтому
пространства имён MCP, freeform-инструменты в стиле `apply_patch` и исполняемый клиентом
`tool_search` корректно проходят полный круговой путь. Вариант `buildResponseJSON()` строит один
непотоковый объект ответа из тех же событий.

## Management API, OAuth и использование

`server/management-api.ts` обслуживает дашборд и направляет специализированные группы маршрутов в
`server/management/*.ts`. Его маршруты `/api/*` покрывают безопасные
конфигурацию/настройки, CRUD провайдеров и пулы ключей, выбор моделей/лимиты контекста/управление
v2, синхронизацию каталога, диагностику и отладочные логи, использование и квоты, настройки
сайдкаров, обновления, сгенерированные клиентские API-ключи, вход/статус/выход OAuth и выбор
аккаунта, управление аккаунтами Codex и корректную остановку. `server/auth-cors.ts` требует
`OPENCODEX_API_AUTH_TOKEN` и для `/api/*`, и для `/v1/*`, когда прокси привязан за пределами
loopback; настроенные записи `corsAllowOrigins` расширяют allowlist локальных origin.

Реализации OAuth живут в `oauth/`; access-токены загружаются или обновляются непосредственно
перед маршрутизируемым вызовом, а `oauth/token-guardian.ts` может проактивно обновлять только тех
провайдеров, чья политика это разрешает. Учётные данные пула Codex/ChatGPT и привязка потоков
живут в `codex/` и не попадают в ответы management API. Использование по запросам нормализуется в
`OcxUsage`, отражается в терминальных событиях Responses и агрегируется модулем `usage/` для
дашборда и необязательной JSONL-диагностики.

## Транспорт и compaction

`server/index.ts` по умолчанию обслуживает HTTP/SSE на `/v1/responses`. Если Codex пытается
выполнить WebSocket-апгрейд Responses, пока `websockets` равно `false`, opencodex возвращает
`426 upgrade_required`; Codex тогда откатывается на HTTP для этой сессии. Когда установлено
`"websockets": true`, та же конечная точка принимает апгрейд и использует WebSocket-мост.

Compaction контекста Codex работает для маршрутизируемых моделей. `server/responses/compact.ts`
обрабатывает `POST /v1/responses/compact`, выполняя внутренний маршрутизируемый ход суммаризации
и возвращая сжатую историю, а `responses/parser.ts` и `bridge.ts` обрабатывают ходы
`compaction_trigger` из remote compaction v2, генерируя ровно один синтетический выходной элемент
`compaction`.

## Кэширование и каталог

- `codex/model-cache.ts` держит в памяти TTL-кэш живых результатов `/models` для каждого
  провайдера (по умолчанию 5 минут, как у собственного кэша Codex) с откатом на устаревшие данные
  при неудачном запросе.
- `codex/catalog/sync.ts`, экспортируемый через фасад `codex/catalog.ts`, сливает маршрутизируемые
  модели в каталог Codex как записи с пространствами
  имён, ставит рекомендуемые
  [модели подагентов](/opencodex/ru/guides/codex-integration/#the-subagent-picker) первыми,
  фильтрует `disabledModels` и может полностью восстановить первозданный каталог из одноразовой
  резервной копии.

## Reasoning effort

`reasoning-effort.ts` транслирует метки рассуждений Codex в wire-значения каждого провайдера.
Каталог Codex объявляет метки, которые принимает Codex (`low` / `medium` / `high` / `xhigh` /
`max`), но вышестоящие провайдеры могут поддерживать лишь меньшее подмножество или требовать
настоящий alias. Модуль:

- Определяет канонические `CODEX_REASONING_LEVELS` и их порядок сортировки.
- Прижимает запрошенный уровень к ближайшей поддерживаемой ступени, когда точный уровень
  недоступен.
- Разрешает переопределения `reasoningEffortMap` на уровне модели и провайдера для нестандартных
  wire-отображений.
- Полностью убирает уровень для моделей, перечисленных в `noReasoningModels`.

## Основные типы

Внутренняя модель живёт в `types.ts`: `OcxParsedRequest`, `OcxContext`, объединение `OcxMessage`,
`OcxContentPart` (text / image), `OcxToolCall`, `OcxTool`, `AdapterEvent` и типы конфигурации
(`OcxConfig`, `OcxProviderConfig`). Широко используются два хелпера: `namespacedToolName()` и
`modelInList()` (толерантное сопоставление с тегом `:size` для `noVisionModels` /
`noReasoningModels`).
