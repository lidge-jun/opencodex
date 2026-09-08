---
title: Конфигурация агентов
description: Multi-agent surface, guidance при делегировании, preferred model'и, fallback chain'ы, sync native default'ов и effort cap'ы.
---

Настройки агентов управляют тем, какая collaboration surface Codex рекламируется и как opencodex
подсказывает, маршрутизирует и ограничивает делегированную работу.

## Поля агентов

| Поле | Тип | По умолчанию | Значение |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` штампует все модели как v1; `v2` штампует все модели как v2. `default` восстанавливает upstream pin'ы (Sol/Terra — v2, Luna — v1) и для остальных следует native flag `multi_agent_v2`. Применяется к новым сессиям. |
| `subagentModels?` | `string[]` | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` | До пяти bare native-id, account-qualified id `<selector>/<native-openai-model>` или routed-id `provider/model`, которые показываются первыми в picker'е подагентов. Страница Subagents предлагает только bare native- и routed-id и при сохранении исключает точные account-qualified варианты; для точного выбора используйте `ocx agent subagents set` или отредактируйте конфигурацию. После [однократного обновления Astra](/reference/configuration/agents/#astra-roster-upgrade) явный пустой список сохраняется. |
| `injectionModel?` | `string` | — | Предпочитаемая native- или routed-модель подагента, которую proxy использует в собственном guidance v2. |
| `injectionEffort?` | `string` | — | Предпочитаемый effort (`low`–`ultra`), имеющий смысл только вместе с `injectionModel`. |
| `injectionPrompt?` | `string` | — | Заменяет встроенное тело guidance для v2. Поддерживает `{{model}}`, `{{effort}}`, `{{roster}}` и `{{fallback}}`. Настроенного `injectionModel` достаточно, чтобы отобразить пользовательский prompt. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Управляет только developer-guidance, написанным самим opencodex, для v1/v2; не меняет native default'ы агентов, tools, routing, roster'ы и effort cap'ы. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Разрешает записывать `injectionModel` и, при наличии, `injectionEffort` как native default'ы Codex при sync/restart. Требует `injectionModel`. |
| `subagentModelFallback?` | `string[]` | `[]` | Глобальные fallback-модели для порождённых child-turn'ов в порядке приоритета. |
| `subagentModelFallbackByModel?` | `Record<string, string[]>` | `{}` | Модельные цепочки fallback по ключу запрошенной основной модели. Это поддерживаемое место для per-role метаданных fallback; поле `model_fallback` в `$CODEX_HOME/agents/*.toml` поддерживается только как legacy и заставляет Codex 0.146+ пропустить роль (#1190). |
| `subagentModelFallbackPollMs?` | `number` | `60000` | Интервал кэша для availability probe. Значения ниже 1000 ms возвращаются к дефолту. |
| `effortCap?` | `string` | — | Жёсткий потолок effort для qualifying v2 main-turn'ов и помеченных spawned-child turn'ов. Принимает `low`–`ultra`. |
| `subagentEffortCap?` | `string` | — | Дополнительный потолок только для spawned-child turn'ов. Если применимы оба cap'а, выигрывает более низкий. |

Управляйте surface через дашборд или `ocx v2 status|on|off|mode <v1|default|v2>|threads <n>`.
Смена режима применяется к новым сессиям. `maxConcurrentThreadsPerSession` — это поле
`PUT /api/v2`, а не ключ `config.json`; `ocx v2 threads <n>` записывает
`max_concurrent_threads_per_session` в `[features.multi_agent_v2]` файла
`$CODEX_HOME/config.toml` после включения v2.

Management API предоставляет `GET`/`PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`,
`/api/subagent-models` и `/api/subagent-model-fallback`. Обновления injection-model частичные;
custom prompt на этом API передаётся полем `prompt`.

## Всегда проактивное делегирование

**Всегда проактивное делегирование** в Subagents → Дополнительно (прежнее название — **Ultra mode**) меняет только условие запуска делегирования, не меняя reasoning effort. Рекомендуемый preset сохраняет инструкции пользователя, границы полномочий, область задачи и правила работы с инструментами.

`GET` и `PUT /api/v2` дополнительно возвращают `multiAgentModeHintRecommendation: { text, revision }`. При включении или восстановлении preset дашборд использует текст сервера без встроенного запасного варианта. Если старый сервер не возвращает рекомендацию или возвращает некорректное значение, применение и восстановление preset недоступны; существующий custom hint по-прежнему можно редактировать или удалять. Восстановление preset меняет только локальный черновик; действие сохранения записывает его.

Чтение настроек, несвязанные изменения и обновление версии не мигрируют сохранённый hint. Только явное обновление hint, текст которого побайтово совпадает с одним из двух известных старых preset OpenCodex, заменяет его текущей рекомендацией. Остальной допустимый custom text, включая варианты с отличиями в пробельных символах, сохраняется побайтово. Существующие правила включения v2, проверки поддержки и удаления hint не меняются; изменения применяются к новым сессиям Codex.

## Roster и guidance

Эффективный ростер v2 — это настроенные, видимые в picker'е, отсортированные по priority первые
пять моделей, присутствующих во внедряемом каталоге и не отмеченных явно как `"disabled"`.
Явный pin `"v2"` поддерживает рекурсивных подагентов; `"v1"`, `null` и отсутствующий pin
остаются допустимыми для подагентов без дальнейшего делегирования. Исключённые записи остаются
в конфигурации, чтобы позже снова стать допустимыми.

Определение surface основано на форме tool'ов. Namespaced `spawn_agent` вместе с `send_input`,
`resume_agent` или `close_agent` — это v1. Плоский `spawn_agent` вместе с `send_message`,
`followup_task`, `interrupt_agent` или `list_agents` — это v2.

Для v1 guidance — это только proactive text и только на уровнях `max` или `ultra`. Для v2
proxy-authored developer message добавляется только когда существует preferred model, допустимый
roster или fallback chain. Встроенное guidance v2 ограничено 700 символами и при необходимости
сначала удаляет roster. Guidance дедуплицируется по replay-prefix и вставляется перед завершающим
`compaction_trigger`.

И встроенные указания v2 для подагентов, и пользовательские тела `injectionPrompt` используют
`<opencodex_subagent_guidance>`, отдельно от нативных сообщений Codex `<multi_agent_mode>`.
Встроенный текст сообщает итоговую предпочтительную модель, список моделей и цепочку резервных
моделей, но не предписывает делегирование, переопределение модели или `fork_turns`. Подстановка
значений в плейсхолдеры и содержимое пользовательских тел сохраняются. `injectionModel` и
`injectionEffort` остаются рекомендациями, если не включена синхронизация нативных значений по
умолчанию; отсутствующие значения пользовательских плейсхолдеров заменяются пустой строкой.

Дедупликация replay проверяет точное совпадение с последним текстом в каждой группе тегов.
Если оба значения используют новую группу тегов прокси, при возврате от пользовательских указаний
к встроенной форме добавляется её текущее содержимое; промежуточные изменения нативного режима
не дублируют неизменившиеся указания прокси.
Существующая история нативных сообщений и сообщений со старым тегом сохраняется. Изменение
обёртки не устанавливает автора старых сообщений и не отменяет прежние инструкции; историю
со смешанными версиями нельзя классифицировать только по старому тегу, и обнаружение переходов
в такой истории не гарантируется.

## Синхронизация native default'ов Codex

Когда опция включена, `syncCodexSubagentDefaults` записывает marker-owned поля
`[agents] default_subagent_model` и `default_subagent_reasoning_effort`. Уже существующие
user-owned target field'ы считаются конфликтом и сохраняют приоритет; частичные или неоднозначные
записи TOML закрываются с ошибкой. Очистка `injectionModel` одновременно очищает и этот opt-in.
Эти default'ы влияют только на новые задачи Codex и сами по себе не заставляют систему
делегировать работу.

## Fallback chain

Порядок fallback для spawned-child такой:

1. запрошенная основная модель;
2. модельные цепочки из `subagentModelFallbackByModel` (ключ — основная модель); затем
3. глобальные записи `subagentModelFallback`.

Модельные цепочки fallback для ролей должны храниться в конфигурации opencodex. Запись
`model_fallback` в `$CODEX_HOME/agents/*.toml` заставляет Codex 0.146+ отклонить весь файл
роли как неизвестное поле и пропустить роль (#1190). Устаревшая строка `model_fallback` в TOML
по-прежнему читается для обратной совместимости, но `ocx doctor` помечает её.

opencodex пропускает кандидатов, которые отключены, не маршрутизируются, unhealthy, находятся в
cooldown либо уже достигли порога quota. Availability-снимок кэшируется на
`subagentModelFallbackPollMs`. Для шифрованных child-task'ов цепочка ограничена каноническими
native ChatGPT-target'ами и прямыми key-auth Responses-маршрутами, явно доверенными через
`allowEncryptedV2AgentTasks: true`. Если ни один из них не может обработать encrypted payload,
запрос завершается ошибкой вместо отправки нечитаемого ciphertext наружу. Combo по-прежнему
сначала выбирает доступную каноническую native-цель; если её нельзя выбрать и включён
`agentTaskRecovery`, encrypted `NEW_TASK` восстанавливается один раз перед routed combo dispatch.

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackByModel": {
    "gpt-5.5": ["gpt-5.4-mini"]
  },
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Effort cap'ы

Cap'ы применяются только к collaboration-функции v2: main-turn подходит, когда его tool'ы несут
surface v2, а child-turn — когда он помечен точными marker'ами codex-rs
`x-openai-subagent: collab_spawn` или `"subagent_kind": "thread_spawn"` в
`x-codex-turn-metadata`, даже если leaf tool'ы уже не показывают collaboration. Main-turn'ы v1,
`multiAgentMode: "v1"`, compaction, review и turn'ы memory consolidation обходят эти cap'ы.

Cap'ы умеют только понижать effort. Они опускают значение до самой высокой объявленной ступени,
которая не выше cap'а. Если у модели нет управления effort или ни одна поддерживаемая ступень не
помещается под cap, opencodex убирает поле effort и позволяет провайдеру применить собственный
дефолт. `max` и `ultra` принимаются, хотя дашборд предлагает только `low`–`xhigh`.

Если нужен объясняющий вариант для начинающих о поведении v1, default и v2, см.
[Поверхность подагентов](/guides/sub-agent-surface/).
