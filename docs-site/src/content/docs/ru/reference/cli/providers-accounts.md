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
| `edit <name>` | provider field flags, `--headers <json>`, `--json` | Изменить валидированные live-поля провайдера, не заменяя key-pool'ы. `--headers` объединяет пользовательские request-header'ы; передайте `{}` или `-`, чтобы очистить их. |
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

:::caution[Пользовательские заголовки — не канал для учётных данных]
`--headers` предназначен для несекретных метаданных запроса — подсказок
маршрутизации, селекторов тенанта или проекта, идентификаторов трассировки. Это не
место для аутентификационных данных: валидатор отклоняет стандартные имена
заголовков с учётными данными (`Authorization`, `X-Api-Key`, `Cookie` и другие),
указывая на `apiKey` / `authMode`.

Произвольное имя вроде `X-My-Token` валидатор распознать не может, поэтому границу
соблюдает пользователь. Две причины, почему это важно:

- JSON передаётся как аргумент командной строки, поэтому секрет попадает в историю
  оболочки и в список процессов, где его прочитает любой другой процесс на машине —
  ещё до того, как CLI что-либо скроет.
- Значения заголовков сохраняются в `config.json` открытым текстом, в отличие от
  API-ключей с их собственным путём хранения и маскирования.

Для всего секретного используйте `--api-key` или вход через OAuth.
:::

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
Usage: ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.
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
  "priority": 0,
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
`PROVIDER TYPE ID PLAN/LABEL PRIORITY STATUS`; строка Codex, выбранная вручную, помечается `selected`.
Если существует сохранённый аккаунт Kiro, вывод дополнительно отмечает, что у Kiro один слот
логина и новый вход заменит текущий аккаунт. Пустой результат всё равно считается успехом.
`--json` возвращает:

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

Показывает активный аккаунт или ключ. Если в пуле Codex нет ручного pin'а, команда сообщает об
автоматическом выборе с учётом порядка: выбирается самый высокий подходящий уровень, а внутри него при quota-маршрутизации аккаунт с наименьшим usage; если в другом семействе нет активного
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

### `ocx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]`

Читает или задаёт порядок выбора одного аккаунта пула Codex: **больше — используется раньше**,
значение по умолчанию `0`, диапазон от `-100` до `100`. Порядок есть только у пула Codex `openai`,
поэтому другие провайдеры завершаются с кодом 1. `main` указывает на логин Codex Desktop, который
упорядочивается наравне с остальными: `ocx account priority openai main last` оставляет его резервным.

Слова-пресеты заменяют небольшие целые числа: `first` — это `+2`, `earlier` — `+1`, `normal` — `0`,
`later` — `-1`, `last` — `-2`. `reset` возвращает значение по умолчанию и удаляет сохранённую запись.
**Пропуск значения читает** текущий порядок, ничего не записывая.

Порядок определяет, какие аккаунты рассматриваются первыми, а не какие пригодны: выбор по-прежнему
идёт среди подходящих аккаунтов, берётся самый высокий уровень с оставшимся запасом квоты, а внутри
него аккаунт выбирает `accountPoolStrategy`. Пауза, cooldown и повторная аутентификация не
затрагиваются. Изменения действуют начиная со **следующего непривязанного запроса**, а не только для новых сессий:
как только у более высокого порядка снова появляется запас, preemption сразу поднимает непривязанный
запрос. Потоки, уже привязанные к аккаунту, обычно сохраняют его до исчерпания, но ошибка повторной аутентификации, cooldown по квоте или серия временных сбоев снимают привязку раньше.
Любая принятая запись также снимает ручное закрепление "использовать этот аккаунт сейчас" с того аккаунта, на котором оно стояло. Это касается и записи того же порядка, который уже был установлен. Такой способ — единственный, который снимает закрепление, сохранив выбранный аккаунт. Сброс активного аккаунта через management API тоже снимает закрепление, но вместе с самим выбором. Недоступный прокси, неизвестный id аккаунта или значение вне допустимого набора завершаются
с кодом 1. `--json` возвращает:

```text
{ ok: true, provider, id, priority: number, preset: string | null }
```


### `ocx account login|reauth|code|cancel ...`

Запускать browser-based или manual-code account-authentication из headless-shell. Для
provider-specific формы команды используйте `ocx account --help`. Если login аккаунта Codex
сохранён, но обновление каталога моделей ещё не завершилось, human-readable вывод по-прежнему
завершается успешно и печатает в stderr фиксированную рекомендацию `ocx sync`. С `--json` stdout
остаётся пригодным для парсинга, а завершённый login-state содержит
`catalogRefreshPending: true` без human-readable предупреждения.

### `ocx account remove <provider> <id|main> --yes [--json]`

Это защищённое неинтерактивное удаление требует `--yes`. Перед удалением оно проверяет, что id
существует; если id отсутствует, команда завершается кодом 1 и DELETE даже не отправляется.
Главный логин Codex App удалить нельзя, поэтому `remove openai main --yes` отклоняется. После
удаления семейство перечитывается заново: удаление pinned-аккаунта Codex очищает pin и возвращает
автоматический выбор; OAuth повышает в active первый оставшийся аккаунт либо сообщает, что их не
осталось; API-key pool продвигает первый оставшийся ключ либо сообщает об отсутствии ключей.
Формы успеха и неудачи в `--json`:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null, catalogRefreshPending?: boolean }
{ error: string } // stderr, exit 1
```

`catalogRefreshPending` присутствует только при удалении аккаунтов Codex. Значение `true` означает,
что удаление уже сохранено; human-readable вывод печатает в stderr общую рекомендацию `ocx sync` и
по-прежнему завершается с кодом 0. Форматы удаления OAuth-аккаунтов и API-key не меняются.

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

### `ocx account main <subcommand>`

Управлять именованными профилями нативного основного логина Codex, не изменяя маршрутизацию пула аккаунтов OpenCodex.

```text
ocx account main doctor [--json]
ocx account main list [--json]
ocx account main register <label> [--json]
ocx account main add <label>
ocx account main switch <profile-id-or-label> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

Каждая изменяющая команда показывает канонический эффективный `CODEX_HOME`, возвращенный
работающим прокси. Этот путь может отличаться от `CODEX_HOME` вызывающего процесса; команды с
поддержкой JSON возвращают то же значение в `effectiveCodexHome`.

Версия 1 поддерживает файловую аутентификацию Codex, шифрует сохранённые профили с помощью AES-256-GCM и хранит ключ шифрования в хранилище учётных данных операционной системы. `add` запускает официальный вход Codex в промежуточной среде перед импортом полученных учётных данных. Перед переключением профиля закройте Codex. Успешное переключение сохраняет локальные задачи и историю, после чего Codex необходимо перезапустить. Используйте `doctor` для проверки состояния профилей, а `recover` для завершения или отката прерванного перехода. `switch` принимает ID профиля или его label.

Матрица восстановления v1 охватывает завершение процесса OpenCodex после публикации файла транзакции переименованием. Она не заявляет устойчивость при сбое ОС или ядра либо внезапном отключении питания: `atomicWriteFileAsync()` не вызывает `fsync` ни для файла, ни для родительского каталога.

Зашифрованное хранилище (vault), журнал переключения, маркер восстановления и файл карантина журнала находятся в каноническом каталоге `<real CODEX_HOME>/.opencodex-native-main-profiles`. Поэтому все экземпляры OpenCodex, использующие один и тот же Codex home, видят одного владельца и одно состояние восстановления. Промежуточные данные входа в незашифрованном виде остаются изолированными в каталоге `<OPENCODEX_HOME>/native-main-profile-staging` каждого экземпляра.

До допуска трафика native-main или восстановления по журналу владелец на весь срок жизни получает исключительное право на учётные данные и удаляет только остаточные после сбоя файлы, имена которых точно соответствуют `auth.json.ocx.<pid>.<sequence>.tmp`. Каждый файл-кандидат должен оставаться обычным файлом ровно с одной жёсткой ссылкой внутри неизменившегося канонического `CODEX_HOME`; его усекают, сбрасывают его буферы, а затем удаляют ссылку на него (unlink). Подмена ссылкой или точкой повторной обработки (reparse point), изменение идентификационных данных файла или любая другая неоднозначность сохраняют запрет на трафик native-main; файлы с лишь похожими именами никогда не удаляются автоматически. Эта защита рассчитана на сбои добросовестно взаимодействующих экземпляров OpenCodex, а не на вредоносный процесс, уже запущенный от имени того же пользователя ОС. Этот пользователь и файловая система, содержащая `CODEX_HOME`, остаются доверенными, а усечение файла не гарантирует физического стирания данных из хранилища с копированием при записи, снимков или остаточных данных SSD.

Предварительные сборки использовали `<OPENCODEX_HOME>/native-main-profiles`. Эта схема никогда не импортируется без явного действия. Если `doctor` сообщает о состоянии профилей старого формата, остановите все прокси OpenCodex, использующие тот же `CODEX_HOME`. Затем создайте резервную копию и вместе переместите соответствующие `*.vault.json`, `*.journal.json`, маркер восстановления и любой указанный файл карантина журнала в канонический каталог, сохранив права доступа только для владельца. Либо удалите старый набор файлов предварительной версии и снова выполните `ocx account main register`. Пока работает хотя бы один прокси, использующий тот же `CODEX_HOME`, не выбирайте один из нескольких старых корневых каталогов и не используйте обе схемы одновременно. В Windows состояние предварительной версии, привязанное к прежнему идентификатору домашнего каталога без учёта регистра, необходимо сбросить, а не перемещать, поскольку его зашифрованные AAD и идентификатор в системном хранилище ключей намеренно не используются повторно.

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
| `context <status\|value <tokens> [--set-all]\|provider <name> on [--value <tokens>]\|provider <name> off\|all <on\|off>>` | `--json` | Прочитать или задать context-window cap глобально либо по провайдерам. `value <tokens> --set-all` также переустанавливает значение для всех маршрутизируемых провайдеров (как переключатель дашборда); без него меняется только значение по умолчанию. `provider ... on --value <tokens>` задаёт отдельный cap только для этого провайдера (`--value` допустим только с `on`). |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Прочитать или задать модель-замену для background helper-call'ов Codex. `-` очищает модель. `status` также показывает `sourceModels` — helper-slug'и, которые перехватывает proxy (по умолчанию `gpt-5.6-luna`; `gpt-5.4-mini` для клиентов до 0.144.x включительно можно восстановить явным переопределением `sourceModels`). |

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
