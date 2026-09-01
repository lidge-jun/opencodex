---
title: Жизненный цикл CLI
description: Настройка, запуск, остановка, служба, диагностика, sync и update-команды.
---

Эти команды устанавливают, запускают, проверяют, ремонтируют и обновляют локальный прокси
opencodex и его интеграцию с Codex.

## Настройка

### `ocx init` · `ocx setup`

Интерактивный мастер настройки (`setup` — alias команды `init`). Он спрашивает провайдера
(preset или custom), API-key (буквально или `${ENV}`), модель по умолчанию и порт прокси,
сохраняет `~/.opencodex/config.json`; при желании внедряет прокси в
`$CODEX_HOME/config.toml` (по умолчанию `~/.codex/config.toml`) и при необходимости
устанавливает shim автозапуска Codex.

## Жизненный цикл прокси

### `ocx start [--port <port>]`

Запустить proxy server (предпочтительный порт `10100`). Если этот порт занят, opencodex выбирает и
записывает другой свободный порт. При запуске пишется состояние PID/runtime-port, а попытка
поднять второй живой экземпляр отвергается. На старте прокси синхронизирует модели каждого
провайдера в каталог Codex. При shutdown он восстанавливает native Codex — если только прокси не
был запущен как managed service (`OCX_SERVICE=1`).

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

Остановить работающий прокси (по PID), удалить PID-file и восстановить native Codex. Если
установлена managed background service, `ocx stop` сначала останавливает и её, чтобы она не
перезапустила прокси обратно. Кнопка **Stop** в веб-дашборде выполняет то же действие (`POST /api/stop`) на всех бэкендах, кроме планировщика заданий Windows: там обёртка может перезапустить прокси после завершения задачи, поэтому дашборд отказывает с `respawnable_service`, ничего не меняет и просит выполнить `ocx stop`.

### `ocx restart`

Если прокси уже работает, команда запрашивает перезапуск на месте у точно аттестованных PID и
порта, ждёт штатного drain и проверяет появление другого runtime PID на том же порту. Управляемая
маршрутизация и supervision службы сохраняются; неопределённый результат запроса не повторяется как
отдельный stop/start. Если прокси не запущен, используется обычный запуск через `ensure`.
Если работающий слушатель нельзя подтвердить привязкой к runtime PID (включая прокси до обновления),
перезапуск завершается безопасным отказом без `ensure` или stop/start. После проверки владения
выполните `ocx stop`, затем один раз `ocx start`.

### `ocx ensure`

Идемпотентно убедиться, что фоновый прокси запущен, а затем синхронизировать его живой каталог
моделей. Если `codexAutoStart` равен `false`, команда сообщает, что автозапуск отключён, и ничего
не делает.

### `ocx restore [back]` · `ocx eject [back]`

Восстановить native Codex **без** остановки прокси — удалить внедрённые строки конфигурации и
маршрутизируемые записи каталога, чтобы обычный `codex` снова работал нативно. `eject` — alias
команды `restore`.

Передайте `back`, чтобы любая из этих форм снова направила обычный `codex` на уже запущенный
прокси, не меняя жизненный цикл самого прокси:

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai --yes`

Явное восстановление для старых development-сборок, которые переназначали историю Codex App ещё
до появления обратимого backup-механизма. Если база истории Codex заблокирована, сначала
закройте Codex.

Это широкое и разрушительное переименование: все треды с пользовательским сообщением, которые
сейчас помечены `opencodex`, меняются на `openai`, `exec` нормализуется в `cli`, а event marker
устанавливается. Корректная история выделенного провайдера тоже входит в охват. Сначала сделайте
резервную копию и запускайте команду только если нужен весь этот охват.

### `ocx uninstall` · `ocx remove`

Остановить службу и прокси, удалить службу и Codex shim, восстановить native Codex, а затем
удалить локальную конфигурацию opencodex только если все шаги восстановления завершились успешно.
`remove` — alias команды `uninstall`. Очистка конфигурации требует ownership metadata, созданных
при свежей установке; legacy- или shared-directory остаются на месте.

## Status и health

### `ocx status [--json]`

Печатает read-only диагностическую сводку: PID прокси, достижимость `/healthz`, URL дашборда,
путь к конфигу, провайдера по умолчанию, настройку автозапуска Codex, состояние службы, состояние
shim'а и redacted effective Codex home. Только явная и высокоуверенная сигнатура mismatch
runtime-home Windows Orca даёт actionable-warning о несоответствии App-home; `CODEX_HOME`
автоматически при этом не меняется.

В текстовом выводе после сводки OAuth-logins также присутствует блок **OAuth health**:
`OAuth health: ok`, если все известные аккаунты здоровы, либо `OAuth health: warning` с одной
redacted-строкой на каждый нездоровый аккаунт (провайдер, замаскированный id аккаунта, статус
вроде reauthentication required, rate/quota limited или refresh conflict) плюс необязательная
подсказка `Action:`. Идентификаторы маскируются; токены и email никогда не печатаются. В
контракт `--json` этот health-блок пока не входит.

```bash
ocx status
ocx status --json
```

Сокращённая форма JSON:

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

Реальный объект также включает `listen` (порт, hostname, источник runtime/config), диагностику
загрузки конфига и диагностику bundled-plugin'а Codex. JSON-schema только расширяемая: новые
версии могут добавлять поля, но существующие должны оставаться стабильными. Она намеренно не
включает API-key'и, OAuth-token'ы, заголовки авторизации, содержимое запросов, email и
идентификаторы аккаунтов.

### `ocx health [--json]`

Identity-check живого прокси. Текстовый вывод сообщает PID/порт; `--json` отдаёт
`{ok, pid, port}`. Команда завершается кодом 0 только когда прокси здоров, и 1 во всех остальных
случаях, поэтому подходит для service probe.

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

Проверяет готовность после синхронизации через не требующий аутентификации `GET /readyz`. При
готовности возвращается `200`; для `pending` и терминального `failed` возвращается `503` с
`Retry-After: 1`. Санитизированные поля HTTP-ответа: `{service, version, uptime, pid, port, status, protocol, minimumClientProtocol, managementUrl}`. `protocol` — текущая версия удалённого протокола hub, `minimumClientProtocol` — минимальная совместимая версия клиента, а `managementUrl` — канонический origin управления для браузера.
Старые прокси без `/readyz` fail-closed как `unreachable`; `/healthz` — отдельная проверка liveness,
а не готовности. По умолчанию команда выполняет одну пробу. `--wait` опрашивает до готовности или
тайм-аута, но при терминальном `failed` завершается немедленно. Тайм-аут по умолчанию — 45 секунд;
`--timeout <seconds>` требует `--wait` и принимает целые положительные значения 1–300 секунд. CLI JSON выдаёт
`{ready, status, pid, port}`, где `status` — `ready`, `pending`, `failed` или
`unreachable`. Коды завершения: 0 — готово; 1 — не готово, pending, failed, тайм-аут или
недоступность; 64 — недопустимые аргументы.

### `ocx doctor`

Запускает read-only диагностику среды и связности: пути состояний и тип файловой системы,
двойные установки WSL, proxy environment/config, достижимость ChatGPT, предупреждения о plugin'е
и project-config Codex, а также ожидающую миграцию истории. Раздел, касающийся app-home Codex,
тоже обнаруживает узкий mismatch runtime-home Windows Orca и при необходимости объясняет миграцию
службы. Пути в этом выводе маскируют имя пользователя ОС. Doctor печатает подсказки по ремонту,
но ничего не меняет.

Раздел **OAuth reliability** показывает, можно ли записывать credential storage, удаётся ли
создавать refresh single-flight/lock file'ы в `OPENCODEX_HOME`, есть ли нездоровые OAuth- или
Codex-pool-аккаунты (с masked-id) с подсказкой `Action:`, а также статическое OK-подтверждение,
что путь Codex forward не подделывает metadata официального клиента. Doctor никогда не мутирует
credential'ы и не выполняет repair.

## Синхронизация каталога

### `ocx sync [--restart-codex]`

Получить живой список моделей от каждого настроенного провайдера и заново внедрить объединённый
каталог в Codex. Запускайте после добавления провайдера или когда нужно обновить доступные
модели.

Если всё ещё работают долгоживущие процессы Codex `app-server`, `ocx sync` предупредит, что они
могут продолжать отдавать старый in-memory список моделей, хотя файлы
`opencodex-catalog.json` / `models_cache.json` уже обновлены. Передайте `--restart-codex`, чтобы
послать `SIGTERM` только подходящим процессам `codex … app-server` и `codex-code-mode-host`,
принадлежащим текущему пользователю (активные turn'ы при этом могут оборваться). Широкий
`pkill -f codex` намеренно не используется.

### `ocx sync-cache [--restart-codex]`

Инвалидировать локальный кэш model picker'а Codex, чтобы он пересобрался из активного каталога
opencodex. Предупреждение о stale-`app-server` и optional `--restart-codex` работают так же, как
и у `ocx sync`.

## Фоновая служба

### `ocx service [install|repair|restart|start|stop|status|uninstall|remove]`

Запустить opencodex как login-managed background service (macOS **launchd**, Linux **systemd user
unit**, Windows **Task Scheduler**), которая автоматически стартует при логине и сама
перезапускается при crash. Запуски службы выставляют `OCX_SERVICE=1`, чтобы restart не дёргал
конфиг Codex.

| Подкоманда | Действие |
| --- | --- |
| none | Установить и запустить службу, если её нет; иначе обновить и перезапустить существующую службу. Исправная конфигурация Windows Task Scheduler используется повторно; устаревшая может быть перерегистрирована и потребовать повышения прав. |
| `install` | Создать и запустить службу. |
| `repair` | Обновить установленную службу на месте и перезапустить её. Исправная конфигурация Windows Task Scheduler используется повторно; устаревшая может быть перерегистрирована и потребовать повышения прав. |
| `restart` | Псевдоним команды `repair`. |
| `start` | Запустить уже установленную службу. |
| `stop` | Остановить службу и восстановить native Codex. |
| `status` | Показать диагностику службы и прокси, а также пути к логам. |
| `uninstall` | Удалить службу и восстановить native Codex. |
| `remove` | Alias команды `uninstall`. |

```bash
ocx service
ocx service install
ocx service repair
ocx service restart
ocx service status
ocx service uninstall
```

На Windows bare `ocx service` выполняет путь установки только после того, как отсутствие подтверждено и для Task Scheduler, и для WinSW. Если любой из запросов статуса не даёт определённого ответа, он отказывается что-либо регистрировать и предлагает выполнить `ocx service status`; явный `ocx service install` используйте только после подтверждения отсутствия.

На Windows `ocx service status` отдельно показывает регистрацию в Task Scheduler и
identity-проверенную достижимость прокси OpenCodex. Он не печатает локализованную таблицу
`schtasks`, чтобы сводка оставалась читаемой на любых code page Windows.

На Windows создание записи в Task Scheduler требует elevation. Когда распознан локализованный
текст access-denied, остаётся прежний путь guidance. Если текст неразборчив, fallback использует
владение command-shape `/create /tn opencodex-proxy /xml <non-empty-path> /f`, status 1 и
подтверждённый non-elevated token; после этого действие Startup Safety в дашборде может само
запросить UAC. Если fallback не смог определить состояние token'а, он оставляет исходную
scheduler-error. Чужие задачи и чужие операции никогда не получают automatic-elevation marker.
Либо подтвердите UAC через дашборд, либо заново выполните `ocx service install` в elevated
окне PowerShell.

### `ocx codex-shim <install|status|uninstall|remove>`

Обернуть script-based launcher `codex` на `PATH` лёгким автозапусковым скриптом. Настоящие
target'ы `codex.exe` не трогаются, чтобы не ломать точные вызовы исполняемого файла.

Перед фиксацией установки или repair OpenCodex запускает сохранённый launcher с `--version`,
не запуская сервис. Изменение отклоняется и откатывается, если launcher снова разрешает `codex`
в shim, завершается с ненулевым кодом, работает дольше пяти секунд, оставляет дочерние процессы
или не может быть безопасно проверен и очищен. Поэтому `codex-shim install` не является
безусловной установкой. После отказа переустановите Codex так, чтобы запись в `PATH` указывала на
конкретный исполняемый файл или launcher, и повторите попытку. Если динамический launcher
менеджера команд не проходит эти проверки, используйте вместо него `ocx service install`.
При обновлении установленный Unix shim без текущей validation-защиты пересоздаётся и проверяется.
Если сохранённый launcher небезопасен, OpenCodex удаляет устаревший shim и восстанавливает исходный
launcher, а не оставляет небезопасный wrapper установленным.

Если завершённое внешнее обновление Codex перезаписало установленный shim, следующая обычная
команда `ocx` сохранит новый стабильный launcher и восстановит shim перед выполнением запроса.
Не имеющая побочных эффектов команда инспекции `ocx system codex-cli-update check` и некорректные
вызовы зарезервированного пространства `ocx system codex-cli-update` никогда не выполняют этот repair.
Launcher, который всё ещё меняется, не трогается, а попытка откладывается до следующего раза.
Сбои repair'а приводят только к warning и не ломают запрошенную команду; ручной запасной путь —
`ocx codex-shim install`. Чтобы отключить автоматику, задайте `codexShimAutoRestore: false` или
установите `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`.

| Подкоманда | Действие |
| --- | --- |
| `install` | Установить shim (или починить, если он устарел). |
| `uninstall` | Удалить shim и восстановить исходный бинарник Codex. |
| `remove` | Alias команды `uninstall`. |
| `status` | Показать состояние shim'а (installed, stale или missing). |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
Используйте `ocx service` для всегда работающего фонового прокси (рекомендуется). Используйте
`ocx codex-shim` для лёгкого on-demand запуска без демона — в этом случае прокси стартует только
когда запускается `codex`.
:::

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Установить и управлять Windows tray icon со статусом. Иконка стартует при логине в Windows и даёт
one-click управление прокси. `start` и `stop` управляют только иконкой; самим прокси нужно
управлять из её меню. `--no-start` применяется к `install` и устанавливает tray, не запуская её
немедленно.

## Дашборд

### `ocx gui`

Открыть [веб-дашборд](/guides/web-dashboard/) по адресу `http://localhost:<port>`, автоматически
запустив прокси, если он ещё не работает.

## Обновление

`ocx update` обновляет сам OpenCodex, а не Codex CLI. Используйте `ocx system codex-cli-update check` из [system-команд инспекции](/ru/reference/cli/agents/) для ограниченной read-only проверки provenance настроенного кандидата Codex CLI. Команда не обращается к package registry и не устанавливает обновление.

### `ocx update [--tag latest|preview]`

Самообновить opencodex из npm. Стабильные установки используют `@latest`; preview-установки
остаются на `@preview`, если только вы не передадите `--tag latest|preview`. Команда распознаёт
source checkout и предлагает вместо этого `git pull && bun install`, а если у вас уже новейшая
версия для выбранного тега, становится no-op. Для npm-установок до остановки каких-либо процессов
выполняется ограниченная проверка владельца и доступности Unix-кэша. Вложенные символические ссылки
проверяются через `lstat`, но переход по ним не выполняется; в Windows эта Unix-проверка явно
пропускается. При ошибке обновление отменяется, пока трей и прокси ещё работают. Затем перед заменой
файлов работающий прокси останавливается; установленная служба автоматически пересобирается и
запускается заново, а для foreground-установки печатается подсказка `ocx start`. В записях обновления
дашборда пути профиля/кэша и значения UID/GID скрываются до сохранения.

```bash
ocx update
ocx update --tag preview
```

Новые версии становятся доступны, когда
[Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
публикует их в npm.

## Жизненный цикл клиента Remote Hub

Используйте `ocx connect <url> --pairing-code-stdin`, `ocx connect status`, `ocx sync` и `ocx connect rotate --pairing-code-stdin`. `ocx disconnect` офлайн восстанавливает локальное состояние, но не отзывает ключ hub. Пока подключение активно, `ocx connect revoke --admin-token-stdin` отзывает сохранённый `apiKeyId`; после отключения используйте **Integrations → API Keys** на hub. Секреты передаются только через stdin, не argv.
