---
title: Конфигурация сервера и рантайма
description: Listener, удалённый доступ, admission key, таймауты, storage, sidecar'ы, shadow call'ы и startup behavior.
---

Настройки сервера управляют тем, как локальный прокси слушает сеть, защищает удалённый трафик,
распоряжается ресурсами и запускает вспомогательные функции вокруг provider-request'ов.

## Поля сервера

| Поле | Тип | По умолчанию | Значение |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Порт, который слушает прокси. |
| `hostname?` | `string` | `"127.0.0.1"` | Адрес bind'а. Не-loopback bind требует `OPENCODEX_API_AUTH_TOKEN`. |
| `proxy?` | `string` | — | URL исходящего HTTP(S) или SOCKS5-прокси (`socks5://host:port`) или `${ENV_VAR}`. HTTP URL пишутся в `HTTP_PROXY` / `HTTPS_PROXY`, если те не заданы. SOCKS5 используют встроенный SOCKS5-туннель и также пишутся в `ALL_PROXY` (`ocx start --socks5`); унаследованные `HTTP(S)_PROXY` сбрасываются в этом процессе. Loopback всегда остаётся в `NO_PROXY`. |
| `emptyCompletionRetry?` | `boolean` | `false` | Явно включает один идентичный повтор Responses, если в turn нет ни текста, ни tool call, включая случай, когда stream завершается до terminal event. Повтор может тарифицироваться. `OCX_EMPTY_COMPLETION_RETRY=0` отключает его без изменения config; combo и routed-compaction turn исключены. |
| `dropCodexSafetyBuffering?` | `boolean` | `false` | Удаляет подсказки Codex safety-buffering из passthrough-ответов Codex Responses: заголовки `x-codex-safety-buffering-enabled` / `x-codex-safety-buffering-faster-model`, SSE-события `response.metadata` типа `safety_buffering` и поле `safety_buffering` в других SSE-событиях. Codex TUI отображает их как предложение повторить запрос с более быстрой моделью, действие по умолчанию в котором переключает сессию на более слабую модель. Остальные заголовки `x-codex-*` и содержимое других SSE-событий передаются без изменений, кроме удаления этого поля. По умолчанию выключено. |
| `stallTimeoutSec?` | `number` | `300` (public) / выкл. (local) | Секунды без полезного прогресса upstream (Responses и нативный Chat) до обрыва потока. Без настройки **локальный** upstream (loopback, private, имя `.local`/`.lan`) по умолчанию выключен, публичный — 300 с; положительное значение действует на оба (минимум 1 с); `0` отключает watchdog тишины везде. Для Responses, которые сворачивают canonical ChatGPT SSE в непотоковый JSON, даже при выключенном watchdog остаётся отдельный общий предел 15 минут. Ожидающие чтения тела `/v1/responses/compact` используют этот же бюджет, но по умолчанию 300 с даже для локального upstream; явное значение, включая `0`, имеет приоритет. |
| `connectTimeoutMs?` | `number` | `200000` | Дедлайн одной попытки DNS/TCP/TLS/final-header; он завершается до генерации тела ответа. |
| `shutdownTimeoutMs?` | `number` | `5000` | Дедлайн graceful-drain до принудительного прерывания активных turn'ов. |
| `websockets?` | `boolean` | `false` | Объявляет и разрешает клиентский WebSocket-путь Responses. При false клиенты используют HTTP/SSE; это не отключает подходящую upstream WS-оптимизацию canonical ChatGPT. |
| `corsAllowOrigins?` | `string[]` | `[]` | Дополнительные точные origin, разрешённые CORS. Loopback-origin разрешены всегда. Поддерживаются authority-based origin браузерных расширений, например `chrome-extension://<extension-id>`; `*` не является маской. Firefox и Safari пересоздают UUID расширения (при каждой установке/запуске браузера), поэтому обновляйте запись при смене origin. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Сгенерированные credentials `ocx_…` для data-plane admission на не-loopback bind'ах. Они не авторизуют management API; доступ к management использует отдельный credential, описанный в [management reference](/ru/reference/management-api/). Управляются через дашборд. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | disabled | Opt-in policy очистки архивированных сессий. Никогда не включается неявно. |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | Лимит в MiB для eviction-friendly app-owned log'ов, cache'ей, blob'ов и continuation payload'ов. Это не RSS-cap. Диапазон 64–4096. |
| `metricsExport.enabled?` | `boolean` | `false` | Включает локальные для процесса агрегированные метрики запросов на аутентифицированном `GET /api/metrics`. Требуется перезапуск; в выключенном состоянии маршрут возвращает 404 и экспортёр не запускает никакой активности. |
| `codexAutoStart?` | `boolean` | `true` | Разрешает shim'у Codex запускать `ocx ensure` перед стартом Codex. При false `ensure` становится no-op. |
| `codexShimAutoRestore?` | `boolean` | `true` | Восстанавливает установленный shim после завершённого внешнего обновления Codex, которое заменило его. Для отключения через окружение: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `syncResumeHistory?` | `boolean` | `true` | Обратимый режим совместимости истории Codex App. Исходные metadata резервируются и восстанавливаются через `ocx stop` / `ocx restore`. |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | off | Перенаправляет распознанные helper/shadow-call'ы Codex на выбранную модель с сохранением настроенного для запроса reasoning effort. Source-prefix по умолчанию: `gpt-6-luna`, `gpt-5.6-luna`; клиенты до 0.144.x включительно использовали `gpt-5.4-mini`, который можно восстановить через `sourceModels`. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on when usable | Настройки sidecar'а web-search. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on when usable | Настройки sidecar'а описания изображений. |
| `images?` | `OcxImagesConfig` | automatic OpenAI selection | Настройки standalone Images relay для Codex `image_gen`. |

Если более старая development-сборка изменила metadata resume-history до появления резервного
backup'а, выполните `ocx recover-history --legacy-openai --yes`, чтобы принудительно вернуть
native-provider history.
Команда переименовывает все строки `opencodex` с пользовательским сообщением, включая корректную историю выделенного провайдера; перед запуском прочитайте предупреждение о полном охвате в справочнике lifecycle.

### Тайм-ауты и завершение нативного Chat

Нативный Chat также использует `stallTimeoutSec` при ожидании вывода upstream. Непустой текст, рассуждения, отказ, обновления инструментов и события завершения обновляют время ожидания; комментарии keepalive, только роль и только статистика использования его не обновляют. Ожидание чтения медленным клиентом приостанавливает отсчёт. При зависании возникает `upstream_stall_timeout`: событие ошибки для потокового клиента или HTTP 502 без потоковой передачи. Отмена до конечного результата возвращает ошибку отмены вместо успешного частичного ответа. Непотоковый Chat поддерживает SSE с LF, CRLF и многострочными полями data.

## Удалённый доступ

По умолчанию bind `127.0.0.1` доступен только на loopback. Не-loopback-адрес, например
`0.0.0.0`, требует token-auth и для `/api/*`, и для data plane. Экспортируйте токен перед стартом:

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

Без этой переменной прокси откажется подниматься на удалённом bind'е. Для фоновой службы
экспортируйте её до `ocx service install`, чтобы launchd, systemd или Task Scheduler получили
значение. Затем клиенты должны отправлять:

```text
x-opencodex-api-key: your-secret-token
```

| Эндпоинт | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | not accepted | **required** | not accepted |
| `/v1/chat/completions` | not accepted | **required** | not accepted |
| `/v1/messages` | accepted | accepted | accepted |
| `/v1/messages/count_tokens` | accepted | accepted | accepted |
| `/v1/models` | accepted | accepted | accepted |

Responses и Chat Completions резервируют `Authorization` под возможный passthrough Codex Direct,
поэтому там принимается только dedicated admission-header. Сгенерированные в дашборде `apiKeys`
могут после старта заменить env-token; сравнение кандидатов выполняется constant-time.

Messages и `count_tokens` ради совместимости routed-клиентов по-прежнему принимают все три формы admission. Но на
non-loopback bind нативный passthrough Anthropic принимает proxy admission только через
`x-opencodex-api-key`, а `Authorization` и `x-api-key` резервирует под credentials Anthropic.
Proxy admission secret в этих provider-заголовках удаляется перед пересылкой.

:::caution[Экспозиция в LAN]
Bind на `0.0.0.0` открывает прокси и доступ к настроенным провайдерам всей локальной сети.
Используйте его только в доверенных сетях и только с сильным токеном.
:::

### Проброс порта по SSH

Для удалённого использования удалённый bind не обязателен. Сохраняйте loopback и пробрасывайте его:

```bash
ssh -L 20100:localhost:10100 you@remote
```

Локальный порт может быть любым. Если Host в запросе разрешается в `localhost`, `127.0.0.1` или
`::1`, то запрос остаётся loopback-независимо от порта, так что `http://localhost:20100/v1`
работает. Укажите этот base URL клиенту; сам `ocx` продолжает записывать в managed client config
только стандартный локальный адрес `127.0.0.1`.

OAuth-callback провайдера слушает на фиксированном remote-port'е. Логиньтесь на удалённой машине
или пробрасывайте и этот порт:

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

:::caution[Проброшенный loopback не аутентифицируется]
Обычный `ssh -L` слушает на вашем локальном loopback и безопасен для bind'а по умолчанию, который
не требует аутентификации. Не используйте `ssh -g -L`, широкую публикацию контейнера или режимы
проброса, которые открывают клиентскую сторону на `0.0.0.0`. Если сомневаетесь, явно указывайте
`ssh -L 127.0.0.1:20100:localhost:10100`.
:::

## Очистка storage

`storageCleanupPolicy` по умолчанию отключена. Когда её включают, она запускается на `startup`,
`daily`, `weekly` или `manual` после того, как объём архивов превысит
`trigger.archivedBytesOver`. Затем она выбирает самые старые архивы до достижения либо
`target.reduceToBytes`, либо `target.removeOldestPercent`. `mode` по умолчанию равен
`quarantine`; `permanent` используйте только как явно destructive-вариант. Policy хранит `lastRun`
и `nextRun`. Настраивается на странице Storage или через `GET`/`PUT /api/storage/cleanup-policy`;
ручной запуск выполняется `POST /api/storage/cleanup-policy/run`.

## Claude Code (`claudeCode`)

Эти настройки управляют `/v1/messages`, `/v1/messages/count_tokens`, launcher'ом `ocx claude` и страницей Claude в дашборде.

| Ключ | Тип | По умолчанию | Описание |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | Бюджет бездействия тела ответа в режиме native-passthrough, в секундах, пока чтение ждёт данные; это не общий лимит длительности. Минимум 1; ровно `0` отключает. |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | Совокупный лимит native-passthrough тела для stream- и buffered-ответов. Ровно `0` отключает. |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | auto | Как launcher управляет `ANTHROPIC_AUTH_TOKEN`. Auto каждый запуск заново определяет auth; явно заданное значение не переопределяется. |
| `claudeCode.authModeMigratedAt?` | `string` | unset | Внутренний одноразовый маркер миграции. Не задавайте вручную. |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | inherit | Effort, записываемый в сгенерированные `~/.claude/agents/ocx-*.md`; это отдельно от guidance Codex и proxy cap'ов. Чтобы перегенерировать файлы, перезапускайте через `ocx claude`. |

Авто-режим аутентификации выбирает subscription, если найдена сохранённая auth Claude, proxy —
если auth нет, и subscription с предупреждением, если детектировать однозначно не удалось. См.
[режим аутентификации Claude Code](/guides/claude-code/#auth-mode).

## Shadow call'ы

Codex использует маленькие helper-model'и для задач вроде заголовков и commit message. Включите
`shadowCallIntercept`, чтобы перенаправлять распознанные `sourceModels` на другую настроенную
модель. Замещающая модель сохраняет настроенный для запроса reasoning effort. `sourceModels` задавайте только если клиент
использует другие helper-id.

Перехват определяется моделью: любой запрос, чей полный идентификатор модели совпадает с `sourceModels`, включая обычные запросы с `request_kind: "turn"`, может быть перенаправлен. Запросы, помеченные как порождённые дочерние через `x-openai-subagent: collab_spawn` или `subagent_kind: "thread_spawn"` в JSON-заголовке `x-codex-turn-metadata`, освобождаются от перехвата, поэтому явно порождённый субагент сохраняет свою модель.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-6-luna", "gpt-5.6-luna"]
  }
}
```

### Когда цель недоступна

Замена — это единственная точка назначения, выбранная оператором, поэтому цель, которая перестала разрешаться, приводит к ошибке вспомогательного вызова, а не к отправке в другое место. Если провайдер цели отключён или удалён либо её комбо больше не существует, перехваченный запрос возвращает `409` с кодом ошибки `intercept_target_unavailable` до какой-либо отправки в апстрим. Журнал запросов записывает тот же код. Запрос не передаётся нативной вспомогательной модели и не уходит к провайдеру по умолчанию: и то и другое сменило бы точку назначения, учётные данные и стоимость без вашего выбора. Цель-комбо или цель профиля маршрутизации по-прежнему переключается между своими участниками. Полная цель вида `provider/model`, у которой часть провайдера не указывает ни на что настроенное, обрабатывается так же, и API настроек отказывается её сохранять. Голый идентификатор модели, разрешаемый через провайдера по умолчанию, остаётся допустимым.

Отключение (`PATCH /api/providers?name=<provider>` с `disabled: true`) или удаление провайдера, к которому разрешается цель, по-прежнему выполняется успешно; в ответ добавляется `dependentShadowIntercept: { model, enabled }`, а панель показывает предупреждение. Повторное включение провайдера или выбор другой цели восстанавливает перехват.

## Sidecar'ы

### `images` (`OcxImagesConfig`)

| Поле | Тип | По умолчанию | Значение |
| --- | --- | --- | --- |
| `provider?` | `string` | automatic OpenAI selection | Явный custom API-key провайдер `openai-responses` для `/v1/images/generations` и `/v1/images/edits`. Registry-managed id отклоняются. |
| `timeoutMs?` | `number` | `300000` | Полный таймаут одного standalone Images-запроса. |

Явный выбор закрывается с ошибкой, если провайдер отсутствует, отключён, несовместим или не имеет
рабочего ключа; fallback на другой платный upstream здесь невозможен. Endpoint должен
реализовывать OpenAI Images API-path'и и форму ответа, которую ожидает Codex.

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| Поле | Тип | По умолчанию | Значение |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | Главный переключатель. При `false` OpenCodex перестаёт перехватывать `web_search`, а интеграция Codex записывает `web_search = "disabled"` в `~/.codex/config.toml`. |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | Явный выбор выигрывает; отсутствие значения всегда означает `openai`. `anthropic` и `xai` запускаются только при явной настройке; `gemini` и `exa` зарезервированы до появления executor. |
| `model?` | `string` | backend-dependent | `gpt-5.6-luna` для OpenAI, `claude-sonnet-5` для Anthropic или `grok-4.6` для xAI. Старый явный `gpt-5.4-mini` мигрирует при старте. |
| `exaApiKey?` | `string` | отсутствует | Ключ оператора для backend `exa`. Только для записи: management-read никогда не возвращает сохранённое значение. |
| `xSearch?` | `object` | отсутствует | Опциональный hosted `x_search` только для xAI: `enabled`, взаимоисключающие массивы `allowedXHandles` / `excludedXHandles` (не более 20) и ISO-даты `fromDate` / `toDate` (`YYYY-MM-DD`). |
| `reasoning?` | `string` | `low` | Effort sidecar'а. Значение `minimal` с web search отклоняется. |
| `maxSearchesPerTurn?` | `number` | `3` | Число реальных поисков, разрешённых за один turn основной модели. |
| `routedModelStallTimeoutMs?` | `number` | `200000` | Config-file-only дедлайн бездействия raw-body у routed-model. Целое 1–2147483647; каждый непустой chunk сбрасывает таймер. |
| `timeoutMs?` | `number` | `60000` | Дедлайн одного hosted-search запроса. |

Backend OpenAI требует логина в ChatGPT и включённого provider'а ChatGPT `forward`. Routed replay
с входом от Claude внедряет auth основного ChatGPT во внутренний запрос. Anthropic-backend
использует активный stored credential из включённого Anthropic OAuth-провайдера. Явно выбранный
Anthropic-backend без рабочего аккаунта закрывается с ошибкой и не откатывается на другой backend.
Исполнитель Anthropic использует нативный tool `web_search_20250305`. Backend xAI требует рабочего
сохранённого аккаунта Grok OAuth, использует hosted `web_search` и добавляет hosted `x_search`, когда
`xSearch.enabled` равно true. Некорректный management-input `xSearch` возвращает `400`, а некорректный
сохранённый блок закрывается с ошибкой при планировании. Линии `gemini` и `exa` никогда не активируются
через обнаружение credentials или fallback; оператор должен выбрать их явно. `exaApiKey` принимается
при записи, но не включается в management-response.

Поиск ограничивают четыре clock'а: базовый `stallTimeoutSec`, `connectTimeoutMs`, inactivity для
routed-model и hosted-search timeout. Эффективный watchdog моста равен максимуму этих значений плюс
30 секунд. Таймаут routed stall — это защита от бездействия, а не общий дедлайн генерации.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Поле | Тип | По умолчанию | Значение |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | Главный переключатель описания изображений. |
| `backend?` | `"openai" \| "anthropic"` | auto | Явное значение имеет приоритет; если оно не задано, предпочтение отдаётся пригодным сохранённым учётным данным Anthropic OAuth, иначе используется `openai`. |
| `model?` | `string` | backend-dependent | `gpt-5.6-luna` для OpenAI или `claude-sonnet-5` для Anthropic. |
| `reasoning?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"low"` | Уровень рассуждений OpenAI Responses. Anthropic его игнорирует. |
| `maxDescriptionsPerTurn?` | `number` | `8` | Максимум новых промахов description-cache за один main turn. `0` отключает вызовы; некорректные значения возвращают дефолт. |
| `timeoutMs?` | `number` | `45000` | Таймаут запроса sidecar'а. Целое число 1–2147483647. |

Поддерживаемые уровни зависят от возможностей вышестоящего провайдера и заявленной лестницы
рассуждений выбранной модели. Vision включается только для изображений, отправленных в модель, входящую в `noVisionModels` её
провайдера. У OpenAI требования по login/forward те же, что и у поиска; явный Anthropic без
рабочего credential завершается ошибкой. Успешные описания `data:` используют ограниченный cache,
ключ которого включает backend, model, detail, bytes изображения и нормализованный message
context; в ключи OpenAI дополнительно входит reasoning effort (в ключи Anthropic — нет).
Попадания в cache и дубликаты в пределах одного turn'а не расходуют лимит. Удалённые
`https:`-изображения, а также пустые и неуспешные описания не кэшируются.

Sidecar'ы Anthropic OAuth повторно используют уже существующий OAuth fingerprint Claude Code от
opencodex. Перед использованием прогоните soak-test на нужном аккаунте и ожидаемой нагрузке.

## Ключи Remote Hub и значения по умолчанию

`runtimeRole` по умолчанию равен `standalone`. Hub использует `hub.managementPublicOrigin`, loopback-only `hub.managementIngress` (`enabled:false`, если отсутствует) и точные `remoteGui.allowedTailscaleUsers` (пустой список, если отсутствует). Ключ клиента хранится в `service-api-token`, не в `config.json`; во время ротации может появиться `service-api-token.prev`. Статистика не зеркалируется.

`remoteGui.allowInsecureHttp` — устаревший no-op, оставленный только для загрузки старых файлов со строгой схемой. Удалите его из конфигурации: pairing grants принимаются лишь через loopback или аутентифицированный HTTPS, а значение `true` не включает pairing по открытому HTTP.

## Сетевая диагностика квоты Codex

Поле `quotaRefresh` в строке основного аккаунта Codex описывает получение квоты, а не её остаток или право доступа к модели. Оно может отсутствовать при чтении кэша или если запрос не выполнялся. Используется окружение работающего прокси-сервиса, а не текущего терминала. Если `proxy` не задан, существующее окружение сохраняется; `"auto"` при запуске читает статические настройки HTTP/HTTPS Windows или macOS. На macOS унаследованный прокси отменяет это чтение. На macOS допустимый шаблон `*.<domain>` преобразуется в `.<domain>`: для `*.local` прямое соединение получают `foo.local` и само имя `local`, но не `xlocal`. Точные диапазоны `169.254/16`, `169.254.0.0/16` и `fe80::/10` пропускаются с диагностикой: link-local IP-адреса используют прокси. IP-адреса и `*` принимаются; прочие CIDR, glob-шаблоны и исключения простых имён отменяют обнаружение без изменения окружения. PAC/WPAD, настройки только SOCKS и изменения во время работы автоматически не учитываются. Успех через TUN сам по себе не подтверждает исправность пути HTTP-прокси. См. [команды и состояния на английском](/reference/configuration/server/#codex-quota-network-diagnostics).

`dropCodexSafetyBuffering`: не меняет проверки безопасности провайдера или отказы. Native WebSocket `codex.response.metadata.headers` и `/responses/compact` не входят в область фильтра.

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`ocx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `ocx agent subagents force -` clears it. `ocx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `ocx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Непрерывный учёт истории пулов

Лимиты пула относятся к каноническому провайдеру маршрута, а не к отображаемой метке аккаунта.
Для каждого настроенного сейчас провайдера `P` его солёный псевдоним пула `h(pool, P)` автоматически
связывается с `P` при чтении балансов. Это касается и сохранённой истории с точно таким же псевдонимом.
Независимые лимиты провайдеров не требуют ручного назначения собственных псевдонимов или вычислений с солью.

Другие исторические метки, включая метки с порядковым номером аккаунта, автоматически не связываются.
Для истории с подтверждённым владельцем верхнеуровневый `spendPoolAliases` в `config.json` задаёт связь
точного псевдонима пула (32 строчных шестнадцатеричных символа из журнала этой установки) с точным ID
проверенного и настроенного сейчас провайдера, без пробелов по краям.
Текущие имена и порядок аккаунтов не доказывают владельца истории. Храните журнал и соль в секрете.

Автоматические и явные связи применяются только при чтении: исходные балансы не перемещаются,
идентификационные связи в журнал не записываются. Удаление явной связи снова делает историю неопознанной,
если её псевдоним не принадлежит самому настроенному сейчас провайдеру. Каждый исходный баланс
учитывается один раз в связанной группе; неопознанный положительный баланс консервативно добавляется
один раз к каждому возможному пулу. Псевдоним самого настроенного провайдера нельзя назначить другому
провайдеру. Проверка повторяется при добавлении провайдеров и не создаёт соль.
Некорректное соответствие сохраняет лимиты и блокирует допуск к пулу.

Неактивная неопознанная история истекает только когда её последняя активность строго старше
`spend.retentionDays`. Нехватка места не сокращает этот срок для положительных балансов.
Активные резервирования и seed сохраняются даже при нулевой оценке; уменьшение баланса требует
сначала записать удаление в журнал. При применимом лимите первая отправка для каждой цели/ключа
требует обычного резервирования. Повторы используют те же области. `L` — общий лимит физических отправок
одного запроса, фиксируемый при запуске запроса. Обычно он равен 4; существующий профиль запроса OAuth
допускает до 18. Все физические отправки делят этот конечный лимит.

Режим применения ограничений, действующие токенные лимиты корня, идентичности и пула, а также `L`
фиксируются при запуске запроса. Изменение конфигурации применяется только к запросам, начатым после него.
Уже выполняющийся запрос сохраняет исходную политику для всех повторов и продолжений: включение или
снижение лимита не ужесточает её, а повышение или удаление не ослабляет. Запрос, начатый в режиме
наблюдения, остаётся в этом режиме до завершения.
Окончательный расчёт ждёт отчётов; удаление ID отправки не удаляет баланс. Без применимого лимита
сохраняется режим наблюдения, включая пропуск записей при заполненной ёмкости отслеживания.

Для Claude CLI, CodeBuddy и Qoder один вызов CLI считается одной отправкой и требует обычного резерва до запуска.
Внутренние повторы и инструментальные ходы CLI отдельно не расходуют общий лимит отправок запроса, но стоимость учитывается по фактически сообщённому использованию, включая превышение первоначальной оценки.

### Откат к 2.80.0: контракт C

Новые записи используют обычный формат v1 и псевдонимы `pool`. Неизменённая 2.80.0 читает их,
уплотняет журнал и применяет срок хранения по своим правилам отдельных меток. Сохраните текущие
журнал и соль. После отката не гарантируется каноническая агрегация или тот же остаток лимита,
который 2.80.0 вычислила бы для того же трафика без обновления. При повторном обновлении автоматические
связи настроенных сейчас провайдеров и явные соответствия применяются к сохранившимся исходным балансам. Барьер запуска и команда сверки не требуются.
История неопубликованных экспериментальных сборок с `pool-current` / `poolContinuity` исключена
из контракта C. Исходные балансы сохраняются как неопознанная история до обычного истечения срока;
немедленного преобразования или удаления нет.

Полная, но некорректная запись (включая последний `null`) блокирует запросы с лимитом.
Уплотнение продолжает сохранять корректные балансы; отказ живого процесса сохраняется до перезапуска
с чистым журналом. Оборванная последняя строка JSON обрабатывается по прежним правилам восстановления.
Подробности и коды ошибок: [английский оригинал](/reference/configuration/server/#historical-pool-continuity).
