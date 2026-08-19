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
| `disabledModels?` | `string[]` | — | Модели, скрытые из каталога Codex и `/v1/models`, но не заблокированные для прямых вызовов прокси. Routed-id удаляются из списков. Account-qualified native-id скрывает только строку этого селектора; bare native GPT-id скрывает bare-строку и строки всех селекторов аккаунтов для этой модели. Страница Models показывает только bare native- и routed-строки; чтобы скрыть одну selector-qualified строку, задайте это поле конфигурации напрямую. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Context cap'ы, видимые Codex, по каждому провайдеру. Cap может только понижать известное context window. |
| `contextCapValue?` | `number` | `350000` | Значение по умолчанию для элементов управления context-cap в дашборде. При изменении значение применяется ко всем маршрутизируемым провайдерам — включая провайдеров без существующей записи `providerContextCaps` — только при включённом переключателе «применить ко всем маршрутизируемым провайдерам»; в противном случае каждый провайдер сохраняет собственный лимит. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Метаданные аккаунтов пула ChatGPT/Codex, которыми управляет Codex Auth. Секреты живут отдельно в `codex-accounts.json`. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | Аккаунты, исключённые из выбора Pool до снятия паузы, включая основной аккаунт `__main__`, если он поставлен на паузу. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | Необязательное сопоставление произвольного публичного селектора модели с сохранённым аккаунтом Codex. Когда строки picker'а с указанием аккаунта включены, каждый селектор с существующей целью добавляет в model picker Codex отдельные строки `<selector>/<native-openai-model>`; каждая строка использует только этот аккаунт. Если активен хотя бы один селектор, bare native-строки скрываются в picker, но их id остаются маршрутизируемыми и перечисляются raw `/v1/models`, если они не отключены явно. |
| `codexAccountPickerEnabled?` | `boolean` | выкл. при пустой map | Управляет созданием account-qualified строк picker'а Codex из подходящих сопоставлений `codexAccountNamespaces`. `true` разрешает показывать сопоставленные строки. Если поле не задано при непустой map, функция считается включённой для обратной совместимости; при пустой map она выключена. `false` скрывает созданные строки и возвращает bare native-строки в picker, не удаляя сопоставления и не отключая точную маршрутизацию `<selector>/<native-openai-model>`. |
| `activeCodexAccountId?` | `string` | — | Вручную выбранный аккаунт Pool для следующего запроса. Выбор очищает thread affinity; in-flight-запросы сохраняют уже захваченные credential'ы. |
| `codexAccountPriorities?` | `Record<string,number>` | — | Порядок выбора для каждого аккаунта пула Codex: id аккаунта → целое число от `-100` до `100`, **больше — используется раньше**, отсутствие означает `0`. Это граница порядка, а не пригодности: выбор сужает уже подходящие аккаунты до самого высокого уровня, у которого ещё есть запас квоты, а внутри этого уровня аккаунт выбирает `accountPoolStrategy`. Уровень пропускается, только когда все его аккаунты превысили `autoSwitchThreshold`, находятся в cooldown, под soft-avoid, на паузе или требуют повторной аутентификации; неизвестный usage никогда не исчерпывает уровень. Порядок не делает выбираемым непригодный аккаунт и не перепривязывает поток, у которого аккаунт уже есть. Основной аккаунт `__main__` участвует на равных — именно так логин Codex Desktop можно оставить на самый конец. Без записей поведение остаётся прежним. Некорректная map игнорируется с предупреждением в консоли (порядок отключается, восстановление config не запускается). Управляется через `ocx account priority` и страницу Codex Auth. |
| `autoSwitchThreshold?` | `number` | `80` | Порог проактивного переключения по использованию. `quota` может повторно оценить следующий запрос как привязанной, так и непривязанной задачи; `fill-first` использует его только как точку исчерпания для непривязанных назначений; обычный `round-robin` его не использует. Оценка берёт самое горячее из окон 5 часов, недели и 30 дней. `0` отключает только переключение по использованию, но не назначение непривязанных задач и не восстановление после сбоев. |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Стратегия назначения для новых/непривязанных запросов Codex. Запрос непривязан, если у него нет live affinity `(parent thread id, quota scope)`; видимая существующая задача может стать непривязанной после перезапуска прокси или сброса affinity. `quota` выбирает подходящий аккаунт с наименьшим известным usage, когда активного аккаунта нет, сохраняет подходящий активный аккаунт ниже `autoSwitchThreshold`, а после порога может перевести непривязанный запрос или следующий запрос привязанной задачи на подходящий аккаунт с меньшим usage. `round-robin` равномерно распределяет непривязанные запросы; `fill-first` назначает их активному аккаунту до cooldown, недоступности или порога исчерпания. |
| `accountPoolStickyLimit?` | `number` | `1` | Число назначений новых/непривязанных задач на одном выборе round-robin перед переходом дальше. Счётчик растёт при привязке задачи, а не после успеха upstream. Диапазон 1–100; только при `accountPoolStrategy` = `round-robin`. |
| `upstreamFailoverThreshold?` | `number` | `3` | Сколько подряд transient failure допустить, прежде чем новые сессии начнут делать failover. `0` отключает эту логику. Для обычных Responses-запросов и нативных compact-отправок доказанные ошибки доступности DNS/TCP до соединения учитываются на уровне пары «провайдер, хост» и не влияют на здоровье аккаунта, кулдауны аккаунта, привязку потока/сессии, выбор активного аккаунта или маршрутизацию пула, а также не учитываются в этом пороге. |
| `upstreamHostCircuitThreshold?` | `number` | `0` | Опциональный порог circuit breaker для доказанных DNS/TCP-сбоев до соединения в нативных OpenAI forward Responses- и compact-отправках. `0` отключает его; `1`–`20` открывает 30-секундный cooldown для provider-origin после такого числа завершившихся логических запросов. Пока circuit открыт, до выбора аккаунта и upstream-отправки возвращается `503` с `Retry-After`; после cooldown допускается один half-open запрос. Таймауты и HTTP-ответы не учитываются, а любой HTTP-ответ закрывает circuit. Применяется только к маршрутизации Codex Pool без закреплённого аккаунта; при `codexAccountMode: "direct"` и для селекторов с указанием аккаунта схема не активна. |
| `modelCacheTtlMs?` | `number` | `300000` | Окно свежести для кэша `/models` на уровне провайдера. |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Политика prompt-cache Anthropic: отключено, 5-минутный ephemeral или 1-часовой extended. |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | off | Необязательная политика proactive OAuth refresh и warmup'а аккаунтов Codex. |

Имена селекторов — выбранные пользователем публичные метки; opencodex не придаёт им семантики ролей
аккаунтов. Ключи `codexAccountNamespaces` имеют длину 1–64 символа. Они должны начинаться и
заканчиваться ASCII-буквой или цифрой; внутри разрешены буквы, цифры, `.`, `_` и `-`. Зарезервированные
имена объектов JavaScript запрещены. Значение — допустимый id аккаунта пула (кроме внутреннего `__main__`)
либо `"@main"` для аккаунта Codex Desktop. Коллизии с provider и зарезервированными `openai` / `combo` / `policy`
проверяются без учёта регистра; namespace-префикс namespaced combo или routing-profile alias не может повторять селектор.
Настроенные id пула и цели других селекторов также нельзя повторно использовать как селектор. Сохраняйте
raw id аккаунтов и email приватными, а селектор используйте как публичное имя. Поведение и приоритет
явного выбора описаны в разделе [Конфигурация маршрутизации](/reference/configuration/routing/).

Элемент управления на странице Codex Auth владеет map только тогда, когда в ней явно задано поле
`codexAccountPickerEnabled`. При включении пустой управляемой map создаются privacy-safe селекторы;
при последующем добавлении аккаунтов map расширяется даже тогда, когда строки picker'а скрыты, и
существующие селекторы не переименовываются. Написанная вручную map без этого поля остаётся ручной и
никогда не расширяется автоматически. При удалении аккаунта его сопоставление сохраняется: exact
route fail closed, пока аккаунт отсутствует, а повторное добавление того же id восстанавливает
прежний публичный селектор вместо создания нового.

## Зарезервированные провайдеры OpenAI

`openai` и `openai-apikey` — это фиксированные зарезервированные id. `openai.codexAccountMode`
по умолчанию равен `"pool"` и выбирает между основным и добавленными аккаунтами; `"direct"`
использует только текущий login вызывающей стороны / основной login. Уровень API использует только
свой настроенный API-key или key-pool. Используйте bare-model либо `openai-apikey/<model>`;
cross-route credential fallback не существует. Строки API GPT-5.6 несут метаданные контекста
922,000 / max input 922,000, а виртуальные Pro-id переписываются в базовую wire-модель с
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
| `requestPacing?` | `{ enabled, requestsPerMinute?, minIntervalMs?, models? }` | Опциональное клиентское выравнивание начала исходящих запросов, отдельное от учёта использования, биллинга и индикаторов rate limit апстрима. Лимит провайдера действует на все модели, а `models` сопоставляется с точными ID моделей апстрима и может только увеличить задержку. Ожидание очереди не расходует таймаут заголовков ответа. Поддерживаются HTTP, Responses WebSocket и явные вызовы адаптеров `fetchResponse`/`runTurn`. |
| `responsesPath?` | `string` | Relative resource path для key-auth запросов `openai-responses`. Должен начинаться с `/` и не может содержать scheme, query или fragment. |
| `supportsServiceTier?` | `boolean` | Три состояния поддержки `service_tier`. `true`: fast mode может подставлять поле, значения вызывающего сохраняются. `false`: поле удаляется и никогда не подставляется (апстрим, для которого задокументировано отсутствие поддержки, не должен его получать). Не задано: провайдер не классифицирован — значения вызывающего сохраняются без изменений, fast mode не подставляет. Registry классифицирует canonical OpenAI (`true`), DeepSeek и Volcengine Ark (`false`); задавайте явно только для custom gateway'ев, реально поддерживающих tier'ы. |
| `preserveResponsesReasoningContent?` | `boolean` | Сохранять plaintext reasoning content в replay'нутых Responses reasoning item'ах вместо очистки (очистка — правило ChatGPT backend'а). Включайте для upstream'ов, чей контракт принимает reasoning replay, например DeepSeek. Proxy-minted `ocxr1` envelope'ы удаляются всегда. |
| `disabled?` | `boolean` | Сохранить провайдера на диске, но исключить его из routing'а и из model/catalog-listing'ов. |
| `apiKey?` | `string` | API-key либо ссылка `${ENV_VAR}` / `$ENV_VAR`, разрешаемая при каждом запросе. |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Header-style для ключа Anthropic. По умолчанию нативный `x-api-key`; допустим только для key-auth-провайдеров `anthropic`. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | Пул из нескольких ключей. `apiKey` зеркалит активную запись; каждый элемент содержит `id`, `key`, необязательный `label` и необязательное числовое `addedAt`. |
| `defaultModel?` | `string` | Модель, используемая когда этот провайдер выбран без явной модели. |
| `models?` | `string[]` | Seed/fallback-список моделей. При `liveModels: false` это и есть единственный список обнаруженных моделей. |
| `liveModels?` | `boolean` | Получать live-каталог на start/sync (по умолчанию `true`). Custom-провайдеры используют `${baseUrl}/models`; built-in могут использовать registry URL и дополнительно фильтровать результат. |
| `selectedModels?` | `string[]` | Allowlist каталога после discovery. Непустой список показывает только эти id; пустой или отсутствующий показывает всё, что было обнаружено. |
| `contextWindow?` | `number` | Значение контекста для всего провайдера, применяемое когда upstream не отдаёт metadata; при наличии metadata работает как cap и сохраняет более маленькое live-значение. Панель Models настраивает его отдельно от `providerContextCaps`. |
| `modelContextWindows?` | `Record<string, number>` | Значения и cap'ы контекста по отдельным моделям. Перекрывают `contextWindow`: если окно неизвестно, берётся заданное значение, а более маленькая live-metadata остаётся авторитетной. |
| `modelInputModalities?` | `Record<string, string[]>` | Подсказки modality по модели, например `["text"]` или `["text", "image"]`. |
| `modelMaxInputTokens?` | `Record<string, number>` | Положительные лимиты max input по моделям, используемые для подсказок auto-compaction в каталоге. |
| `defaultMaxOutputTokens?` | `number` | Provider-wide fallback для `openai-chat`, когда клиент не передал `max_output_tokens`. |
| `modelMaxOutputTokens?` | `Record<string, number>` | Положительные fallback-budget'ы `openai-chat` по моделям; exact/pattern-match имеет приоритет над provider-default. |
| `modelCosts?` | `Record<string, Cost4>` | Отображаемые цены по моделям (USD за 1M токенов), ключ — точный upstream id модели этого провайдера (не идентификатор провайдера и не маршрутизируемая метка `provider/model`), значение — четыре поля: `input`, `output`, `cacheRead`, `cacheWrite` (пример: `{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`). Любой id допустим — кастомный провайдер может указывать на любой OpenAI-совместимый endpoint через адаптер `openai-chat`, а локальные и внутренние провайдеры работают даже без строки во встроенных каталогах. Пользовательские цены имеют приоритет над встроенными каталогами в оценках `~$` в Logs и Usage; исторические записи пересчитываются по текущему оверлею, поэтому изменение цены может сдвинуть прошлые суммы (порядок: пользователь → каталог jawcode → expected-price overlay → вендорская цена модели); полностью нулевая запись переходит к следующему источнику. Каждая ставка должна быть неотрицательным конечным числом не более 1 000 000 (USD за 1M токенов); строки вне диапазона отклоняются на управляющей границе и отбрасываются при загрузке. Только оценка для отображения: оверлеи не влияют на маршрутизацию, выбор аккаунта, квоты или биллинг. |
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
| `modelAdapters?` | `Record<string, string>` | Wire-override по модели для `openai-chat` или `openai-responses` в gateway с несколькими wire-форматами. Явные записи имеют приоритет над default'ами registry; preset DeepSeek может выбирать native Responses для `deepseek-v4-flash`, а GitHub Copilot объявляет Responses-only default'ы для семейства GPT-5 (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`), потому что эти модели отклоняют `/chat/completions` для агентного трафика. Модели без встроенного default'а (например, `gpt-5.4-nano`) можно включить здесь. Single-wire upstream pin'ы и canonical ChatGPT forward override не принимают. |
| Opt-in xAI Responses (панель) | переключатель | Только для `xai`: атомарно задаёт или удаляет записи `modelAdapters` для `grok-4.5` и `grok-4.6`. Одна запись отображается как смешанное состояние до следующего переключения. Остальные override и поведение tier не меняются. |
| `modelPreferHostedTools?` | `Record<string,string[]>` | Opt-in для точного model ID в non-forward Responses gateway, который резервирует namespace hosted tool. Сейчас допускается только `["image_generation"]`; совпавшая модель должна использовать wire `openai-responses` и поддерживать этот hosted tool. Прокси удаляет конфликтующие клиентские объявления `image_gen` и переписывает их selectors, сохраняя caller tool choice. Для виртуальных моделей OpenAI API `-pro` сначала сопоставляется выбранный публичный ID, а затем в качестве fallback используется ID базовой wire-модели. `modelAdapters` сначала разрешается по публичному ID, затем по базовому ID; второй результат определяет итоговый wire. Остальные модели сохраняют обычное alias-поведение. |
| `reasoningEffortMap?` | `Record<string, string>` | Provider-wide wire-alias'ы для reasoning-label'ов. |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | Wire-alias'ы для reasoning-label'ов по отдельным моделям. |
| `reasoningWireFormat?` | `"gateway-object"` | Для OpenAI-совместимых шлюзов, принимающих `reasoning: { enabled, effort }` вместо `reasoning_effort`. Пресет ClinePass задаёт это автоматически. |
| `noReasoningModels?` | `string[]` | Модели, отвергающие параметры reasoning/thinking. |
| `noTemperatureModels?` | `string[]` | Модели, отвергающие переданный вызывающей стороной `temperature`. |
| `noTopPModels?` | `string[]` | Модели, отвергающие переданный вызывающей стороной `top_p`. |
| `noPenaltyModels?` | `string[]` | Модели, отвергающие penalty presence/frequency. |
| `noStructuredOutputModels?` | `string[]` | Точные идентификаторы моделей, чей endpoint `openai-chat` отклоняет `response_format`. Поле опускается только при точном совпадении запрошенной модели; для остальных моделей `openai-chat` преобразование structured output остаётся включённым. |
| `parallelToolCalls?` | `boolean` | Переключатель parallel tool call'ов. Для OpenAI Chat по умолчанию включено; не-chat adapter'ы рекламируют это только при явном `true`. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean; repairInvalidIds?: boolean }` | По умолчанию выключенная downstream SSE-repair для exact placeholder-id, отсутствующих terminal-id и (с `repairInvalidIds`) message/reasoning id без канонического префикса `msg_`/`rs_`. Function-call id никогда не переписываются. Встроенный DeepSeek включает последние два по умолчанию. |
| `responsesSnapshotRepair?` | `boolean` | По умолчанию выключенная клиентская repair для неполных lifecycle snapshot'ов Responses в SSE и JSON. Добавляет отсутствующие status, output и tool metadata, не меняя raw inspection и persistence. |
| `retryOn429?` | `{ enabled?: boolean; attempts?: number; intervalMs?: number; maxIntervalMs?: number; respectRetryAfter?: boolean }` | Только для провайдеров с API-ключом (`authMode: "key"`). Опциональный повтор при 429 на том же таргете: если `retryOn429` отсутствует, функция выключена; наличие объекта включает её, если только `enabled: false`. При 429: ожидание (`Retry-After` апстрима или фиксированный интервал) и повтор идентичного запроса на том же ключе до любого фейловера ключей — покрывает основной цикл восстановления текстовых ходов, passthrough-канал Responses, мост изображений/видео, sidecar web-search и терминальные продолжения. Повтор допустим только для HTTP 429, полученных до начала потока; пользовательские транспорты `runTurn` не входят в цикл HTTP-повторов. `attempts` — это число повторов на том же ключе после первого 429 (всего отправок = `attempts` + 1) и единый бюджет на запрос, общий для основного цикла восстановления, терминального продолжения и повторов моста. Исчерпание `attempts` лишь останавливает дальнейшие повторы на том же ключе; далее применяется обычный фейловер ключей или финальная обработка ошибки в зависимости от доступных таргетов — на passthrough-канале с ключевой аутентификацией фейловера нет, поэтому исчерпанный 429 возвращается как есть. Codex сам никогда не повторяет 429, поэтому это единственная защита для провайдеров с одним ключом. По умолчанию: `enabled: true`, `attempts: 3`, `intervalMs: 5000`, `maxIntervalMs: 60000` (любое ожидание ограничено `maxIntervalMs`, который сам ограничен 600000), `respectRetryAfter: true`. |
| `autoToolChoiceOnlyModels?` | `string[]` | Модели, у которых `tool_choice` принимает только `auto` или `none`; forced choice понижается. |
| `preserveReasoningContentModels?` | `string[]` | Модели, которым нужен предыдущий assistant `reasoning_content` в chat history. |
| `requiresReasoningPlaceholderModels?` | `string[]` | Модели, чей upstream отклоняет tool_call-продолжение без `reasoning_content` (DeepSeek thinking mode); при промахе replay-кэша подставляется минимальный placeholder. По умолчанию наследует `preserveReasoningContentModels`; `[]` отключает явно. |
| `thinkingToggleModels?` | `string[]` | Chat-модели, использующие `thinking.enabled` вместо effort-ladder. |
| `thinkingBudgetModels?` | `string[]` | Chat-модели, использующие целочисленный `thinking_budget`; effort отображается в долю бюджета. |
| `noVisionModels?` | `string[]` | Text-only-модели, идущие через vision sidecar; при сопоставлении tolerируется тег Ollama вида `:size`. |
| `escapeBuiltinToolNames?` | `boolean` | Экранировать built-in tool name'ы для Anthropic-compatible gateway'ев и восстанавливать их в возвращаемых call'ах. |
| `anthropicEofTolerance?` | `boolean` | Позволяет Anthropic-совместимому шлюзу завершить поток до `message_stop`, только если получен видимый текст или полный JSON-объект аргументов инструмента. По умолчанию выключено. |
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
base- и Pro-id с context `922000` и max input `922000`; OpenRouter заранее засевает
`openai/gpt-5.6-sol`, `openai/gpt-5.6-terra` и `openai/gpt-5.6-luna` с context `922000`.
Pool/Direct рекламирует `922000`; синхронизированный каталог показывает `max`, сохраняя при этом
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
