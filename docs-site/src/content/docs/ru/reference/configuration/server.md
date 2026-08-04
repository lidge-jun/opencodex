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
| `proxy?` | `string` | — | URL исходящего HTTP(S)-прокси или `${ENV_VAR}`. Применяется к `HTTP_PROXY` / `HTTPS_PROXY` только когда эти переменные не заданы; loopback всегда остаётся в `NO_PROXY`. |
| `stallTimeoutSec?` | `number` | `300` | Секунды без upstream-данных до `response.incomplete`. Минимум 1. |
| `connectTimeoutMs?` | `number` | `200000` | Дедлайн одной попытки DNS/TCP/TLS/final-header; он завершается до генерации тела ответа. |
| `shutdownTimeoutMs?` | `number` | `5000` | Дедлайн graceful-drain до принудительного прерывания активных turn'ов. |
| `websockets?` | `boolean` | `false` | Объявлять `supports_websockets` для WebSocket-пути Responses. Значение false удерживает HTTP/SSE. |
| `corsAllowOrigins?` | `string[]` | `[]` | Дополнительные точные CORS-origin'ы. Loopback-origin'ы разрешены всегда. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Сгенерированные credentials `ocx_…`, принимаемые для management и data-plane auth на не-loopback bind'ах. Управляются через дашборд. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | disabled | Opt-in policy очистки архивированных сессий. Никогда не включается неявно. |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | Лимит в MiB для eviction-friendly app-owned log'ов, cache'ей, blob'ов и continuation payload'ов. Это не RSS-cap. Диапазон 64–4096. |
| `codexAutoStart?` | `boolean` | `true` | Разрешает shim'у Codex запускать `ocx ensure` перед стартом Codex. При false `ensure` становится no-op. |
| `codexShimAutoRestore?` | `boolean` | `true` | Восстанавливает установленный shim после завершённого внешнего обновления Codex, которое заменило его. Для отключения через окружение: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `syncResumeHistory?` | `boolean` | `true` | Обратимый режим совместимости истории Codex App. Исходные metadata резервируются и восстанавливаются через `ocx stop` / `ocx restore`. |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | off | Перенаправляет распознанные helper/shadow-call'ы Codex на выбранную модель с low effort. Source-prefix'ы по умолчанию: `gpt-5.4-mini` и `gpt-5.6-luna`. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on when usable | Настройки sidecar'а web-search. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on when usable | Настройки sidecar'а описания изображений. |
| `images?` | `OcxImagesConfig` | automatic OpenAI selection | Настройки standalone Images relay для Codex `image_gen`. |

Если более старая development-сборка изменила metadata resume-history до появления резервного
backup'а, выполните `ocx recover-history --legacy-openai`, чтобы принудительно вернуть
native-provider history.

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
| `/v1/models` | accepted | accepted | accepted |

Responses и Chat Completions резервируют `Authorization` под возможный passthrough Codex Direct,
поэтому там принимается только dedicated admission-header. Сгенерированные в дашборде `apiKeys`
могут после старта заменить env-token; сравнение кандидатов выполняется constant-time.

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

Эти настройки управляют `/v1/messages`, launcher'ом `ocx claude` и страницей Claude в дашборде.

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
модель. Замещающая модель работает с low effort. `sourceModels` задавайте только если клиент
использует другие helper-id.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.4-mini", "gpt-5.6-luna"]
  }
}
```

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
| `enabled?` | `boolean` | on when usable | Главный переключатель. |
| `backend?` | `"openai" \| "anthropic"` | auto | Явный выбор выигрывает; иначе usable stored Anthropic OAuth выбирает `anthropic`, затем `openai`. |
| `model?` | `string` | backend-dependent | `gpt-5.6-luna` для OpenAI или `claude-sonnet-5` для Anthropic. Старый явный `gpt-5.4-mini` мигрирует при старте. |
| `reasoning?` | `string` | `low` | Effort sidecar'а. Значение `minimal` с web search отклоняется. |
| `maxSearchesPerTurn?` | `number` | `3` | Число реальных поисков, разрешённых за один turn основной модели. |
| `routedModelStallTimeoutMs?` | `number` | `200000` | Config-file-only дедлайн бездействия raw-body у routed-model. Целое 1–2147483647; каждый непустой chunk сбрасывает таймер. |
| `timeoutMs?` | `number` | `60000` | Дедлайн одного hosted-search запроса. |

Backend OpenAI требует логина в ChatGPT и включённого provider'а ChatGPT `forward`. Routed replay
с входом от Claude внедряет auth основного ChatGPT во внутренний запрос. Anthropic-backend
использует активный stored credential из включённого Anthropic OAuth-провайдера. Явно выбранный
Anthropic-backend без рабочего аккаунта закрывается с ошибкой и не откатывается на другой backend.
Исполнитель Anthropic использует нативный tool `web_search_20250305`.

Поиск ограничивают четыре clock'а: базовый `stallTimeoutSec`, `connectTimeoutMs`, inactivity для
routed-model и hosted-search timeout. Эффективный watchdog моста равен максимуму этих значений плюс
30 секунд. Таймаут routed stall — это защита от бездействия, а не общий дедлайн генерации.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Поле | Тип | По умолчанию | Значение |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | Главный переключатель описания изображений. |
| `backend?` | `"openai" \| "anthropic"` | auto | Та же логика выбора explicit-first/Anthropic-credential-aware, что и у web search. |
| `model?` | `string` | backend-dependent | `gpt-5.4-mini` для OpenAI или `claude-sonnet-5` для Anthropic. |
| `maxDescriptionsPerTurn?` | `number` | `8` | Максимум новых промахов description-cache за один main turn. `0` отключает вызовы; некорректные значения возвращают дефолт. |
| `timeoutMs?` | `number` | `45000` | Таймаут запроса sidecar'а. |

Vision включается только для изображений, отправленных в модель, входящую в `noVisionModels` её
провайдера. У OpenAI требования по login/forward те же, что и у поиска; явный Anthropic без
рабочего credential завершается ошибкой. Успешные описания `data:` используют ограниченный cache,
ключ которого включает backend, model, detail, bytes изображения и нормализованный message
context. Попадания в cache и дубликаты в пределах одного turn'а не расходуют лимит. Удалённые
`https:`-изображения, а также пустые и неуспешные описания не кэшируются.

Sidecar'ы Anthropic OAuth повторно используют уже существующий OAuth fingerprint Claude Code от
opencodex. Перед использованием прогоните soak-test на нужном аккаунте и ожидаемой нагрузке.
