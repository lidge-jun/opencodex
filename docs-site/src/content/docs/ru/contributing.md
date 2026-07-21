---
title: Участие в разработке
description: Разработка opencodex — настройка окружения, структура, конвенции и добавление провайдера или адаптера.
---

## Настройка окружения

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # прокси-API в режиме разработки
bun run dev:gui      # dev-сервер дашборда (другой терминал)
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev` остаётся псевдонимом для `bun run dev:proxy`. Dev-сервер дашборда — `bun run dev:gui`;
упакованный дашборд, доступный по `GET /`, собирается командой `bun run build:gui` (`gui/dist`).

## Команды сборки и тестирования

Корневой пакет — Bun-нативный TypeScript; отдельного шага компиляции сервера нет. Используйте
скрипты из репозитория, чтобы локальные команды совпадали с CI:

```bash
bun run typecheck                 # строгая проверка TypeScript
bun run test                      # полный набор tests/
bun test tests/router.test.ts     # отдельный тестовый файл
bun run build:gui                 # сборка GUI на Vite + подготовка пакета
bun run privacy:scan              # проверка учётных данных/приватности, используемая в CI
bun run prepare:package           # обновление лаунчеров/ресурсов пакета
```

Большинство тестов — плоские Bun-тесты `tests/*.test.ts`. В `tests/helpers/` лежат общие fixtures,
а в `tests/e2e-style/` — более широкие сценарии нативного паритета. Добавляйте сфокусированный
регрессионный тест рядом с существующими тестами изменяемой подсистемы; если затронуты общая
маршрутизация, адаптеры, конфигурация или поведение сервера, запускайте полный набор.

Сайт документации, который вы сейчас читаете, находится в `docs-site/` (Astro + Starlight):

```bash
cd docs-site && bun install && bun dev
```

## Публикация документации

Публичная документация публикуется на GitHub Pages по адресу <https://lidge-jun.github.io/opencodex/ru/>.
Воркфлоу `.github/workflows/deploy-docs.yml` запускается на push в `main`, затрагивающих
`docs-site/**` или сам воркфлоу, собирает `docs-site` и разворачивает сгенерированный сайт. Перед
push изменений документации выполните:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI и релизы

GitHub Actions намеренно остаются компактными:

- **Cross-platform CI** (`.github/workflows/ci.yml`) запускается на pull request и push в `main`,
  затрагивающих файлы рантайма, тестов, пакета, скриптов, TypeScript или воркфлоу. Его Bun-матрица
  покрывает Linux, Windows и macOS: install, typecheck, тесты, privacy scan, smoke-сборка
  release-helper, сборка GUI и `ocx help`. Отдельная линия на тех же трёх ОС подтверждает, что
  npm global install работает без отдельно установленного Bun — за счёт runtime, входящего в
  состав пакета.
- **Release** (`.github/workflows/release.yml`) запускается вручную. Он не служит вторым полным
  CI-пайплайном; перед dry-run или publish он требует, чтобы для точного релизного коммита
  (`GITHUB_SHA`) уже был успешный запуск Cross-platform CI.

Для релизов используйте helper:

```bash
bun run release <version>           # коммитит/пушит bump версии; publish workflow по умолчанию dry-run
bun run release <version> --publish # publish после осознанного CI-gated dry-run
bun run release:watch               # наблюдение за последним запуском Release workflow
```

## Конвенции

- **Только ES Modules** (`import`/`export`), TypeScript, режим `strict`. Держите `bun x tsc --noEmit`
  без ошибок.
- **Не более ~500 строк на файл** — разделяйте по ответственности (сайдкары `web-search/` и
  `vision/` — хорошие примеры небольших сфокусированных модулей за единым `index.ts`).
- **Обрабатывайте асинхронные ошибки на границах** — сайдкары никогда не бросают исключения в путь
  запроса; они деградируют до корректного маркера.
- **Structure SOT** — актуальные инварианты для мейнтейнеров живут в `structure/`. Публичные
  пользовательские сценарии держите в `docs-site/`, а исторические заметки расследований — в `docs/`.
- **Сохраняйте экспорты** — от них могут зависеть другие модули.

## Добавление провайдера в каталог

Все селекторы провайдеров и seed-данные выводятся из канонического реестра
(`src/providers/registry.ts`):

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` передаёт эту запись в `ocx init`, `ocx provider`, пресеты дашборда, вход
по API-ключу и seed-конфигурации OAuth. `enrichProviderFromCatalog()` копирует метаданные моделей и
классификацию возможностей в сохранённую конфигурацию провайдера. Реализации OAuth-протоколов
по-прежнему живут в `src/oauth/`; одни лишь метаданные реестра ещё не образуют OAuth-flow.

## Добавление адаптера

Реализуйте `ProviderAdapter` (см. [Адаптеры](/opencodex/ru/reference/adapters/)) в `src/adapters/`,
зарегистрируйте его имя в `src/server/adapter-resolve.ts` и приведите его вывод к внутренним
событиям `AdapterEvent`. Переиспользуйте `image.ts` для работы с изображениями и ориентируйтесь на
`openai-chat.ts` для обычной потоковой передачи и вызовов инструментов; используйте `fetchResponse`
только когда адаптер сам управляет повторными попытками транспорта, а `runTurn` — для действительно
двунаправленного транспорта вроде Cursor. Добавьте сфокусированные тесты в `tests/` и экспортируйте
фабрику из `src/index.ts`, если она входит в публичный API пакета.

## Проверяйте, прежде чем объявлять работу завершённой

Запускайте самую узкую команду, которая доказывает ваше изменение: `bun run typecheck` для типов,
сфокусированный `bun test tests/<name>.test.ts` или runtime-проверку для поведения, а затем более
широкие проверки, соответствующие затронутой области. opencodex предпочитает небольшие проверяемые
коммиты крупным пачкам изменений.
