---
title: CLI для провайдеров, аккаунтов и моделей
description: Команды для конфигурации провайдеров, credential'ов, quota и каталога моделей.
---

Эти команды настраивают upstream-провайдеров, аутентифицируют аккаунты, управляют credential
pool'ами и контролируют каталог моделей, который видит Codex.

## Провайдеры

### `ocx provider <subcommand>`

Неинтерактивное управление провайдерами. Записи из registry задаются по имени; для custom-имени
нужно одновременно передать и `--adapter`, и `--base-url`.

| Подкоманда | Поддерживаемые флаги | Действие |
| --- | --- | --- |
| `list` | `--json` | Показать настроенных провайдеров и оставшиеся записи registry. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | Добавить registry/custom-провайдера. `--force` перезаписывает; `--sync` обновляет живой прокси в human-output mode. |
| `edit <name>` | provider field flags, `--json` | Изменить валидированные live-поля провайдера, не заменяя key-pool'ы. |
| `test <name>` | `--json` | Пробный запрос к реальному upstream model-endpoint'у. |
| `show <name>` | `--json` | Показать конфиг с замаскированными API-key'ами. |
| `remove <name>` | `--json` | Удалить не-default-провайдера; последний провайдер удалить нельзя. |
| `set-default <name>` | `--json` | Сделать существующего провайдера default. |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | Прочитать или обновить allowlist моделей провайдера. |
| `quota` | `--refresh`, `--json` | Прочитать отчёты по quota провайдеров. |
| `presets` | `--json` | Показать provider preset'ы дашборда. |
| `account-mode` | `pool`, `direct`, `--json` | Выбрать pooled или direct routing для аккаунтов Codex. |

```bash
ocx provider list --json
ocx provider test ark
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

## Аутентификация

### `ocx login <provider>`

Запустить зарегистрированный login-flow провайдера. OAuth-провайдеры открывают браузер и
сохраняют auto-refreshed credential'ы в `~/.opencodex/`; API-key login-провайдеры открывают свою
key-dashboard, запрашивают ключ, по возможности валидируют его и сохраняют результат в конфиг
провайдера. Если имя отсутствует или неизвестно, команда печатает список принимаемых id OAuth- и
API-key-провайдеров.

Ту же команду используйте и для **reauthentication**, когда `ocx status` / `ocx doctor`
сообщают, что нужна переавторизация или refresh завершился терминальной ошибкой (либо используйте
Reauthenticate в дашборде). Аккаунты пула Codex не являются публичным провайдером для `ocx login`
— переавторизовать их нужно либо через пул аккаунтов Codex в дашборде, либо через headless-flow
`ocx account reauth`.

```bash
ocx login xai
ocx login anthropic
```

### `ocx logout <provider>`

Удалить сохранённый OAuth credential провайдера.

## Аккаунты и key pool'ы

### `ocx account <subcommand>`

Показывать и переключать provider-account'ы и API-key pool'ы через работающий прокси.
Поставляемая help-surface выглядит так:

```text
Usage: ocx account <list|current|use|refresh|auto-switch|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.
reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.
Codex pool selection applies to the next request after clearing existing affinity; in-flight requests keep their captured account.
```

Все подкоманды требуют запущенного прокси; CLI сам определяет записанный runtime-port. Успешные
операции завершаются с кодом 0. Некорректное использование, неизвестный провайдер, account/key id,
недостижимый прокси или ошибка API приводят к коду 1. Поля credential'ов выводятся ровно в том
виде, как их возвращает management API (включая его masking); сырые API-key'и и OAuth-token'ы
никогда не возвращаются. Display convenience синтезируется на стороне клиента, как и в дашборде:
`main` — это alias CLI для логина Codex App внутри пула `openai`, OAuth-аккаунты без email
показываются как `Account N`, а колонка plan/label делает fallback между plan, masked email,
label и masked key.

Строки аккаунтов в `--json` используют такую общую форму (необязательные поля опускаются, если их
нет):

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account list [provider] [--json] [--all]`

Без провайдера команда показывает пул Codex, OAuth-аккаунты и настроенные API-key pool'ы.
Пустые провайдеры пропускаются, если не задан `--all`. С провайдером выводится только это
семейство credential'ов. Human-output использует формат
`PROVIDER TYPE ID PLAN/LABEL STATUS`; строка Codex, выбранная вручную, помечается `selected`.
Если существует сохранённый аккаунт Kiro, вывод дополнительно отмечает, что у Kiro один слот
логина и новый вход заменит текущий аккаунт. Пустой результат всё равно считается успехом.
`--json` возвращает:

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

Показывает активный аккаунт или ключ. Если в пуле Codex нет ручного pin'а, команда сообщает об
автоматическом выборе аккаунта с наименьшим usage; если в другом семействе нет активного
credential'а, это состояние тоже печатается, но код выхода всё равно остаётся 0. `--json`
возвращает:

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|main> [--json]`

Выбирает существующий аккаунт Codex, OAuth-аккаунт или API-ключ. Для `openai` значение `main`
выбирает вход Codex App. Выбор Codex Pool очищает process-local affinity и применяется к следующему запросу, включая запрос существующей видимой задачи; после перезапуска прокси или affinity eviction задача также может стать непривязанной, а выполняющиеся запросы сохраняют захваченный аккаунт. Это управляет только Pool routing; Direct mode продолжает использовать caller-owned/native main credential. Проактивное переключение по использованию, повторная аутентификация 401/403, cooldown 429/retry-after, исключение и восстановление после отказа 429/402 до вывода могут позже выбрать другой подходящий Pool-аккаунт. Эти пути восстановления остаются активными, когда переключение по использованию выключено. После смены аккаунта OpenCodex воспроизводит контекст разговора, но prompt cache провайдера может потребовать прогрева. Неизвестные провайдеры
или id завершаются с кодом 1. `--json` возвращает:
При **401/403** локальная для процесса привязка к аккаунту сбрасывается и требуется повторная аутентификация.
При **429** учитывается `Retry-After`, для аккаунта запускается cooldown, привязка сбрасывается,
после чего запрос может перейти на другой подходящий аккаунт Pool. Эти переходы восстановления
остаются активными при `autoSwitchThreshold: 0`; значение `0` отключает только проактивное переключение по использованию.

```text
{ ok: true, provider, type, activeId }
```

### `ocx account refresh <provider> [--json]`

Для пула Codex используйте `ocx account refresh openai [--json]`. Команда принудительно
обновляет account quota и печатает проценты недельной/месячной квоты и reset-time; отсутствующие
данные о quota сообщаются как unknown, а не как 0%. JSON-envelope имеет форму
`{ accounts: AccountRow[] }`, причём на каждой строке Codex присутствует `quota`.

Для OAuth- и API-key-провайдеров это принудительный refresh endpoint'а provider quota report; это
не token re-login и не простое перечитывание списка аккаунтов. `--json` возвращает
`{ provider, report: ProviderQuotaReport | null }`. Если провайдер не умеет отдавать quota-report,
печатается `no quota report available for <provider>`, а код выхода остаётся 0. Неизвестные
провайдеры и сбои management API дают код 1; если upstream-probe quota не удался или истёк по
таймауту, результат деградирует до `null` или stale report, но остаётся успехом (код 0), как и у
quota-bar'ов дашборда.

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

Управляет только пулом аккаунтов Codex `openai`. `on` ставит 80%, `off` — 0%, `status` читает
текущее значение, а `threshold <n>` принимает целое число от 0 до 100. Для других провайдеров и
некорректных значений команда завершается кодом 1. `--json` возвращает:

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

### `ocx account login|reauth|code|cancel ...`

Запускать browser-based или manual-code account-authentication из headless-shell. Для
provider-specific формы команды используйте `ocx account --help`.

### `ocx account remove <provider> <id|main> --yes [--json]`

Это защищённое неинтерактивное удаление требует `--yes`. Перед удалением оно проверяет, что id
существует; если id отсутствует, команда завершается кодом 1 и DELETE даже не отправляется.
Главный логин Codex App удалить нельзя, поэтому `remove openai main --yes` отклоняется. После
удаления семейство перечитывается заново: удаление pinned-аккаунта Codex очищает pin и возвращает
автоматический выбор; OAuth повышает в active первый оставшийся аккаунт либо сообщает, что их не
осталось; API-key pool продвигает первый оставшийся ключ либо сообщает об отсутствии ключей.
Формы успеха и неудачи в `--json`:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }
{ error: string } // stderr, exit 1
```

### `ocx account add-key <provider> [--label <label>] [--json]`

Добавить и активировать ключ для API-key-провайдера. Ключ читается только из piped/redirected
stdin, который не является TTY; интерактивный TTY-ввод, пустой ввод, OAuth/Codex-провайдеры и
сбои API завершаются кодом 1. Ключ никогда не echo'ится, даже если вы случайно включили его в
label. Предпочитайте secret manager или here-string:

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` возвращает `{ ok: true, id: string | null, label?: string }` и никогда не включает сам
ключ.

### `ocx account reset-credits <id|main> [--consume --yes]`

Проверить reset-credit'ы Codex для аккаунта. Расходование кредита разрушительно и требует сразу
оба флага: и `--consume`, и `--yes`.

## Модели

### `ocx models [subcommand]` · `ocx model <subcommand>`

`ocx model` — alias команды `ocx models`. Без подкоманды команда показывает модели, статически
засеянные в настроенных провайдерах. `--provider` фильтрует один провайдер, а `--json` возвращает
метаданные моделей. `live` читает работающий каталог; `add`, `edit`, `remove` и `list-custom`
управляют ручными записями каталога; `enable`, `disable` и `provider` управляют видимостью;
`selected` управляет allowlist'ом провайдера; `context` — provider context cap'ами; `shadow`
управляет intercept'ом background shadow-call'ов.

Любая per-model операция, которую умеет дашборд, доступна и здесь, так что headless-установке не
нужен GUI для управления каталогом. `add`, `remove` и `list-custom` работают напрямую с файлом
конфига и применяются к работающему прокси через sync каталога; остальные обращаются к live
management API и требуют, чтобы прокси уже работал (`ocx start` или установленная служба).

| Подкоманда | Поддерживаемые флаги | Действие |
| --- | --- | --- |
| `list` (default) | `--provider <name>`, `--json` | Показать модели, засеянные в настроенных провайдерах. |
| `live` | `--provider <name>`, `--json` | Прочитать работающий каталог, включая модели, обнаруженные во время выполнения. Строки помечаются как `native`/`routed`, `custom` и `enabled`/`disabled`. |
| `add <provider> <modelId>` | `--display-name <name>`, `--context-window <tokens>`, `--modalities <text,image,audio>` | Зарегистрировать модель, которую каталог провайдера сам не рекламирует. |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <name\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | Изменить custom-модель. `-` очищает поле; `0` очищает context window. |
| `remove <custom-id\|provider/modelId>` | `--yes` | Удалить custom-модель. В неинтерактивном stdin требует `--yes`. |
| `list-custom` | `--json` | Показать все custom-модели вместе с `custom-id`, который используют остальные подкоманды. |
| `enable <provider/model\|native-model>` | `--native`, `--json` | Сделать одну модель видимой для Codex. |
| `disable <provider/model\|native-model>` | `--native`, `--json` | Скрыть одну модель от Codex. |
| `provider <name> <on\|off>` | `--json` | Включить или выключить сразу все модели одного провайдера одним действием. |
| `selected <provider>` | `--set <id,id...>`, `--clear`, `--json` | Прочитать или заменить allowlist моделей провайдера. `--clear` удаляет allowlist, и тогда доступны все модели. |
| `context <status\|value <tokens>\|provider <name> <on\|off>\|all <on\|off>>` | `--json` | Прочитать или задать context-window cap глобально либо по провайдерам. |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Прочитать или задать модель-замену для background helper-call'ов Codex. `-` очищает модель. `status` также показывает `sourceModels` — helper-slug'и, которые перехватывает proxy (по умолчанию `gpt-5.4-mini` и `gpt-5.6-luna`). |

```bash
ocx models live --json                                  # what Codex can actually see right now
ocx models disable anthropic/claude-haiku-4             # hide one routed model
ocx models enable gpt-5.6-sol                           # no slash, so it is treated as native
ocx models provider zenmux off                          # hide a noisy provider wholesale
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # drop the allowlist again
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # read the custom-id for edit/remove
ocx models remove deepseek/deepseek-v4 --yes
```

Селектор модели со слэшем трактуется как routed (`anthropic/claude-opus-5`); bare-id считается
нативной моделью OpenAI, поэтому `--native` нужен только чтобы принудительно закрепить это
прочтение для id, который иначе выглядел бы как routed.

`--modalities` принимает только `text`, `image` и `audio`. Codex разбирает это поле как closed
enum и отвергает *весь* каталог, если встречает любое другое значение, поэтому `add`, `edit` и
management API запрещают такие значения ещё до записи, а не сохраняют то, что catalog writer
потом был бы вынужден вырезать (#759).
