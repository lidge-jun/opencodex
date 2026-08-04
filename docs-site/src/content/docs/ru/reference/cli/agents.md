---
title: CLI для агентов, маршрутизации и интеграций
description: Multi-agent, combo, observability, access, integration, system и config-команды.
---

Эти команды управляют политикой агентов и routing'ом, проверяют живой прокси и подключают
поддерживаемых клиентов к opencodex.

## Политика агентов

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

Управляйте headless-ростером multi-agent, effort cap'ами, prompt injection, fallback'ом и
настройками sidecar'ов. Для просмотра текущей политики используйте `status`. Как соотносятся
surface mode, delegation, effort и fallback, описано в
[Поверхности подагентов](/guides/sub-agent-surface/).

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
```

### `ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

Управляйте feature flag'ом Codex `multi_agent_v2` и трёхсостоянием multi-agent surface mode.

| Подкоманда | Действие |
| --- | --- |
| `status` (default) | Показать текущий v2 flag, multi-agent mode и thread concurrency. |
| `on` | Включить feature `multi_agent_v2` и пересинхронизировать каталог. |
| `off` | Выключить `multi_agent_v2` и пересинхронизировать каталог. |
| `mode v1` | Принудительно перевести все модели на v1, отключить native v2 и сохранить текущий thread limit. |
| `mode default` | Уважать upstream pin'ы surface у моделей. |
| `mode v2` | Принудительно перевести все модели на v2, включить native v2 и сохранить текущий thread limit. |
| `threads <n>` | Задать активный v1/v2 thread limit как целое число не меньше 1. |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

Подкоманда `mode` записывает `multiAgentMode` в конфиг opencodex и заново синхронизирует каталог
Codex. При переходах mode и feature flag текущий числовой thread limit переносится между
допустимыми ключами Codex для v1/v2; если переход не удался, исходный `config.toml`
восстанавливается. Изменения применяются к новым сессиям Codex, а уже запущенные сохраняют свою
закреплённую surface.

## Combo routing

### `ocx combo <list|show|set|remove> ...` · `ocx route combo ...`

Управляйте virtual-моделями combo с failover и round-robin. `ocx route combo` — это иерархический
alias; на данный момент combo — единственный поддерживаемый routing-resource. Цели используют
форму `provider/model[:weight],provider/model[:weight]`.

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

О поведении маршрутизации и рекомендациях по конфигурации см. [Combos](/guides/combos/).

## Observability и debug

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Проверяйте proxy-request'ы, usage, storage, memory и debug-data. Прямые alias'ы:

| Алиас | Эквивалентный ресурс |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Прочитать или изменить runtime debug-override'ы через management API работающего прокси.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

Без указания scope `ocx debug` печатает usage и, если прокси остановлен, environment-default'ы
для следующего запуска. Provider debug по умолчанию берётся из `OCX_DEBUG=1`
(legacy `OCX_DEBUG_FRAMES=1` тоже работает); usage debug — из `OPENCODEX_USAGE_DEBUG=1`.

## Доступ к API

### `ocx access <key|endpoints|models|test> ...`

Управляйте admission API-key'ами OpenCodex и проверяйте внешние endpoint'ы и модели.
`ocx api-key <list|create|remove> ...` — alias `ocx access key`.

```bash
ocx access key create deployment
```

## Интеграции клиентов

### `ocx integration <claude|grok> ...`

Управляйте поддерживаемыми интеграциями Claude и Grok. Прямые семейства команд ниже
предоставляют элементы управления, специфичные для каждого клиента.

### `ocx claude [claude args...]`

Убедиться, что прокси запущен, а затем запустить Claude Code с `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` и model slot'ами из
`config.claudeCode`. Маршрутизируемые модели появляются в native-picker'е `/model` через стабильные
slot-alias'ы, начиная с Claude Code 2.1.129. На более старых версиях модель выбирается через
`ANTHROPIC_MODEL` или `/model <id>`. Пользовательские `ANTHROPIC_*`, экспортированные в окружение,
всегда имеют приоритет.

Команды для профиля Claude Desktop:

```text
ocx claude desktop [apply]                         Save and apply the four-family profile
ocx claude desktop show [--json]                   Show routes, families, and defaults
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ocx claude desktop import <path> [--apply]         Validate and import JSON
```

Семейства — `opus`, `fable`, `sonnet` и `haiku`; новые маршруты по умолчанию попадают в `opus`.
`none` допустимо только когда соответствующее семейство пусто. Legacy-flags `--static`,
`--hybrid` и `--discovery-only` для apply по-прежнему поддерживаются. Для настроек Claude Code
используйте `ocx claude config <status|set> ...`.

### `ocx opencode [opencode args...]`

Убедиться, что прокси запущен, и затем запустить opencode со сгенерированным блоком
`provider.opencodex` в inline runtime layer OpenCode (`OPENCODE_CONFIG_CONTENT`). Существующая
inline-конфигурация сохраняется, а только `provider.opencodex` заменяется для этого запуска.
Глобальные или проектные `opencode.json` могут читаться, чтобы выдать warning о существующем
override, но файлы на диске никогда не меняются. Маршрутизируемые модели появляются как
`opencodex/<provider>/<model>`. Последующий запуск обычного `opencode` работает ровно как раньше.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Управляйте fence'ом моделей для Grok Build и применяйте его.

## Экспорт client config

### `ocx export --client <opencode|pi>`

Печатает client config, направленный на работающий прокси. opencode и [Pi](/guides/pi/) читают
провайдеров из собственных JSON-конфигов, а не из переменных окружения, поэтому команда
сериализует для вас блок провайдера `opencodex` — base URL, список моделей и env-reference
конкретного клиента.

Прокси должен быть запущен; команда определяет его живой порт, читает `/api/models` и выводит
только те модели, которые сейчас видит Codex.

| Флаг | Действие |
| --- | --- |
| `--client <opencode\|pi>` | Обязателен. Выбирает клиентский диалект: keyed-объект `provider` у opencode или массив `providers` у Pi. |
| `--json` | Печатать только JSON-конфиг в stdout, чтобы redirect сохранял побайтно точный вывод. Вся диагностика, включая заметку о записи через `--out`, идёт в stderr. |
| `--out <path>` | Записать конфиг в `<path>`. Перезаписывать существующий файл не позволит. |
| `--force` | Разрешить `--out` заменить существующий файл. |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # byte-exact JSON for a pipe or a diff
ocx export --client opencode --out ~/opencodex-opencode.json
```

Без `--json` сначала идёт JSON, затем канонический путь назначения, предупреждение о merge, строка
экспорта переменной окружения и количество моделей с указанием, сколько строк не имеют context
limit'а (для них клиент применяет собственные default'ы).

| Клиент | Канонический путь | Имя скачиваемого файла | Переменная окружения |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` имеет приоритет, если задан) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` | `pi-models.json` | `OPENCODEX_API_KEY` |

Имена этих двух env-переменных различаются, и каждый клиент интерполирует только свою. opencode
читает `{env:OPENCODEX_OPENCODE_API_KEY}`; Pi читает `$OPENCODEX_API_KEY`.

:::caution[Сливать, а не заменять]
`ocx export` никогда не пишет в ваш реальный клиентский конфиг. Путь назначения лишь
печатается, чтобы вы вручную выполнили merge, а `--out` без `--force` отказывается перезаписать
существующий файл именно потому, что полная замена уничтожила бы остальные провайдеры, агенты и
MCP-записи.
:::

Никакой ключ никогда не сериализуется. Конфиг несёт только env-reference клиента, так что секрет
остаётся в вашем окружении. Loopback-прокси (`127.0.0.1`, по умолчанию) вообще не требует
admission key — ссылка просто остаётся неиспользованной. Задавайте переменную только если прокси
слушает не на loopback; как выдаются admission key, описано в
[Удалённом доступе](/reference/configuration/#remote-access). Ключи upstream-провайдеров — это
совсем отдельная история и настраиваются в [Провайдерах](/guides/providers/).

Тот же payload отдаётся через `GET /api/client-config` и показывается на вкладке API в дашборде,
поэтому CLI, API и GUI используют в точности одни и те же байты.

## Runtime и configuration

### `ocx system <status|settings|startup|diagnostics|sync|update> ...`

Управляйте headless runtime-setting'ами, startup, sync, diagnostics и update.

```bash
ocx system settings --stream-mode eager-relay
```

### `ocx config <show|get|set|unset|validate|export|import> ...`

Проверяйте и безопасно меняйте валидированную конфигурацию OpenCodex. `show` и `get`
маскируют секреты. Импорт выполняет валидацию перед записью и требует `--yes`.
