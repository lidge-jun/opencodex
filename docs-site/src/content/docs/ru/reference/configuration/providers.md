---
title: Конфигурация провайдеров
description: Записи провайдеров, аутентификация, endpoint'ы, каталоги моделей, quota, context cap'ы и provider-specific options.
---

Провайдер сообщает opencodex, где живёт модель, на каком wire-adapter'е она работает и как
аутентифицируются запросы.

## Верхнеуровневые поля, связанные с провайдерами

| Поле | Тип | По умолчанию | Значение |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | Map вида provider name → provider config. |
| `openaiProviderTierVersion?` | `2` | set by migration | Отмечает, что единая projection OpenAI с учётом режима уже завершена. |
| `disabledModels?` | `string[]` | — | Модели, скрытые из каталога Codex и `/v1/models`, но не заблокированные для прямых вызовов прокси. Routed-id удаляются из списков; bare native GPT-id получают `visibility: "hide"`. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Context cap'ы, видимые Codex, по каждому провайдеру. Cap может только понижать известное context window. |
| `contextCapValue?` | `number` | `350000` | Значение, используемое элементами управления context-cap в дашборде; его изменение обновляет все включённые записи `providerContextCaps`. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Метаданные аккаунтов пула ChatGPT/Codex, которыми управляет Codex Auth. Секреты живут отдельно в `codex-accounts.json`. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | Аккаунты, исключённые из выбора Pool до снятия паузы, включая основной аккаунт `__main__`, если он поставлен на паузу. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | Публичное пространство имён селектора модели на сохранённую цель аккаунта Codex. Это поле валидирует и сохраняет mapping, но само по себе не добавляет строки в picker и не меняет routing. |
| `activeCodexAccountId?` | `string` | — | Вручную выбранный аккаунт Pool для следующего запроса. Выбор очищает thread affinity; in-flight-запросы сохраняют уже захваченные credential'ы. |
| `autoSwitchThreshold?` | `number` | `80` | Порог проактивного переключения по использованию. `quota` может повторно оценить следующий запрос как привязанной, так и непривязанной задачи; `fill-first` использует его только как точку исчерпания для непривязанных назначений; обычный `round-robin` его не использует. Оценка берёт самое горячее из окон 5 часов, недели и 30 дней. `0` отключает только переключение по использованию, но не назначение непривязанных задач и не восстановление после сбоев. |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Стратегия назначения для новых/непривязанных запросов Codex. Запрос непривязан, если у него нет live affinity `(parent thread id, quota scope)`; видимая существующая задача может стать непривязанной после перезапуска прокси или сброса affinity. `quota` выбирает подходящий аккаунт с наименьшим известным usage, когда активного аккаунта нет, сохраняет подходящий активный аккаунт ниже `autoSwitchThreshold`, а после порога может перевести непривязанный запрос или следующий запрос привязанной задачи на подходящий аккаунт с меньшим usage. `round-robin` равномерно распределяет непривязанные запросы; `fill-first` назначает их активному аккаунту до cooldown, недоступности или порога исчерпания. |
| `accountPoolStickyLimit?` | `number` | `1` | Число назначений новых/непривязанных задач на одном выборе round-robin перед переходом дальше. Счётчик растёт при привязке задачи, а не после успеха upstream. Диапазон 1–100; только при `accountPoolStrategy` = `round-robin`. |
| `upstreamFailoverThreshold?` | `number` | `3` | Сколько подряд transient failure допустить, прежде чем новые сессии начнут делать failover. `0` отключает эту логику. |
| `modelCacheTtlMs?` | `number` | `300000` | Окно свежести для кэша `/models` на уровне провайдера. |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Политика prompt-cache Anthropic: отключено, 5-минутный ephemeral или 1-часовой extended. |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | off | Необязательная политика proactive OAuth refresh и warmup'а аккаунтов Codex. |

Ключи `codexAccountNamespaces` — это публичные селекторы: 1–64 символа, начинаются и
заканчиваются ASCII-буквой или цифрой, а внутри могут содержать буквы, цифры, `.`, `_` или `-`.
Зарезервированные имена объектов JavaScript отклоняются. Каждое значение — это валидный id
аккаунта из пула (никогда не внутренний `__main__`) или `"@main"` для аккаунта Codex Desktop.
Конфликты с именами провайдеров и зарезервированными `openai` / `combo` проверяются
без учёта регистра. Сырые account-id и email должны оставаться приватными; селектор — это
публичное имя.

## Зарезервированные провайдеры OpenAI

`openai` и `openai-apikey` — это фиксированные зарезервированные id. `openai.codexAccountMode`
по умолчанию равен `"pool"` и выбирает между основным и добавленными аккаунтами; `"direct"`
использует только текущий login вызывающей стороны / основной login. Уровень API использует только
свой настроенный API-key или key-pool. Используйте bare-model либо `openai-apikey/<model>`;
cross-route credential fallback не существует. Строки API GPT-5.6 несут метаданные контекста
1,050,000 / max input 922,000, а виртуальные Pro-id переписываются в базовую wire-модель с
`reasoning.mode: "pro"`.

`openaiProviderTierVersion: 2` отмечает текущую single-provider projection. Перед миграцией
поставляемой v1-конфигурации opencodex создаёт `config.json.pre-openai-tiers-v2.bak`, не
перезаписывая отличающуюся backup-копию, и переписывает известные legacy namespaced-id,
выбранные в `selectedModels`, в bare-id.

## Записи провайдеров (`OcxProviderConfig`)

| Поле | Тип | Значение |
| --- | --- | --- |
| `adapter` | `string` | Один из `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `azure-openai` (или alias `azure`). |
| `baseUrl` | `string` | Базовый URL API upstream'а. Большинство built-in fixed-endpoint'ов игнорируют несовпадение; collision-safe key-preset'ы сохраняют старый custom destination с тем же именем. |
| `responsesPath?` | `string` | Relative resource path для key-auth запросов `openai-responses`. Должен начинаться с `/` и не может содержать scheme, query или fragment. |
| `disabled?` | `boolean` | Сохранить провайдера на диске, но исключить его из routing'а и из model/catalog-listing'ов. |
| `apiKey?` | `string` | API-key либо ссылка `${ENV_VAR}` / `$ENV_VAR`, разрешаемая при каждом запросе. |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Header-style для ключа Anthropic. По умолчанию нативный `x-api-key`; допустим только для key-auth-провайдеров `anthropic`. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | Пул из нескольких ключей. `apiKey` зеркалит активную запись; каждый элемент содержит `id`, `key`, необязательный `label` и необязательное числовое `addedAt`. |
| `defaultModel?` | `string` | Модель, используемая когда этот провайдер выбран без явной модели. |
| `models?` | `string[]` | Seed/fallback-список моделей. При `liveModels: false` это и есть единственный список обнаруженных моделей. |
| `liveModels?` | `boolean` | Получать live-каталог на start/sync (по умолчанию `true`). Custom-провайдеры используют `${baseUrl}/models`; built-in могут использовать registry URL и дополнительно фильтровать результат. |
| `selectedModels?` | `string[]` | Allowlist каталога после discovery. Непустой список показывает только эти id; пустой или отсутствующий показывает всё, что было обнаружено. |
| `contextWindow?` | `number` | Provider-wide context cap, видимый Codex. Более маленькая live-metadata сохраняется. |
| `modelContextWindows?` | `Record<string, number>` | Context cap'ы по отдельным моделям. Они перекрывают `contextWindow` и никогда не поднимают более маленькую live-metadata. |
| `modelInputModalities?` | `Record<string, string[]>` | Подсказки modality по модели, например `["text"]` или `["text", "image"]`. |
| `modelMaxInputTokens?` | `Record<string, number>` | Положительные лимиты max input по моделям, используемые для подсказок auto-compaction в каталоге. |
| `defaultMaxOutputTokens?` | `number` | Provider-wide fallback для `openai-chat`, когда клиент не передал `max_output_tokens`. |
| `modelMaxOutputTokens?` | `Record<string, number>` | Положительные fallback-budget'ы `openai-chat` по моделям; exact/pattern-match имеет приоритет над provider-default. |
| `headers?` | `Record<string, string>` | Дополнительные upstream-header'ы. Заголовки авторизации, cookie, API-key-header'ы, встроенные переводы строк и невалидные имена отклоняются. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | Предпочтения по умолчанию для OpenRouter (`order`, `only`, `allowFallbacks`); валидно только для канонического OpenRouter с `openai-chat`. |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | Exact override по model id, которые полностью заменяют provider-wide preference для OpenRouter. |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | Режим аутентификации (по умолчанию `key`). OAuth/subscription credential'ы хранятся вне `config.json`; `local` разрешён только для тех провайдеров, где это допускает registry-entry. |
| `codexAccountMode?` | `"pool" \| "direct"` | Только для канонического `openai`; по умолчанию Pool. Direct обходит состояние пула. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | Переопределение политики Token Guardian для этого OAuth-провайдера. |
| `reasoningEfforts?` | `string[]` | Provider-wide reasoning-label'ы Codex, которые нужно рекламировать и отправлять. |
| `modelReasoningEfforts?` | `Record<string, string[]>` | Label'ы по отдельным моделям. Пустой список скрывает управление effort. |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | Установите `false` для модели, чтобы перестать рекламировать summary и вырезать поля доставки summary. |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | Responses delivery enum по моделям; переписывает уже существующее поле delivery. |
| `modelAdapters?` | `Record<string, string>` | Wire-override по модели для `openai-chat` или `openai-responses` в gateway с несколькими wire-форматами. Явные записи имеют приоритет над default'ами registry; preset DeepSeek может выбирать native Responses для `deepseek-v4-flash`. Single-wire upstream pin'ы и canonical ChatGPT forward override не принимают. |
| `reasoningEffortMap?` | `Record<string, string>` | Provider-wide wire-alias'ы для reasoning-label'ов. |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | Wire-alias'ы для reasoning-label'ов по отдельным моделям. |
| `noReasoningModels?` | `string[]` | Модели, отвергающие параметры reasoning/thinking. |
| `noTemperatureModels?` | `string[]` | Модели, отвергающие переданный вызывающей стороной `temperature`. |
| `noTopPModels?` | `string[]` | Модели, отвергающие переданный вызывающей стороной `top_p`. |
| `noPenaltyModels?` | `string[]` | Модели, отвергающие penalty presence/frequency. |
| `parallelToolCalls?` | `boolean` | Переключатель parallel tool call'ов. Для OpenAI Chat по умолчанию включено; не-chat adapter'ы рекламируют это только при явном `true`. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean }` | По умолчанию выключенная downstream SSE-repair для exact placeholder-id и отсутствующих terminal-id. Function-call id никогда не переписываются. |
| `autoToolChoiceOnlyModels?` | `string[]` | Модели, у которых `tool_choice` принимает только `auto` или `none`; forced choice понижается. |
| `preserveReasoningContentModels?` | `string[]` | Модели, которым нужен предыдущий assistant `reasoning_content` в chat history. |
| `thinkingToggleModels?` | `string[]` | Chat-модели, использующие `thinking.enabled` вместо effort-ladder. |
| `thinkingBudgetModels?` | `string[]` | Chat-модели, использующие целочисленный `thinking_budget`; effort отображается в долю бюджета. |
| `noVisionModels?` | `string[]` | Text-only-модели, идущие через vision sidecar; при сопоставлении tolerируется тег Ollama вида `:size`. |
| `escapeBuiltinToolNames?` | `boolean` | Экранировать built-in tool name'ы для Anthropic-compatible gateway'ев и восстанавливать их в возвращаемых call'ах. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Режим транспорта/аутентификации Google. По умолчанию `ai-studio`. |
| `project?` | `string` | Идентификатор проекта Vertex или Antigravity Cloud Code Assist. |
| `location?` | `string` | Локация Vertex; fallback через окружение — `GOOGLE_CLOUD_LOCATION`. |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | Только Cursor: MCP-серверы в режимах stdio или Streamable HTTP. |
| `desktopExecutor?` | `DesktopExecutorConfig` | Только Cursor: команды внешнего computer-use и record-screen. |
| `unsafeAllowNativeLocalExec?` | `boolean` | Legacy boolean Cursor, эквивалентен `nativeLocalExec: "on"` только если новое поле не задано. |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Политика local-exec для Cursor. `off` — дефолт; `codex-sandbox` сейчас ведёт себя fail-closed как `off`. |

Провайдеры с API-key могут хранить literal key или environment-reference. OAuth-провайдеры
используют credential store, заполняемый через `ocx login`; поведение subscription-backed launcher'а
Claude Code настраивается через
[`claudeCode.authMode`](/reference/configuration/server/#claude-code).

## Безопасность исходящих диагностических запросов

Тест подключения из дашборда и live discovery моделей используют ограниченный transport только для
GET-запросов. Если outbound-proxy не настроен, opencodex один раз разрешает hostname и затем
подключается только к этому проверенному адресу. Для HTTPS сохраняются исходные Host, SNI и
проверка сертификата; отключить проверку сертификата конфигурация провайдера не может.

Если активны `HTTP_PROXY`, `HTTPS_PROXY` или `ALL_PROXY`, эти операции оставляют встроенный fetch
Bun. Проверки URL и literal-address всё равно выполняются, но итоговый маршрут, DNS-ответ и peer
всё же выбирает прокси, поэтому opencodex не может зафиксировать или проверить этого peer'а. Это
осознанное ограничение безопасности.

Private/local destination требуют `allowPrivateNetwork: true` и, если активен outbound-proxy,
подходящей записи в `NO_PROXY`. Loopback добавляется автоматически; каждый LAN-host нужно
перечислять явно, так как CIDR-диапазоны не интерпретируются. Matcher поддерживает точные хосты,
domain suffix, необязательные порты, IPv6 в квадратных скобках и `*`; например, `192.168.1.50`
надо перечислять явно. Metadata- и link-local-address'ы всё равно блокируются. Diagnostic-request'ы
не следуют redirect'ам и в результатах показывают только credential-stripped target. Проверка
redirect'ов для обычных provider-request'ов реализована отдельно и к этому guard не относится.

## Пул аккаунтов Codex

Используйте страницу **Codex Auth** дашборда для добавления аккаунтов пула и обновления квот.
Конфигурация хранит только несекретные метаданные аккаунтов; access- и refresh-токены хранятся в
защищённом хранилище учётных данных аккаунтов Codex. Pool routing разделяет назначение
новых/непривязанных задач, проактивное переключение по использованию и восстановление после сбоев.
Привязанная задача обычно сохраняет affinity, но `quota` может перепривязать её при следующем
запросе после превышения порога; pause, cooldown, повторная аутентификация и обработка сбоев также
могут независимо очистить или изменить routing. Непривязанным может стать и существующая задача
после перезапуска прокси или сброса affinity. Отказ **429/402** до вывода допускает одну попытку
на подходящем альтернативном аккаунте даже при выключенном переключении по использованию.
Контекст разговора сохраняется и воспроизводится, но prompt cache провайдера между аккаунтами
может не переиспользоваться и потребовать прогрева.
Приостановленный аккаунт и его метаданные квоты остаются видимыми, но исключаются из автоматического переключения,
повторов/failover, проб восстановления cooldown и ручной активации. Пауза также очищает карту affinity потоков
этого аккаунта: выполняющиеся запросы сохраняют захваченные учётные данные, но последующие ходы
перемаршрутизируются и не могут повторно использовать приостановленный аккаунт. Состояние сохраняется после перезапуска;
если приостановлены все аккаунты, маршрутизация Pool завершается ошибкой, а не выбирает аккаунт скрытно.
**Приостановить исчерпанные** сначала обновляет только подходящие аккаунты с доступными учётными данными и приостанавливает только те, для которых актуальное окно квоты в этом ответе подтверждено на уровне 100%. Аккаунты без учётных данных, с неизвестной квотой или неудачным обновлением не меняются.
При **401/403** локальная для процесса привязка к аккаунту сбрасывается и требуется повторная аутентификация.
При **429** учитывается `Retry-After`, для аккаунта запускается cooldown, привязка сбрасывается,
после чего запрос может перейти на другой подходящий аккаунт Pool. Эти переходы восстановления
остаются активными при `autoSwitchThreshold: 0`; значение `0` отключает только проактивное переключение по использованию.

**Стратегии назначения и проактивного переключения:** `quota` выбирает подходящий аккаунт с наименьшим usage, когда активного аккаунта нет, сохраняет подходящий активный аккаунт ниже `autoSwitchThreshold`, а после порога может перевести непривязанный запрос или следующий запрос привязанной задачи на подходящий аккаунт с меньшим usage. `round-robin` равномерно распределяет непривязанные запросы, а порог не
меняет обычную ротацию. `accountPoolStickyLimit` (по умолчанию `1`, 1–100) считает назначения/bind,
а не успешные ответы. `fill-first` назначает непривязанные запросы активному аккаунту до cooldown,
reauth или порога исчерпания; здоровые привязанные задачи сохраняют affinity. Эти стратегии не
защищают от enforcement провайдера.

### `anthropicAccountPool` (experimental)

Этот opt-in объединяет несколько Anthropic OAuth-аккаунтов, уже сохранённых в `auth.json`. По
умолчанию функция выключена и не считается battle-tested. Аккаунты внутри одной организации могут
делить общую quota, а автоматическая ротация может вызвать ограничения со стороны провайдера.

| Ключ | Тип | По умолчанию | Описание |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | Включить sticky affinity и cooldown failover на 429. |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | Для новых сессий выбирать аккаунт с наименьшим известным cached 5-hour usage, если активный аккаунт достиг порога. `0` отключает выбор по quota. |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Стратегия для новых сессий; quota смотрит только на 5-hour bar'ы. |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | Сколько успешных bind'ов новых сессий удерживать на одном выборе round-robin. Диапазон 1–100. |

Если функция включена, 429 записывает ограниченный cooldown из `Retry-After` или из default
backoff и может переключить аккаунт уже внутри текущего запроса. Affinity локальна для процесса и
ограничена по размеру. Credential 401/403 помечает аккаунт как нуждающийся в переавторизации.
Если все eligible-аккаунты в cooldown, клиент получает 429 с `Retry-After`, если он известен,
а не authentication error.

:::caution[Experimental]
Оставляйте эту функцию выключенной, если не понимаете policy-risk аккаунтов Anthropic. Если
сомневаетесь, безопаснее переключать аккаунты вручную через
`ocx account use anthropic <id>`.
:::

### Формы управляемых записей

В `apiKeys[]` записи содержат `id`, `name`, сгенерированный `key` и ISO-строки `createdAt`.
Элементы `codexAccounts[]` требуют `id`, `email` и `isMain`, а также могут нести `plan`,
`chatgptAccountId` и privacy-safe `logLabel`. Обычно этими записями управляет дашборд.

### `tokenGuardian` (`OcxTokenGuardianConfig`)

| Поле | Тип | По умолчанию | Значение |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Глобальный переключатель proactive refresh. |
| `tickSeconds?` | `number` | `21600` | Интервал sweep'а (6 часов, минимум 60 секунд). |
| `jitterSeconds?` | `number` | `300` | Случайная задержка перед sweep'ом. |
| `concurrency?` | `number` | `3` | Максимум одновременных refresh'ей. |
| `leadSeconds?` | `number` | `900` | Дополнительное опережение refresh'а сверх одного tick'а. |
| `failureBackoffBaseSeconds?` | `number` | `300` | Начальный backoff после transient-сбоя. |
| `failureBackoffMaxSeconds?` | `number` | `3600` | Верхний предел backoff'а и задержки после permanent-failure. |
| `codexWarmupEnabled?` | `boolean` | `false` | Включить synthetic validation для аккаунтов пула Codex. |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | Повторно валидировать аккаунт через 8 дней. |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | Нативная модель, используемая для необязательного warmup'а. |

## Фиксированные endpoint'ы провайдеров

Routing сначала определяет endpoint провайдера, а уже потом adapter. Для большинства built-in
registry-endpoint имеет приоритет над настроенным `baseUrl`. Есть четыре типа записей, которые
сохраняют именно настроенный URL:

- провайдеры, где override разрешён: `ollama`, `vllm`, `lm-studio`, `litellm`, `qwen-cloud` и
  `alibaba-token-plan-intl`;
- registry template'ы, заполняемые пользователем, например `azure-openai` и
  `cloudflare-ai-gateway`;
- promoted fixed API-key preset'ы, которые сохраняют старый custom destination с тем же именем; и
- провайдеры, отсутствующие в registry.

Дальше adapter может ещё раз скорректировать получившийся URL. Например, Kiro следует за
API-регионом импортированного credential'а и использует канонический `runtime.{region}.kiro.dev`.
См. [Adapters](/reference/adapters/).

Когда routing выбрасывает `baseUrl`, opencodex пишет в лог registry-endpoint и лишь origin из
конфига; сам настроенный путь может содержать credential. Уберите неиспользуемый URL или
выберите provider-entry, соответствующий нужному региону. `alibaba-token-plan` закреплён за
Beijing, а `alibaba-token-plan-intl` обслуживает международные endpoint'ы.

Если у вас сломан gateway `openai-responses`, repair нужно задавать прямо на объекте провайдера:

```json
{
  "providers": {
    "custom-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_KEY}",
      "responsesItemIdRepair": {
        "reasoning": ["rs_0"],
        "message": ["msg_0"],
        "repairMissingTerminalIds": true
      }
    }
  }
}
```

Списки placeholder'ов сравниваются по exact-match. Для обычных/stateful Responses-провайдеров это
поле оставляйте unset, чтобы passthrough оставался byte-for-byte идентичным.

## Провайдер Cursor (`adapter: "cursor"`)

Bridge Cursor экспериментальный. После `ocx login cursor` добавьте или отредактируйте
`providers.cursor`. Optimization ladder Cursor Router раскрывается как отдельные id для Codex,
потому что picker не умеет показывать специфичные для Cursor model-parameter'ы:

| Модель Codex | Режим Cursor Router |
| --- | --- |
| `cursor/auto` | Team/account default |
| `cursor/auto-cost` | Cost |
| `cursor/auto-balance` | Balance |
| `cursor/auto-intelligence` | Intelligence |

Явные варианты отправляют модель Cursor `default` с её параметром `optimization`, сохраняя выбор
на каждом запросе. Они остаются доступны даже если live-discovery не вернул `default`.

Server-driven local tool'ы Cursor по умолчанию выключены. Codex продолжает использовать собственные
инструменты, такие как `apply_patch` и `exec_command`, со своей же approval/sandbox policy:

- `"off"` (по умолчанию) отвергает нативное выполнение `read`, `write`, `delete`, `ls`, `grep`,
  `shell` и `fetch` со стороны Cursor.
- `"on"` включает trusted local execution и обходит approval/sandbox semantics Codex.
- `"codex-sandbox"` сохранён ради совместимости, но закрывается с ошибкой так же, как `"off"`; на
  prose запроса нельзя полагаться как на достоверную sandbox-attestation.

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "nativeLocalExec": "off"
    }
  }
}
```

Задавайте это поле именно в `providers.cursor`, а не на верхнем уровне. В дашборде откройте
**Providers → Cursor → Edit JSON**, сохраните и затем перезапустите. Legacy-поле
`unsafeAllowNativeLocalExec: true` эквивалентно `nativeLocalExec: "on"` только если поле
`nativeLocalExec` не задано. MCP, screen recording и computer use управляются отдельно через
`mcpServers` и `desktopExecutor`.

Каждый `mcpServers.<name>` принимает либо `command` (stdio), либо `url` (Streamable HTTP). Для
stdio также допустимы `args`, `env` и `cwd`; для HTTP — `headers`. Оба типа поддерживают
`enabled` (по умолчанию true) и `toolPrefix`. `desktopExecutor` принимает
`computerUseCommand`, `recordScreenCommand`, `cwd`, `env` и `timeoutMs` (по умолчанию `30000`).
Команды запускаются через `sh -c`, читают один JSON-запрос из stdin и обязаны записать один
JSON-результат в stdout.

:::caution[Security]
Bind по умолчанию на loopback допускает любой локальный процесс без аутентификации, включая
процессы других пользователей на multi-user host'е. Оставляйте local exec выключенным, если не
доверяете всем data-plane caller'ам или не готовы осознанно отказаться от approval и sandbox
semantics Codex.
:::

## Маршрутизация провайдера OpenRouter

OpenRouter может обслуживать одну и ту же модель через нескольких inference-провайдеров.
`openRouterRouting` удерживает запросы на предпочитаемых провайдерах; `modelOpenRouterRouting`
полностью заменяет его для exact model-id. Это особенно полезно для prompt-cache affinity,
потому что support, retention, hit-rate и цена кэша зависят от inference-провайдера.

Имена провайдеров — это slug'и OpenRouter. `allowFallbacks: false` означает fail-closed;
`true` позволяет использовать другого подходящего провайдера после упорядоченного списка. Поле
`only` всегда трактуется как allowlist.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "openRouterRouting": {
        "order": ["deepseek"],
        "allowFallbacks": false
      },
      "modelOpenRouterRouting": {
        "anthropic/claude-sonnet-5": {
          "only": ["anthropic"],
          "allowFallbacks": false
        }
      }
    }
  }
}
```

Ключи моделей здесь должны быть exact native OpenRouter id, без внешнего префикса провайдера
opencodex. При выборе `openrouter/anthropic-claude-sonnet-5` система сначала восстанавливает
native-id `anthropic/claude-sonnet-5`, а уже затем применяет model rule.

## Статические allowlist'ы моделей

Задайте `liveModels: false`, чтобы показывать только `models`. Если `models` пуст или отсутствует,
провайдер не будет показывать ни одной маршрутизируемой модели. Live-discovery отвергает ответы
размером более 4 MiB или более 2000 сырых model-row до кэширования; built-in preset'ы могут
использовать меньшие лимиты и фильтровать список до chat-совместимых строк. Oversized или
malformed-результаты откатываются к stale/configured fallback. Валидный результат с нулём
подходящих моделей считается авторитетным и не заменяется молча.

Используйте `selectedModels`, когда discovery должно продолжать работать, но в Codex и `/v1/models`
должны появляться только избранные id. Дашборд всё равно сохраняет полный обнаруженный список для
дальнейших изменений allowlist'а.

Preview fallback-записи GPT-5.6 используют тот же механизм. Preset OpenAI API-key заранее засевает
base- и Pro-id с context `1050000` и max input `922000`; OpenRouter заранее засевает
`openai/gpt-5.6-sol`, `openai/gpt-5.6-terra` и `openai/gpt-5.6-luna` с context `1050000`.
Pool/Direct рекламирует `372000`; синхронизированный каталог показывает `max`, сохраняя при этом
отдельную ступень `xhigh`.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## Полный пример

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-5", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 60000
  },
  "visionSidecar": { "enabled": true }
}
```
