---
title: Установка
description: Установите прокси opencodex (ocx) и необходимые компоненты и убедитесь, что он запускается.
---

opencodex устанавливает два эквивалентных имени команды: `ocx` и `opencodex`. Обе запускают один и
тот же небольшой локальный HTTP-сервер (построенный на Bun). Запросы к моделям идут к провайдеру,
выбранному маршрутизацией; опциональные сайдкары для vision и веб-поиска также могут использовать
ваш вход в ChatGPT, когда они нужны маршрутизируемой модели.

## Предварительные требования

| Требование | Зачем |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` работает на рантайме Bun, но рантайм автоматически поставляется в комплекте при `npm install` — устанавливать Bun самостоятельно **не нужно**. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App или SDK) | Клиент, перед которым работает opencodex. opencodex записывает данные в `$CODEX_HOME/config.toml` (по умолчанию `~/.codex/config.toml`). |
| Аккаунт провайдера или API-ключ | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI-совместимая конечная точка или ваш вход в ChatGPT. |

## Установка

```bash
npm install -g @bitkyc08/opencodex
```

:::note[npm заблокировал postinstall-скрипт bun?]
Свежие версии npm могут блокировать postinstall-скрипт bun (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
из-за чего встроенный рантайм Bun остаётся неподготовленным. Переустановите
пакет, разрешив скрипт bun, — и обязательно указывайте имя пакета: в
сокращённой подсказке npm его нет, и без него вместо пакета переустановится
текущий каталог:

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# если изначально устанавливали через sudo, продолжайте использовать sudo:
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```
:::

Убедитесь, что оба псевдонима команды доступны в `PATH`:

```bash
ocx --version
opencodex --version
```

### Каналы релизов

Стабильный канал `latest` уже включает поддержку каталога GPT-5.6 Sol/Terra/Luna для маршрутов
ChatGPT, OpenAI по API-ключу, OpenRouter и экспериментального Cursor. Доступ у вышестоящего
провайдера по-прежнему зависит от аккаунта; сами по себе записи каталога доступ не дают.
Используйте канал preview только для тестирования ещё не выпущенных сборок opencodex:

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## Запуск из исходного кода

Чтобы работать над самим opencodex:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # запускает API прокси в режиме разработки (src/cli/index.ts start)
bun run dev:gui     # запускает dev-сервер панели управления (в другом терминале)
```

`bun run dev` остаётся псевдонимом для `bun run dev:proxy`. API прокси предоставляет `/healthz`,
`/v1/responses` и `/api/*`; `GET /` отдаёт упакованную панель управления только после того, как
`bun run build:gui` создаст `gui/dist`. Пока вы работаете над панелью управления, запускайте
фронтенд отдельно командой `bun run dev:gui`.

## Что создаётся

Состояние opencodex хранится в `$OPENCODEX_HOME` (по умолчанию `~/.opencodex`). Файлы интеграции
с Codex находятся в `$CODEX_HOME` (по умолчанию `~/.codex`).

| Путь | Назначение |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Ваши провайдеры, провайдер по умолчанию, порт и параметры. |
| `$OPENCODEX_HOME/ocx.pid` | PID запущенного прокси (защита от повторного запуска). |
| `$OPENCODEX_HOME/runtime-port.json` | Текущие PID, имя хоста и порт, включая автоматически выбранный запасной порт. |
| `$OPENCODEX_HOME/auth.json` | Сохранённые учётные данные OAuth (после `ocx login`). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Резервные копии каталога моделей Codex, создаваемые перед тем, как opencodex его изменит. |
| `$CODEX_HOME/config.toml` | На loopback-адресе opencodex добавляет корневой `openai_base_url`, отмеченный собственным маркером; при привязке не к loopback используются `model_provider = "opencodex"` и `[model_providers.opencodex]`, чтобы Codex мог отправлять заголовок API-аутентификации. |
| `$CODEX_HOME/opencodex.config.toml` | Резервный/справочный профиль, записываемый рядом с основной конфигурацией Codex. |
| `$CODEX_HOME/opencodex-catalog.json` | Синхронизированный каталог нативных и маршрутизируемых моделей, используемый Codex. |

:::note
opencodex никогда не удаляет вашу конфигурацию Codex. Каждое внедрение обратимо — `ocx stop`,
`ocx restore` или `ocx eject` убирают ровно те строки, которые добавил opencodex, и восстанавливают
нативный Codex.
:::

## Далее

Переходите к разделу [Быстрый старт](/ru/getting-started/quickstart/), чтобы настроить
первого провайдера, или прочитайте [Как это работает](/ru/getting-started/how-it-works/),
чтобы разобраться в архитектуре.
