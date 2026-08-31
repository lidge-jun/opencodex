---
title: API управления
description: Аутентификация, ошибки и справочник эндпоинтов плоскости управления opencodex.
---

Management API — это control plane opencodex. Дашборд на `http://localhost:10100` — лишь один из
его клиентов; headless-команды `ocx` для провайдеров, моделей, combo, аккаунтов, настроек,
диагностики и lifecycle тоже используют его. API доступен только пока прокси запущен.

Для интерактивной работы используйте [Веб-дашборд](/guides/web-dashboard/), а этот справочник
нужен, когда вы строите automation. В конечном счёте постоянные значения следуют
[Конфигурации](/reference/configuration/).

## Модель аутентификации

У Management API свой admin credential, независимый от data-plane API-key'ов. При старте
opencodex разрешает его в таком порядке:

1. `OPENCODEX_ADMIN_AUTH_TOKEN`, если переменная задана.
2. Сгенерированный токен `ocx_admin_*` в hardened secret file.

Токен из файла принимается только после того, как каталог и файл подтверждённо получили
hardened-permissions или ACL. Если это гарантировать нельзя, management-аутентификация
закрывается, и API возвращает 503, пока вы не зададите env-token или не исправите состояние файла.

Передавайте admin-token в любой из двух форм:

```http
X-OpenCodex-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
Admin-token должен отличаться от любого credential data plane. При старте отвергается
management-credential, конфликтующий с proxy-admission key. Не записывайте admin-token в Codex,
Claude Code или любого другого клиента моделей; он даёт право на мутации в control plane.
:::

### Loopback-сессии дашборда

На loopback-привязке bootstrap дашборда может получить short-lived credential `ocx_session_*`.
Каждая такая сессия живёт пять минут и привязана к точному origin дашборда. Safe-запросы должны
совпадать с этим origin. Для unsafe-method'ов браузер дополнительно обязан передать `Origin` и
CSRF-token этой сессии.

Выдача таких сессий отключена всякий раз, когда для data plane требуется аутентификация, в том
числе на удалённых bind'ах. Удалённый оператор обязан аутентифицироваться сырым admin-token'ом;
GUI-сессия в стиле loopback не выпускается.

## Общие ошибки

Все endpoint'ы ниже наследуют эти ошибки границы. В колонке “Notable errors” перечислены только
дополнительные route-specific варианты, а эта таблица не повторяется.

| Статус | Тип или код | Значение |
| --- | --- | --- |
| 401 | `opencodex admin token required` | Admin-token или GUI-session отсутствуют, неверны, просрочены, не совпадают по origin или не содержат CSRF-подтверждение |
| 403 | `cross-origin request blocked` | Origin запроса вне allowlist management API |
| 404 | `not_found` | Ни один management-route не совпал по method и path |
| 413 | `request body too large` | Тело POST, PUT или PATCH превысило лимит management API в 2 MiB |
| 503 | `management API unavailable` | Инициализация admin credential недоступна или hardening не завершён |
| 503 | `oauth_mutation_busy` | Другой writer сейчас мутирует OAuth-credential; ответ включает `Retry-After: 1` |
| 503 | `catalog_busy` | Сборка каталога уже достигла предела конкуренции; ответ включает `Retry-After: 1` |

## Матрица endpoint'ов

### Настройки агентов и клиентов

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET, PUT /api/v2` | Прочитать или изменить нативный multi-agent v2 mode и thread settings | 400 invalid settings; 502 transition or persistence failure |
| `GET, PUT /api/injection-model` | Прочитать или задать injected sub-agent model, effort, prompt и guidance settings | 400 invalid model, effort or body |
| `GET, PUT /api/effort-caps` | Прочитать или задать глобальный и sub-agent потолок reasoning effort | 400 invalid ladder value |
| `GET, PUT /api/subagent-models` | Прочитать или упорядочить модели, рекламируемые подагентам | 400 invalid list or more than five models |
| `GET, PUT /api/subagent-model-fallback` | Прочитать или задать упорядоченную fallback chain и poll interval | 400 invalid list or poll interval |
| `GET /api/grok` | Прочитать статус управляемой конфигурации Grok и кандидатные модели | 400 status read failure |
| `PUT /api/grok/selection` | Сохранить список исключённых моделей Grok | 400 invalid or oversized selection |
| `POST /api/grok/apply` | Применить сохранённую конфигурацию Grok через managed sync | 409 `grok_apply_busy`; 400/500 apply failure |
| `GET, PUT /api/claude-desktop` | Прочитать или сохранить routed/native-профиль Claude Desktop | 400 invalid or unavailable assignment |
| `POST /api/claude-desktop/apply` | Записать сохранённый профиль в managed config Claude Desktop | 400/500 write failure |
| `GET /api/claude-desktop/status` | Проверить согласованность saved-vs-applied profile и здоровье Desktop | 400 status read failure |
| `GET, PUT /api/claude-code` | Прочитать или обновить настройки gateway, auth-mode, model-map, context, agent и sidecar для Claude Code | 400 invalid field or shape |

О принципах model roster и поведении encrypted worker-task см.
[Поверхность подагентов](/guides/sub-agent-surface/).

### Combos

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET /api/combos` | Показать список нормализованных combo и их public model id | Сборка каталога может вернуть `catalog_busy` |
| `PUT /api/combos` | Создать, заменить или переименовать одну combo | 400 invalid id, target, config, rename or ordinary collision; 409 namespace collision for Codex account |
| `DELETE /api/combos?id=...` | Удалить одну combo и очистить её selection/cooldown state | 400 missing id; 404 unknown combo |

О стратегиях целей, cooldown, alias и routing-failure см. [Combos](/guides/combos/).

### Конфигурация, startup, sync и updates

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET /api/config` | Вернуть redacted DTO конфигурации, безопасный для management API | — |
| `PUT /api/config` | Отключённая защита от полной замены конфигурации | 405; используйте вместо этого узкие endpoint'ы |
| `GET, PUT /api/settings` | Прочитать runtime/startup setting'и или обновить auto-start, stream mode, budget app-owned memory и `codexAccountPickerEnabled` | 400 invalid, non-object or empty update |
| `GET /api/startup-health` | Прочитать кэшированное startup health службы/shim'а | — |
| `POST /api/startup-action` | Установить или починить службу или Codex shim | 400 invalid action; 500 action failure |
| `GET, POST /api/windows-tray` | Прочитать состояние Windows tray или установить/запустить/остановить/удалить её | 400 unsupported platform/action; 500 operation failure |
| `GET /api/diagnostics/project-config` | Прочитать кэшированные предупреждения project config | — |
| `POST /api/sync` | Синхронизировать текущий каталог моделей в Codex | 500 failed sync |
| `GET /api/update/check` | Проверить канал обновлений `latest` или `preview` | 400 invalid tag |
| `POST /api/update/run` | Запустить update job, при желании с последующим restart | 400 invalid body; job-specific conflict/error status |
| `GET /api/update/status` | Опрашивать update job по id | 404 unknown job |
| `GET, PUT /api/sidecar-settings` | Прочитать или обновить model/backend-settings web-search и vision sidecar'ов | 400 invalid shape, backend or limit |
| `GET, PUT /api/shadow-call-settings` | Прочитать или обновить настройки shadow-call interception | 400 invalid shape or value |

### Логи, usage и storage

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET /api/logs` | Запросить отфильтрованные in-memory request log'и | — |
| `GET, PUT /api/debug` | Прочитать debug flag'и; задать, очистить или сбросить capture category | 400 invalid or empty update |
| `GET /api/debug/logs` | Прочитать ограниченные записи provider/debug-логов | — |
| `GET /api/debug/usage-logs` | Прочитать ограниченные usage-debug-записи | — |
| `GET /api/debug/injection-logs` | Прочитать ограниченные guidance-injection debug-записи | — |
| `GET /api/claude/inbound-debug` | Прочитать состояние и записи Claude inbound debug | — |
| `GET /api/usage` | Сводка usage по диапазону и client surface | При сбое чтения storage вернёт summary с `error: "read_failed"` |
| `GET /api/storage` | Просканировать использование storage Codex по bucket'ам | При ошибке scan вернёт payload с `error: "scan_failed"` |
| `POST /api/storage/cleanup/preview` | Предпросмотр cleanup archived-session и возврат binding digest | 400 `invalid_json` or `invalid_percent` |
| `POST /api/storage/cleanup` | Поместить preview'нутый архивный набор в quarantine или удалить его навсегда | 400 invalid input; 409 stale/busy/referenced state; 500 filesystem/database failure |
| `GET /api/storage/trash` | Список quarantine-записей cleanup | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | Восстановить одну quarantine-запись | 400 invalid id; 404 missing trash; 409 busy/destination conflict; 500 restore failure |
| `GET /api/storage/trash/restore/test-stream` | Тестовый restore-stream hook | 404 `not_available`, когда test hook'и выключены |
| `GET, PUT /api/storage/cleanup-policy` | Прочитать или обновить расписанную cleanup-policy и job-state | 400 invalid policy |
| `POST /api/storage/cleanup-policy/run` | Запустить manual cleanup-policy run | 409 `already_running`; 500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | Тестовый policy-stream hook | 404 `not_found`, когда недоступен |

Строки в `models`, `providers` и `days[].models` также содержат `cacheHitRate` — долю входных
токенов, полученных из кэша промптов провайдера и ограниченную диапазоном `[0, 1]`. Значение равно
`null`, а не `0`, если провайдер не передал телеметрию кэша или в строке нет входных токенов: отсутствие
данных о кэше и фактическая доля попаданий 0 % — разные сведения, и диаграмма, отображающая их
одинаково, вводит в заблуждение.

:::caution
Endpoint'ы storage cleanup могут перемещать или навсегда удалять архивные данные сессий. Всегда
сначала выполняйте preview и отправляйте возвращённый digest. Если может понадобиться восстановление,
предпочитайте quarantine.
:::

### Модели и каталог

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET /api/catalog` | Вернуть установленный документ каталога Codex | 404 catalog not found |
| `GET /api/models` | Вернуть model-row'ы для дашборда и CLI | `catalog_busy`, когда сборка перегружена |
| `GET /api/client-config?client=...` | Собрать read-only client config для любой поддерживаемой файловой интеграции | 400 unsupported client; 503 catalog unavailable |
| `PUT /api/disabled-models` | Полностью заменить общий список disabled-models | 400 invalid JSON |
| `PUT /api/model-visibility` | Атомарно изменить видимость на уровне провайдера или модели | 400 invalid provider, scope, target or body |
| `GET, POST /api/custom-models` | Показать список custom-моделей или добавить одну | 400 invalid fields; 404 provider missing; 409 duplicate model |
| `PUT, DELETE /api/custom-models/{id}` | Изменить или удалить одну custom-модель | 400 invalid id/fields; 404 not found; 409 duplicate model |
| `GET, PUT /api/selected-models` | Прочитать allowlist'ы и availability провайдеров либо заменить один allowlist | 400 missing provider/body; 404 unknown provider |

### OAuth-аккаунты, ключи провайдеров и ключи data plane

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET /api/oauth/providers` | Показать провайдеров с публичным OAuth-login flow | — |
| `GET /api/key-providers` | Показать провайдеров, настраиваемых через API-key login | — |
| `POST /api/oauth/login` | Запустить OAuth-login или add-account flow | 400 unknown/invalid provider; `oauth_mutation_busy` |
| `POST /api/oauth/login/code` | Отправить manual callback URL или authorization code | 400 invalid provider/code; `oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | Отменить публичный OAuth-flow в progress | 400 unknown provider |
| `GET /api/oauth/status` | Опрашивать OAuth-flow одного провайдера | 400 unknown provider |
| `POST /api/oauth/logout` | Удалить сохранённый credential выбранного провайдера | 400 unknown provider; `oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` | Показать список masked-аккаунтов или удалить один аккаунт | 400 invalid provider/id; 404 account missing; `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | Выбрать активный OAuth-аккаунт | 400 invalid provider/account; `oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Прочитать или обновить policy Anthropic OAuth pool | 400 non-Anthropic provider or invalid policy |
| `POST /api/oauth/accounts/clear-cooldown` | Очистить runtime cooldown одного OAuth-аккаунта | 400 invalid provider/account |
| `PUT /api/oauth/accounts/alias` | Задать или очистить alias OAuth-аккаунта | 400 invalid provider/account/alias |
| `GET, POST, DELETE /api/providers/keys` | Показать список masked provider-key'ов, добавить/активировать один или удалить один | 400 invalid input; 404 provider/key missing |
| `PUT /api/providers/keys/active` | Выбрать активный ключ провайдера | 400 invalid input; 404 provider/key missing |
| `PUT /api/providers/keys/alias` | Задать или очистить alias provider-key'а | 400 invalid input; 404 provider/key missing |
| `GET, POST, PATCH, DELETE /api/keys` | Показать список, создать, отредактировать или удалить admission key data plane | 400 invalid body/id; 404 key missing |

Ответы со списками credential'ов намеренно маскируются. OAuth access-token'ы и полные API-key'и
провайдеров клиентам дашборда не возвращаются.

### Провайдеры

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET /api/providers` | Список redacted provider config'ов и состояния discovery | — |
| `POST /api/providers` | Добавить или заменить одного валидированного провайдера и при желании сделать его default | 400 invalid/dangerous destination or config; 409 namespace collision |
| `PATCH /api/providers?name=...` | Обновить допустимые поля провайдера (включая объединяемый блок `headers`), enabled/default state или OpenAI account mode | 400 invalid field or transition; 404 unknown provider |
| `DELETE /api/providers?name=...` | Удалить провайдера, при возможности переназначив default | 404 unknown provider; 409 `last_provider`; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | Выполнить ограниченный live-probe connectivity/model-discovery для провайдера | 404 unknown provider; сбои обычно возвращаются как evidence с `ok: false` |
| `GET /api/provider-quotas` | Прочитать отчёты по provider quota; `refresh=1` форсирует refresh | — |
| `GET, PUT /api/provider-context-caps` | Прочитать или обновить context cap глобально, для всех провайдеров или для одного провайдера | 400 invalid request; 404 unknown provider |
| `GET /api/provider-presets` | Вернуть GUI-presets провайдеров, выведенные из runtime registry | — |

`provider_has_dependent_combos` — это safety-барьер: сначала удалите или отредактируйте
зависящие combo, и лишь потом удаляйте их провайдера.

### Sidebar и действия, завязанные на согласие

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET /api/github/star` | Прочитать статус star для репозитория через пользовательскую `gh`-сессию | Фиксированные result-code'ы, зависящие от статуса |
| `POST /api/github/star` | Поставить star репозиторию только из аутентифицированного человеческого действия | 403 `agent_consent_required` для agent-driven callers без dashboard-session evidence |
| `GET /api/update/badge` | Прочитать дешёвое состояние update-badge в sidebar | — |

:::caution
Management-аутентификация доказывает доступ к прокси, но не доказывает согласие тратить
пользовательскую идентичность. Агент не должен обходить `agent_consent_required`. Решение о star
принимает сам пользователь.
:::

### Жизненный цикл системы

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET /api/system/memory` | Вернуть скалярные метрики процесса, heap, stream, response-state, watchdog и active-turn | — |
| `POST /api/system/restart` | Начать restart процесса с учётом drain, не снимая client injection | Возвращает 202; повторные вызовы сообщают о текущем drain |
| `POST /api/stop` | Остановить службу, восстановить native Codex, убрать managed Grok injection и выполнить drain прокси | 409 service ownership conflict; 409 `respawnable_service`, когда обёртка планировщика заданий Windows может перезапустить прокси, а вызывающая сторона — не `ocx stop` (ничего не изменяется); 409, когда установленный менеджер отказывается останавливаться; 409 `service_state_unknown`, когда состояние планировщика заданий не удаётся прочитать (ничего не изменяется; исправьте запрос и повторите) |

### Делегирование аутентификации Codex

`GET /api/settings` возвращает эффективный boolean `codexAccountPickerEnabled`. `PUT` этого strict
boolean при включении пустой map создаёт privacy-safe selector'ы, сохраняет существующие labels,
сначала записывает config и лишь затем один раз запускает bounded catalog convergence, если видимость
picker изменилась. `catalogRefreshPending: true` в успешном ответе означает, что настройка сохранена,
но catalog refresh нужно повторить через `POST /api/sync`.

Корневой dispatcher management API делегирует каждый запрос `/api/codex-auth/*` менеджеру
аккаунтов Codex. Его маршруты таковы:

| Метод и путь | Назначение | Особые ошибки |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | Показать/обновить список либо удалить аккаунты Codex. POST сохранён только как отключённый endpoint совместимости; успешный DELETE включает `catalogRefreshPending`. | POST всегда возвращает 403 `manual_import_disabled`; 400 при неверных данных DELETE |
| `PUT /api/codex-auth/accounts/alias` | Задать или очистить alias аккаунта | 400 invalid account/alias |
| `PUT /api/codex-auth/accounts/pause` | Поставить один аккаунт на паузу или снять её | 400 invalid account/state; 404 missing account |
| `PUT /api/codex-auth/accounts/pause-exhausted` | Поставить на паузу аккаунты с исчерпанной квотой | Сбои mutation-lock превращаются в 503 |
| `POST /api/codex-auth/accounts/clear-cooldown` | Очистить runtime cooldown для одного аккаунта или для всех | 400 invalid id |
| `GET, PUT /api/codex-auth/active` | Прочитать или выбрать активный аккаунт | 400 invalid or missing account; 409 paused/legacy-row conflict |
| `PUT /api/codex-auth/auto-switch` | Задать порог квоты для автоматического переключения аккаунтов | 400 invalid threshold |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Обновить стратегию выбора в пуле аккаунтов Codex | 400 invalid strategy/config |
| `PUT /api/codex-auth/failover` | Задать порог failover аккаунтов | 400 invalid threshold |
| `GET /api/codex-auth/quota` | Прочитать кэшированное состояние квоты по аккаунтам | — |
| `GET /api/codex-auth/reset-credits` | Проверить право аккаунта на reset credit | 400 missing account id; upstream status passthrough; 500 lookup failure |
| `POST /api/codex-auth/reset-credits/consume` | Израсходовать доступный reset credit | 400 missing account id; upstream status passthrough; 503 `server_busy`; 500 consume failure |
| `POST /api/codex-auth/login` | Запустить login или reauthentication для Codex | 400 invalid request; conflict/busy login states |
| `POST /api/codex-auth/login/code` | Отправить manual code для login-flow Codex | 400 invalid flow/code |
| `POST /api/codex-auth/login/cancel` | Отменить login-flow Codex | — |
| `GET /api/codex-auth/login-status` | Опрашивать flow или login-state аккаунта. Завершение нового аккаунта включает `catalogRefreshPending: true` только при необходимости восстановления. | Неизвестные flow'ы сообщаются как `expired`; отсутствие активного flow — как `idle` |

Если config row нового аккаунта сохранён, но credential setup не завершён, OAuth `login-status`
сообщает `status: "error"` и содержит
`code: "codex_credential_persistence_failed"`, `accountId`, `needsReauth: true` и при необходимости
`catalogRefreshPending: true`; детали storage error не раскрываются. Account row остаётся сохранённым:
перед повторным созданием аккаунта выполните reauthentication или удалите его.

Если внутри этого delegated family writer конфигурации или refresh credential'ов не получает lock
в разумное время, возвращается HTTP 503 с кодом `CONFIG_MUTATION_LOCK_UNAVAILABLE`. Клиенту нужно
немного подождать и повторить запрос, а не трактовать это как постоянный сбой аккаунта.

Создание и удаление аккаунта записывает credentials/config до catalog convergence. Сбой или
отложенная попытка обновления каталога не откатывает сохранённое изменение аккаунта и не раскрывает
в ответе внутренние сведения о provider, account, path или credentials: клиент получает только
boolean завершения. При удалении аккаунта его selector binding сохраняется, поэтому exact routes
fail closed, пока аккаунт отсутствует, а при повторном добавлении того же id восстанавливается тот же
селектор.

## Как выбрать клиента

Для обычного администрирования самый безопасный guided-workflow даёт
[Веб-дашборд](/guides/web-dashboard/). Для headless-host'ов и automation используйте
соответствующие команды `ocx`: они обращаются к тому же живому API и возвращают ненулевой код,
если прокси недоступен или операция завершилась неудачей. Прямой HTTP полезнее всего там, где
интеграции нужен точный контракт endpoint'ов, описанный выше.
