<h3 align="center">make codex open!</h3>
<p align="center"><b>Универсальный прокси провайдеров для OpenAI Codex, Claude Code, Claude Desktop и Grok Build</b><br>
Две команды — и каждый из них работает на любой LLM, которую вы укажете.</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="Подписывайтесь на @claudeebum в X"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="версия npm"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="лицензия"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="версия Node">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start
```

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code на любой модели

Селектор — штатный Claude Code. Мозг за ним — нет.

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="Claude Code работает на маршрутизированной модели через opencodex — в строке состояния активна gpt-5.6-luna-medium" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex на любой модели

Выберите провайдера — и вперёд: тот же рабочий процесс, другой «мозг».

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="Демонстрация opencodex — выполнение задачи в приложении Codex на маршрутизированной модели не от OpenAI" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop на любой модели

Opus отвечает, затем передаёт задачу подагенту GPT-5.6 Sol.

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop отвечает как Claude Opus 4.8, затем запускает подагента GPT-5.6 Sol через opencodex" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build на любой модели

Sol ведёт сессию и вызывает подагента Kimi K3.

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="Grok Build запускает GPT-5.6 Sol через opencodex и вызывает подагента Kimi K3" width="100%">
</td>
</tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <b>Русский</b> · <a href="README.ja.md">日本語</a> · <a href="README.tr.md">Türkçe</a> · 📖 <a href="https://opencodex.me/ru/"><b>Полная документация →</b></a>
</p>

opencodex — лёгкий локальный прокси, который транслирует Responses API Codex в протокол,
понятный вашему провайдеру: потоковая передача, вызовы инструментов, токены рассуждений и
изображения — в обе стороны. Используйте Claude, Gemini, Grok, GLM, DeepSeek, Kimi, Qwen,
Ollama или любую другую LLM с Codex, Claude Code, Claude Desktop и Grok Build. Кроме того,
он умеет управлять **пулом аккаунтов ChatGPT** для аутентификации Codex: добавляйте аккаунты,
обновляйте их квоты в панели управления, и новые сессии будут автоматически направляться
на работоспособный аккаунт с наименьшим использованием, а существующие треды останутся
закреплёнными за аккаунтом, с которого они начались.

## Быстрый старт

### Личная установка

```bash
npm install -g @bitkyc08/opencodex   # Node 18+; рантайм Bun подключается автоматически
ocx start                         # прокси + панель управления на localhost:10100
```

Чтобы запустить его в фоне, используйте `ocx service`.

Откройте **http://localhost:10100** и настройте всё в веб-панели: добавьте провайдеров
(40+ встроенных или любой OpenAI-совместимый endpoint), выберите модели, управляйте
аккаунтами. `ocx gui` в любой момент снова откроет панель.
Кроме того, он умеет управлять **пулом аккаунтов ChatGPT** для аутентификации Codex. Добавьте
несколько аккаунтов ChatGPT / Codex и обновляйте их квоты за 5 ч / неделю / 30 дней в панели.
При маршрутизации по квоте новые сессии могут использовать работоспособный аккаунт с наименьшим
использованием; round-robin и fill-first применяют свои политики. Существующие треды Codex
обычно сохраняют привязку к аккаунту, с которого начались, поэтому длинные сессии по SSH,
в tmux или с мобильного устройства не перескакивают между аккаунтами посреди разговора — но
повторная оценка квот, failover, исключение аккаунта, истечение привязки или восстановление
после 401/403 и 429 могут перепривязать их. Задайте аккаунтам порядок выбора, если один из
них — обычно вход Codex Desktop — должен использоваться только после того, как остальные
исчерпаны.

### Спонсоры

Спонсоры позволяют поддерживать opencodex при каждом изменении вышестоящих протоколов. Интересно?
См. [SPONSORS.md](../SPONSORS.md).

<!-- sponsors:main — one banner, model developers only; empty until a Main sponsor signs -->

<!-- sponsors:standard — one row per sponsor, in order of signing -->
<table>
<tbody>
<tr>
<td width="180"><a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme"><img src="../assets/sponsors/orcarouter.png" alt="OrcaRouter" width="150"></a></td>
<td>Благодарим <a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme">OrcaRouter</a> за спонсорскую поддержку проекта! OrcaRouter — единый OpenAI-совместимый AI-шлюз для продакшена: адаптивная маршрутизация оценивает каждый промпт и отправляет его модели, которая проходит ваш порог, плюс автоматический failover, правила маршрутизации как код, цены провайдеров без наценки с кэшированием промптов, а также guardrails, файрвол агентов и журналы запросов на каждый вызов среди 200+ моделей. Выберите <code>OrcaRouter</code> в селекторе Add provider или выполните <code>ocx provider add orcarouter</code>; <code>orcarouter/auto</code> — адаптивный маршрутизатор.</td>
</tr>
<tr>
<td width="180"><a href="https://www.packyapi.com/register?aff=k5KT"><img src="../assets/sponsors/packycode.png" alt="PackyCode" width="150"></a></td>
<td>Благодарим <a href="https://www.packyapi.com/register?aff=k5KT">PackyCode</a> за спонсорскую поддержку проекта! PackyCode — стабильный высокопроизводительный API-релей, предоставляющий релей-сервисы для Claude Code, Codex, Gemini и других. Автоматический failover, умная маршрутизация и неограниченная конкурентность превращают AI в настоящий инструмент продуктивности. <a href="https://www.packyapi.com/register?aff=k5KT">Зарегистрируйтесь по этой ссылке</a> и начните работу! Выберите <code>PackyCode</code> в селекторе Add provider или выполните <code>ocx provider add packycode</code>.<br><sub>PackyCode 是一家稳定、高效的 API 中转服务商，提供 Claude Code、Codex、Gemini 等多种中转服务。具备自动故障转移、智能路由和无限并发等多种功能，让 AI 编程成为真正的生产力工具。<a href="https://www.packyapi.com/register?aff=k5KT">点此链接注册</a>，立即开始使用！</sub></td>
</tr>
</tbody>
</table>

---

<details>
<summary>Docker Compose</summary>

Репозиторий поставляет сборку Compose с закреплённым дайджестом и без root. Если на хосте
установлены Git и Bun, перед каждой сборкой образа сгенерируйте канонический манифест
совместимости, один раз инициализируйте токен плоскости данных через stdin и запустите хаб:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

Привязка по умолчанию — `127.0.0.1:10100`. Удалённый доступ требует явного
`OPENCODEX_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d`; `0.0.0.0` открывает
все интерфейсы хоста. Ограничьте доступ файрволом и аутентифицированным TLS/tailnet-фронтендом.
Сгенерированный JSON остаётся неотслеживаемым; он копируется в образ без включения `.git`.
Перегенерируйте его после изменений исходников и не меняйте исходники между генерацией и сборкой.
Сборка отклоняет устаревшие манифесты, отсутствующие или несовпадающие файлы, лишние исходники
и символические ссылки. Она сверяет каждый записанный SHA-256 с контекстом сборки и скопированными
рантайм-файлами, включая `package.json`, `bun.lock` и явно включённый
`scripts/model-metadata.source.json`.

Токен и изменяемое состояние живут в именованном томе `ocx-state`; ни одно учётное данное не
попадает в образ, Compose-файл, окружение или аргументы оболочки. См.
[руководство по развёртыванию Remote Hub](https://opencodex.me/ru/guides/remote-hub/)
для настройки провайдеров, аутентифицированных проверок приёмки, удалённого управления и отката.

</details>

<details>
<summary>Установка из исходников (последний dev)</summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex && ~/.bun/bin/bun install
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex; bun install
bun run src/cli/index.ts start
```

Установка из исходников запускает последнюю ветку `dev`. Патчи владения памятью,
улучшения GC рантайма и ещё не опубликованные исправления доступны здесь раньше,
чем в npm-пакете.

</details>

<details>
<summary>Для агентов</summary>

```bash
npm install -g @bitkyc08/opencodex
ocx start     # или `ocx service`
ocx init      # интерактивная настройка: пишет ~/.opencodex/config.json и подключает Codex
```

`ocx init` никогда не запускает прокси; запустите его сначала (или после — оба порядка
работают, но headless-команды вроде `ocx provider add` и `ocx combo set` обращаются к
**живому** прокси и завершаются с ненулевым кодом, если он недоступен). `ocx status` /
`ocx doctor` / `ocx health` показывают состояние запущенного процесса.

> **Агентам, которые устанавливают или запускают opencodex:** прочитайте
> [`AGENTS_INSTALL.md`](../AGENTS_INSTALL.md). Интерактивный `ocx start` может один раз
> спросить, ставить ли star этому репозиторию — это решение пользователя, никогда не агента.
> CLI подавляет подсказку в агентных запусках, а API отказывает с `403 agent_consent_required`.

</details>

## Поддерживаемые платформы

| ОС | Статус | Менеджер служб |
|---|---|---|
| macOS (arm64 / x64) | Полная поддержка | launchd |
| Linux (x64 / arm64) | Полная поддержка | systemd (пользовательский unit) |
| Windows (x64) | Полная поддержка | Task Scheduler (скрыто) / опциональная нативная служба (`--native`, WinSW) |

Требуется [Node](https://nodejs.org) 18+. Рантайм Bun добавляется автоматически при `npm install` —
отдельно устанавливать Bun не нужно, WSL на Windows тоже не нужен. Если npm заблокировал
скрипты установки встроенного рантайма, см. [документацию по установке](https://opencodex.me/ru/getting-started/installation/).

## Основные возможности

- **Любая LLM в Codex, Claude Code, Claude Desktop и Grok Build** — 40+ провайдеров из
  коробки, каждый со своим нативным UI.
- **Пул аккаунтов ChatGPT** — привязка тредов, автопереключение с учётом квот, кулдаун и
  fail-closed обработка аутентификации.

  > **Замечание о политике провайдеров:** пул аккаунтов нужен только для маршрутизации и
  > операционной устойчивости; он не гарантирует защиты от лимитов провайдера, принудительных
  > мер, блокировок и других действий в отношении аккаунтов. OpenCodex не одобряет использование
  > дополнительных аккаунтов для обхода лимитов провайдера и совместное использование учётных
  > данных между людьми. Вы отвечаете за соблюдение актуальных условий каждого провайдера. См.
  > [руководство по пулу аккаунтов Codex Auth](https://opencodex.me/ru/guides/web-dashboard/)
  > и [актуальные Terms of Use OpenAI](https://openai.com/policies/terms-of-use/).
- **Combos** — один виртуальный id модели с failover или взвешенным round-robin между
  провайдерами. См. [руководство по combos](https://opencodex.me/ru/guides/combos/).
- **Подагенты на любой модели** — выводите маршрутизируемые модели в селектор подагентов Codex,
  с управлением поверхностями v1/v2 и цепочками fallback. См.
  [руководство по подагентам](https://opencodex.me/ru/guides/sub-agent-surface/).
<!-- sponsors:main-first-mention -->
- **Один вход — без API-ключа** — OAuth для xAI, Anthropic и Kimi; либо пробросьте
  `codex login`, вставьте ключ или используйте ссылки `${ENV_VAR}`.
- **Сайдкары веб-поиска и зрения** — модели не от OpenAI получают настоящий веб-поиск и
  понимание изображений через сайдкар поверх вашего входа ChatGPT.
- **Видно, что происходит** — панель показывает провайдеров, статус OAuth, выбор моделей и
  живой журнал запросов с количеством токенов кэша.
- **Чистый выход без следов** — `ocx stop` возвращает Codex к исходной конфигурации.
- **Ограниченное владение памятью** — у каждого долгоживущего кэша, кольцевого буфера и
  хранилища трансляции протокола есть конечный потолок, байтовый бюджет или активная
  сверка. Ни один неограниченный `Map` или `Set` не переживает перезагрузку конфигурации.

<details>
<summary>Подробности владения памятью</summary>

OpenCodex отслеживает 36 категорий состояния, удерживаемого процессом. У каждой есть
документированная граница:

- **12 удерживаемых хранилищ** (журнал запросов, отладочные кольца, кэш изображений, кэш
  моделей, vision-описания, cursor-блобы, продолжение responses и т. д.) учитываются
  в байтах и вытесняются бюджетом памяти приложения (по умолчанию 256 MiB).
- **4 наблюдаемых буфера** (аккумуляторы транслятора, хвосты image/OAuth/Grok)
  мониторятся по байтовому давлению in-flight без вытеснения.
- **24 регистрации state-store** выполняют sweeps истечения (интервал 60 с) и сверку
  поколений конфигурации, чтобы удалять устаревшие ключи провайдеров и аккаунтов.
- **Мемо пути и отпечатков** (метаданные рабочей области, усиленные идентификаторы,
  соли установки, возможности mode-hint) используют LRU-потолки в порядке вставки
  (8–128 записей).
- **Tombstone поколений кэша моделей** удаляются после сверки; глобальный инкремент
  поколения не даёт устаревшим in-flight discovery снова заполнить удалённых провайдеров.
- **Дедупликация event-id в Lab** работает под блокировкой журнала с диска, без
  процессного RAM-индекса.

Выполните `GET /api/system/memory` (с admin-токеном), чтобы посмотреть живые удержанные
байты, счётчики вытеснения и выборки watchdog.

</details>

## Маршрутизация моделей

Обращайтесь к любому настроенному провайдеру и модели синтаксисом `provider/model`:

```bash
codex -m "anthropic/claude-opus-5" "Разберите этот stack trace"
codex -m "google/gemini-3-pro" "Напишите unit-тесты для auth.ts"
codex -m "ollama/llama3" "Отрефакторьте эту функцию"
```

Опустите префикс `provider/`, чтобы использовать провайдера по умолчанию или автоматически
подобрать его по шаблону имени модели. Id моделей провайдера, содержащие `/`,
отдаются с внутренними слэшами, заменёнными на `-`; исходная форма со всеми слэшами
тоже продолжает работать. Подробности: [документация по маршрутизации моделей](https://opencodex.me/ru/guides/model-routing/).

## Провайдеры и адаптеры

<!-- sponsors:main-first-mention -->
OpenAI (вход ChatGPT или API-ключ), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(локально + Cloud), Cursor (экспериментально) и любой OpenAI-совместимый endpoint — плюс DeepSeek,
Groq, OpenRouter, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax,
Qwen Cloud, Qoder Global и CN (официальный PAT + CLI), SiliconFlow и другие. Полный список: `ocx init` или
[документация по провайдерам](https://opencodex.me/ru/guides/providers/).

## CLI

```bash
ocx init                       # интерактивная настройка (пишет конфиг, подключает Codex, предлагает shim)
ocx start [--port 10100]       # запустить прокси на переднем плане
ocx stop                       # остановить + восстановить нативный Codex
ocx service [install|repair|restart|start|stop|status|uninstall|remove]  # фоновая служба
ocx codex-shim install         # запускать прокси по требованию при старте `codex`
ocx health [--json]            # проверить немедленную живость прокси
ocx ready [--json] [--wait [--timeout <seconds>]]  # проверить готовность после синхронизации
ocx status                     # работает ли прокси?
ocx gui                        # открыть веб-панель
ocx provider <...>             # управлять провайдерами (list/add/edit/test/remove)
ocx account <...>              # управлять аккаунтами ChatGPT и пулами API-ключей
ocx combo <...>                # управлять combos с failover / round-robin
ocx v2 <...>                   # управление мультиагентными поверхностями v1/v2
ocx update [--tag preview]     # обновить opencodex
```

Запуски без закреплённого порта могут выбрать другой свободный порт, если предпочтительный занят;
явный `--port` никогда не перескакивает. Полный справочник: [документация CLI](https://opencodex.me/ru/reference/cli/).

### Здоровье и готовность

`GET /healthz` сообщает о немедленной живости прокси. Неаутентифицированный endpoint `GET /readyz`
сообщает о готовности после синхронизации с очищенной JSON-идентичностью `{service, version, uptime, pid, port, status}`.
Он возвращает `200`, когда `status` равен `ready`; `pending` и терминальный `failed` возвращают `503` с
`Retry-After: 1`.

`ocx ready [--json] [--wait [--timeout <seconds>]]` по умолчанию выполняет один зонд. `--wait` опрашивает
до 45 секунд по умолчанию, но сразу завершается при терминальном `failed`;
`--timeout <seconds>` задаёт лимит 1–300 секунд, требует `--wait` и принимает только положительные целые. CLI `--json` выводит
`{ready, status, pid, port}`, где `status` — `ready`, `pending`, `failed` или `unreachable`.

| Код | Результат |
| --- | --- |
| `0` | Готов |
| `1` | Не готов: pending, failed, timeout или unreachable |
| `64` | Некорректные аргументы |

Старый прокси без `/readyz` закрывается как `unreachable` с кодом 1, тогда как `ocx health`
остаётся совместимым.

### Автозапуск: служба или shim

Используйте **службу** (`ocx service`) для постоянно работающего прокси, который перезапускается
при сбое. Используйте **shim** (`ocx codex-shim install`) для лёгкого запуска по требованию без
фонового демона. Удаляйте их командами `ocx service uninstall` / `ocx codex-shim uninstall`.

### Удаление

```bash
ocx uninstall                  # остановить, удалить службу/shim, восстановить нативный Codex, очистить состояние
npm uninstall -g @bitkyc08/opencodex
```

## Удалённый доступ

По умолчанию opencodex привязывается к `127.0.0.1` и не требует дополнительной аутентификации.
Привязка за пределами loopback (`"hostname": "0.0.0.0"`) **требует** bearer-токен — прокси
откажется запускаться без `OPENCODEX_API_AUTH_TOKEN`, и каждый клиентский запрос должен нести его
как `x-opencodex-api-key`. Подробности: [справочник по конфигурации](https://opencodex.me/ru/reference/configuration/).

## Документация

Публичная документация — установка, провайдеры, маршрутизация, combos, подагенты, сайдкары,
интеграции и справочники CLI/конфигурации/management-API — собирается из [`docs-site/`](../docs-site) и
публикуется на **[opencodex.me](https://opencodex.me/ru/)**.

Заметки мейнтейнеров, служащие источником истины, находятся в [`structure/`](../structure),
настройка для контрибьюторов — в [`CONTRIBUTING.md`](../CONTRIBUTING.md), сообщения о проблемах
безопасности — в [`SECURITY.md`](../SECURITY.md).
Нераскрытые уязвимости сообщайте приватно через
[GitHub private vulnerability reporting](https://github.com/lidge-jun/opencodex/security/advisories/new),
а не публичный issue.
Эта форма — единственный технический канал, отдельного адреса для безопасности нет. Дальнейшее
обсуждение остаётся внутри приватного отчёта; в публичном issue допустима только координация, но
не детали уязвимости. Подтверждение получения отчёта — это ещё не разбор, и срок первого ответа
не обещан.

## Разработка

Разработка из исходников требует CLI `bun` в вашем `PATH`. Это отдельно от встроенного рантайма Bun
опубликованного npm-пакета, который используют только установленные команды `ocx`.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

См. **[Contributing](../CONTRIBUTING.md)**.

Работа контрибьюторов, которая попала через перенос или реимплементацию мейнтейнером,
если коммит не называет исходного автора, записана в
**[CREDITS.md](../CREDITS.md)**.

## Отказ от ответственности

opencodex — независимый проект, поддерживаемый сообществом; он **не аффилирован с OpenAI, Anthropic или каким-либо другим провайдером и не одобрен ими**.

Некоторые провайдеры — в частности Anthropic (Claude) — могут приостанавливать или ограничивать аккаунты, которые направляют API-трафик через сторонние прокси. **Используйте на свой страх и риск (UAYOR).** Прежде чем подключать провайдера, изучите его Terms of Service и убедитесь, что доступ через прокси разрешён. Мейнтейнеры opencodex не несут ответственности за какие-либо действия вышестоящих провайдеров в отношении аккаунтов.

## Лицензия

MIT
