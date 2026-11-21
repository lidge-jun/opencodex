# Preserve Long Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить экспериментальную Codex-only стратегию `preserve-long-quota` без изменения официальной установки.

**Architecture:** Новый picker в существующем account-selection слое использует имеющиеся eligibility/headroom и usage функции. Общий dispatch применяется к placement, preview, failover и разрешённой quota replacement живой binding; независимые model scopes сохраняют quota fallback. CLI и dashboard добавляют один вариант без изменения defaults.

**Tech Stack:** Bun 1.4.4, TypeScript, bun:test, React, существующая i18n.

**Spec:** [001_design.md](001_design.md)

## Global Constraints

- Только ветка `feat/preserve-long-quota`; не менять официальное приложение, updater, live config и credentials.
- Не запускать экспериментальный прокси; не выполнять upstream-запросы.
- Новая стратегия только для Codex; default quota и поведение прежних стратегий сохраняются.
- Изменять файлы через Edit/Write; не устанавливать новые зависимости.
- Не выполнять commit/push без отдельного разрешения пользователя.
- В shell Bun отсутствует в PATH; использовать локальный `node_modules/.bin/bun`, задав абсолютный путь и при необходимости добавив его каталог в PATH только для текущей команды.
- Проектные design/plan документы находятся в devlog, согласно AGENTS.md.

## Review Focus

- Неполные response headers не доказывают отсутствие weekly/monthly ограничения; отдельный regression fixture для partial observation.
- Custom-only/unknown и прошедший long reset не получают short-only приоритет.
- Смешанные отсутствующие short resets не создают нетранзитивную сортировку и нестабильный выбор.
- Preview/resolve/failover и независимые quota scopes не расходятся.
- Сохранение живых bindings важнее перестановки deadlines; threshold=0 и cacheAffinity сохраняют прежние правила.

---

### Task 1: Picker и Codex routing contract

**Files:**
- Modify: `src/types/config.ts` (Codex accountPoolStrategy union).
- Modify: `src/oauth/pool-kernel.ts` (Codex parser/normalizer, не общий parser).
- Modify: `src/codex/routing/selection.ts` (scope fallback, picker, unbound и alternate dispatch).
- Modify: `src/codex/routing.ts` (preview и bound quota replacement по существующей release policy).
- Modify: `tests/codex-integration/codex-pool-rotation.test.ts` или Create: `tests/codex-integration/codex-preserve-long-quota.test.ts` при ограничении размера.
- Если создан тестовый файл: Modify `scripts/test-layout/layout.json` и `tests/fixtures/test-layout-expected.json`, сохраняя существующий формат.
- Modify: `structure/providers/openai-accounts.md` (новый контракт рядом с reset-first).

**Interfaces:**
- Consumes: `getAccountQuota`, `hasCodexQuotaHeadroom`, `pickLowestUsageAmong`, `resetAtToMs`, существующие eligible lists.
- Produces: `pickPreserveLongQuotaCodexAccount(config: OcxConfig, ids: readonly string[], now: number, selectionOptions?: CodexAccountUsabilityOptions): string | null`.
- Codex parser/normalizer возвращают union с `"preserve-long-quota"`; общий parser по-прежнему возвращает null для него.

- [ ] **Step 1: Написать failing routing tests.** Зафиксировать now. В исходном примере a={short:16%, reset:+5h; weekly:54%, reset:+120h}, b={weekly:32%, reset:+24h}: preview/resolve выбирают b; старый reset-first выбирает a. В short-only примере a={short:10%, reset:+1h; weekly:30%, reset:+120h}, b={short:20%, reset:+5h}: новый picker выбирает b.
- [ ] **Step 2: Добавить boundary tests.** Weekly перед monthly; ближайший monthly среди monthly; unknown/custom-only/partial headers не short-only; long reset отсутствует/прошёл/NaN; seconds vs milliseconds; равные primary deadlines и смешанное отсутствие short resets дают стабильный выбор.
- [ ] **Step 3: Запустить focused tests, сохранить вывод в /tmp.** Ожидать FAIL новых assertions из-за отсутствующей стратегии; отметить исходные failures отдельно.
- [ ] **Step 4: Реализовать picker и dispatch.** Фильтр headroom → категория longest window → earliest future primary reset → short tie-break, только когда известен у всех оставшихся → existing usage/stable order. Все без headroom используют существующий usage fallback. Проверить источник snapshot/provenance до объявления short-only: partial headers не должны стирать известные длинные окна. Если текущего provenance недостаточно для безопасной классификации, остановиться и сообщить ограничение, не угадывать.
- [ ] **Step 5: Добавить integration assertions.** Preview не мутирует active/config; alternate исключает failing account и применяет тот же порядок; priority/paused/cooldown авторитетны; independent spark/reserve используют quota; bound healthy thread не перемещается только из-за нового кандидата. Параметризовать cacheAffinity=false/true и threshold=0; measured-headroom replacement использует новый picker только после разрешённого release.
- [ ] **Step 6: Запустить новый regression file и прежний codex-pool-rotation.** Ожидать PASS. Обновить контрактный structure документ, не копируя его во все dependent docs, если их утверждения остались верны.

### Task 2: API и CLI

**Files:**
- Modify: `src/codex/auth-api/routes.ts` (legacy validation/error).
- Inspect/Modify where needed: `src/oauth/pool-settings-capability.ts`, `src/server/management/oauth-account-routes.ts` (единый Codex parser).
- Modify: `src/cli/account-policy-dto.ts`, `src/cli/account-policy.ts`, `src/cli/account-extended.ts`, `src/cli/account.ts`, `src/cli/capabilities-base.ts`, `src/cli/capabilities-accounts.ts` (Codex-only validation, help и summary).
- Modify: `tests/cli/cli-account-policy.test.ts`; existing API settings fixture tests, найденные по импорту handleCodexAuthRoutes/unifiedPoolSettingsDto.
- Modify: generated operating-reference entries for account strategy/pool under `skills/ocx/references/` when capability text changes; keep generated surface check passing.

**Interfaces:**
- Consumes: Codex parser/normalizer from Task 1.
- Produces: GET/PUT strategy round-trip `preserve-long-quota` для openai/codex/chatgpt; отказ другим видам пула.

- [ ] **Step 1: Написать failing tests** для принятия и readback новой стратегии unified/legacy API, CLI strategy и pool --strategy; Anthropic/generic отказ до mutation. Использовать только mock fetch/temp home.
- [ ] **Step 2: Запустить focused tests, подтвердить ожидаемый FAIL.**
- [ ] **Step 3: Обновить DTO/валидацию/справку.** Не расширять общий generic parser. Новый CLI summary описывает сохранение long budget, не обещает оптимальную экономию.
- [ ] **Step 4: Запустить focused tests и skill surface check.** Ожидать PASS; не обращаться к работающему прокси.

### Task 3: Dashboard, документация и итоговая проверка

**Files:**
- Modify: `gui/src/account-pool-strategy.ts`, `gui/src/components/AccountPoolStrategyControls.tsx`, `gui/src/components/CodexAccountPool.tsx`, `gui/src/components/CodexAutoSwitchSetting.tsx`.
- Modify: `gui/src/i18n/{en,ru,de,fr,ja,ko,pt,tr,vi,zh,zh-TW}.ts` — label/hint во всех существующих locale modules.
- Modify: `gui/tests/account-pool-strategy.test.tsx`.
- Modify: `docs-site/src/content/docs/{reference,ru/reference}/configuration/providers.md` и соответствующие `cli/providers-accounts.md`; проверить остальные переводы этих страниц и добавить новую option без изменения прежних стратегий.
- Read first: `docs-site/AGENTS.md`.

**Interfaces:**
- Consumes: API/CLI strategy string Task 2.
- Produces: Codex-only dashboard option, localized labels/hints и согласованное readback состояние.

- [ ] **Step 1: Написать failing GUI tests.** Нормализация сохраняет новое имя; Codex select показывает option, Anthropic select нет; сохранение отправляет новую строку и показывает применённый сервером результат; threshold hint не обещает немедленную миграцию живого thread.
- [ ] **Step 2: Запустить GUI focused test, подтвердить FAIL.**
- [ ] **Step 3: Добавить option, labels/hints во все locales и краткое описание эвристики.** Не менять layout, стили или default. Документация явно описывает unknown fallback, priority, thresholds и cache affinity.
- [ ] **Step 4: Запустить GUI focused test, lint:i18n и build.** Ожидать PASS, не запускать dashboard/server.
- [ ] **Step 5: Итоговые проверки.** Focused routing/API/CLI tests; `bun run typecheck`; `bun run test:changed`; `bun run structure:check`; `bun run skill:surface:check`; `bun run privacy:scan`; file-size и test-layout guards для новых тестов. Сохранять большой вывод в /tmp, не перезапускать команды ради другого grep.
- [ ] **Step 6: Проверить git diff --check и status.** Отчёт: результаты команд, непроверенные области, отсутствие live launch, список файлов. Отдельно предложить commit, не выполнять без разрешения. Не менять Claude/Nessy configs: новая стратегия относится только к исходникам opencodex.

## Self-review

Все утверждённые категории и оба пользовательских примера покрыты Task 1; интерфейсы и ограничения провайдеров — Task 2; возможность выбора и локализации — Task 3. Самый существенный implementation gate — доказуемость short-only по текущему источнику данных. Реальный запуск и перевод рабочих клиентов намеренно исключены. Если сопутствующие whitelist/union потребители обнаружатся typecheck, добавить только прямую поддержку нового значения, без смежного refactor.
