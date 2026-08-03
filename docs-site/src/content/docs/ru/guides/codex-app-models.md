---
title: Селектор моделей Codex App
description: Как модели opencodex появляются в Codex App, Codex CLI и Codex TUI через общий каталог Codex.
---

opencodex не патчит Codex App. Он записывает ту же конфигурацию Codex и тот же каталог моделей,
которыми уже пользуются Codex CLI/TUI. Поскольку Codex App читает это общее состояние,
маршрутизируемые модели могут появляться в picker'е App как обычные записи каталога Codex.

У записей OpenAI есть две стабильные идентичности: одна «голая» нативная группа `openai`, где
выбор аккаунта Pool(default) или Direct управляется `codexAccountMode`, и namespaced-транспорт
API-ключа `openai-apikey/<model>`. Переключение account mode не меняет id в picker'е. У строк API
GPT-5.6 — контекст 1,050,000 и максимум входа 922,000; id picker'а вида `*-pro` разрешаются в
базовую wire-модель с `reasoning.mode: "pro"`, а логи, usage и picker state сохраняют виртуальный
id. Каталог API жёстко ограничен ровно восемью id: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna и тремя
виртуальными Pro-id; обобщённого alias `gpt-5.6-pro` не существует. Compact-запросы сохраняют
выбранный tier, но отправляют базовую модель без объекта reasoning.

Явно выбирайте маршрут credential; Pool/Direct переключается на странице Providers:

```text
gpt-5.6-sol                         # openai (Pool or Direct option)
openai-apikey/gpt-5.6-sol           # API key
```

Свежие установки и конфигурации без сохранённого режима по умолчанию используют Pool. Текущие
конфигурации помечены marker 2 и сохраняют исходник shipped v1 в
`~/.opencodex/config.json.pre-openai-tiers-v2.bak`; вернуть его можно так:

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

Более ранние трёхпровайдерные конфигурации v1 автоматически мигрируют в одну строку с
переключаемым режимом.

## Путь интеграции

`ocx init`, `ocx start` и `ocx sync` подключают общий конфиг и каталог Codex к прокси; подробности
о внедрении конфигурации, синхронизации каталога, shim'ах, fallback с WebSocket и механике
восстановления см. в [Интеграции с Codex](/guides/codex-integration/).

## Почему появляются маршрутизируемые модели

Picker моделей Codex ожидает записи каталога в формате Codex. opencodex строит маршрутизируемые
записи, клонируя шаблон нативной модели Codex и затем заменяя идентичность на routed-модель:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

Клон сохраняет поля, нужные строгому парсеру: reasoning level'ы, тип shell, флаги поддержки API и
базовые инструкции. После этого opencodex убирает нативные возможности, которые данный маршрут
не может честно поддержать, включая service-tier metadata OpenAI.

## Текущее покрытие стабильных моделей

Нативный fallback-набор включает `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark` и GPT-5.6 Sol/Terra/Luna. Для семейства GPT-5.5/5.4 opencodex сохраняет
более богатые живые записи установленного каталога Codex и синтезирует только отсутствующую
запись. Bundled upstream-snapshot используется только для GPT-5.6, где он даёт настоящую
per-model identity и метаданные вместо приближения по старому шаблону.

| Маршрут | Id в селекторе и метаданные каталога |
| --- | --- |
| Вход Codex (Pool или Direct) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (окно каталога 372 000 токенов) |
| OpenAI (API key) | Ровно восемь namespaced-строк: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna и три виртуальных id `*-pro` (контекст 1,050,000; максимум входа 922,000 у всех восьми) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (1,050,000) |
| Cursor | Статический fallback включает `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra` и `cursor/gpt-5.6-luna` (1,000,000), а также `cursor/grok-4.5` и `cursor/grok-4.5-fast` (500,000); какие из них останутся видимыми, решает live-discovery аккаунта. |
| xAI | Live-discovery авторитетно; fallback-каталог по умолчанию содержит `xai/grok-4.5` с окном 500,000 токенов и reasoning-control `low` / `medium` / `high`. |

Закреплённые записи GPT-5.6 сохраняют точную upstream-лестницу. Sol и Terra дают диапазон от
`low` до `ultra`; у Luna верхняя ступень — `max`. По умолчанию у Sol стоит `low`, а у Terra и
Luna — `medium`. `ultra` — это клиентский выбор для максимального reasoning плюс proactive
delegation и на backend он уходит как `max`. Наличие записи в picker'е означает лишь готовность
каталога: подключённый аккаунт или API-ключ всё равно должен иметь право пользоваться этой
моделью.

## Переключатели нативных и маршрутизируемых моделей

Страница Models в дашборде использует `disabledModels` для обоих семейств моделей:

- Routed-id имеют пространство имён (`provider/model`). Если отключить такую модель, она
  исключается из синхронизируемого каталога и из `/v1/models`.
- Нативные GPT-id — это bare slug. Их отключение сохраняет запись каталога, но переводит
  `visibility` в `hide`, чтобы потом можно было вернуть её в точности; bare OpenAI-list shape
  при этом опускает модель из выдачи.
- Нативные строки берутся из поддерживаемого статического набора, поэтому отключённая нативная
  модель остаётся видимой в дашборде и её можно включить снова.

Проход по видимости выполняется после обновления snapshot'ов, а management API после такого
переключения обновляет каталог и принудительно делает кэш моделей Codex устаревшим.

## Режим multi-agent surface

Элемент v1/base/v2 на странице Models меняет collaboration surface, которую использует каждая
запись picker'а Codex; каноническое описание режима, делегирования, наследования, fallback и
поведения encrypted task см. в [Поверхности подагентов](/guides/sub-agent-surface/).

## Верхние reasoning-tier'ы

Видимость reasoning-tier'ов не зависит от режима поверхности v1/base/v2. Сгенерированные записи,
умеющие reasoning, объявляют `max`, чтобы прямые effort-override для подагентов проходили
валидацию; текущие сгенерированные routed-записи и более старые нативные GPT-записи также
объявляют `ultra`. Точные upstream-лестницы GPT-5.6 сохраняются, поэтому у Luna есть `max`, но
нет `ultra`.

На wire-уровне маршрутизирующие адаптеры сопоставляют или ограничивают неподдерживаемые tier'ы.
Для более старых нативных моделей, у которых реальная лестница заканчивается на `xhigh`,
`nativeEffortClamp` переводит прямой выбор `max` или `ultra` в `xhigh` (например, у GPT-5.5). У
Sol, Terra и Luna есть настоящая ступень `max`.

## Правила fast-tier

Codex хранит fast-mode так:

```toml
service_tier = "fast"

[features]
fast_mode = true
```

Но каталог моделей и id tier'а во время выполнения используют `priority`. opencodex сохраняет это
разделение. Нативные passthrough-модели OpenAI сохраняют поддержку fast; routed-провайдеры ограничены
capability-гейтом — `service_tier` удаляется только когда провайдер объявил `supportsServiceTier: false` (registry классифицирует canonical OpenAI как `true`, DeepSeek и Volcengine Ark как `false`); неклассифицированные custom gateway'и сохраняют значения вызывающего без изменений и не получают подстановку.
Так что опция fast не рекламируется там, где её нельзя выполнить, а custom gateway'и могут включить её явно через `true`.

## Выбор подагентов

Codex сортирует видимые в picker'е записи каталога по возрастанию `priority` и рекламирует первые
пять как model-override для `spawn_agent`. Выберите до пяти bare native-id или namespaced-id
`provider/model` через `subagentModels` или страницу Subagents дашборда; opencodex присвоит этим
записям приоритеты 0-4 в выбранном порядке. Остальные модели всё равно можно вызывать по
точному id.

Список featured-моделей отделён от выбора **Sub-agent delegation** в дашборде. Он только
определяет, какие override Codex показывает первыми; он не выбирает модель и не инициирует
делегирование сам по себе.

## Обновление состояния моделей

Если picker всё ещё показывает устаревшие записи, обновите каталог и перезапустите нужную
поверхность Codex:

```bash
ocx sync
```

Каждый раз, когда меняются видимость, priority или metadata каталога, opencodex переписывает
`models_cache.json` с намеренно устаревшей cache-wrapper, чтобы следующее обновление моделей в
Codex прочитало новый каталог.
