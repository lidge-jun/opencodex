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
| `subagentModels?` | `string[]` | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | До пяти native- или routed-id, которые показываются первыми в picker'е подагентов. Явный пустой список сохраняется. |
| `injectionModel?` | `string` | — | Предпочитаемая native- или routed-модель подагента, которую proxy использует в собственном guidance v2. |
| `injectionEffort?` | `string` | — | Предпочитаемый effort (`low`–`ultra`), имеющий смысл только вместе с `injectionModel`. |
| `injectionPrompt?` | `string` | — | Заменяет встроенное тело guidance. Поддерживает `{{model}}`, `{{effort}}`, `{{roster}}` и `{{fallback}}`. Условия срабатывания при этом не меняются. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Управляет только developer-guidance, написанным самим opencodex, для v1/v2; не меняет native default'ы агентов, tools, routing, roster'ы и effort cap'ы. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Разрешает записывать `injectionModel` и, при наличии, `injectionEffort` как native default'ы Codex при sync/restart. Требует `injectionModel`. |
| `subagentModelFallback?` | `string[]` | `[]` | Глобальные fallback-модели для порождённых child-turn'ов в порядке приоритета. |
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

## Roster и guidance

Эффективный ростер v2 — это настроенные, видимые в picker'е, отсортированные по priority первые
пять моделей, совместимых с v2 и присутствующих во внедряемом каталоге. Для v2 запись считается
допустимой, если upstream pin равен `"v2"`, `null` либо вовсе отсутствует; реальный pin `"v1"`
исключает модель. Исключённые записи всё равно остаются в конфигурации, чтобы позже снова стать
допустимыми.

Определение surface основано на форме tool'ов. Namespaced `spawn_agent` вместе с `send_input`,
`resume_agent` или `close_agent` — это v1. Плоский `spawn_agent` вместе с `send_message`,
`followup_task`, `interrupt_agent` или `list_agents` — это v2.

Для v1 guidance — это только proactive text и только на уровнях `max` или `ultra`. Для v2
proxy-authored developer message добавляется только когда существует preferred model, допустимый
roster или fallback chain. Встроенное guidance v2 ограничено 700 символами и при необходимости
сначала удаляет roster. Guidance дедуплицируется по replay-prefix и вставляется перед завершающим
`compaction_trigger`.

`injectionModel` и `injectionEffort` носят рекомендательный характер, если только не включён
native-default sync. Встроенный текст v2 просит Codex передавать поддерживаемые override'ы model
и effort в `spawn_agent` с `fork_turns: "none"`. В custom `injectionPrompt` отсутствующие значения
подставляются как пустая строка.

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
2. role-level `model_fallback` из `$CODEX_HOME/agents/*.toml`; затем
3. глобальные записи `subagentModelFallback`.

opencodex пропускает кандидатов, которые отключены, не маршрутизируются, unhealthy, находятся в
cooldown либо уже достигли порога quota. Availability-снимок кэшируется на
`subagentModelFallbackPollMs`. Шифрованные child-task'и могут ограничить цепочку каноническими
native ChatGPT-target'ами; если ни одна из них не может прочитать encrypted payload, запрос
завершается ошибкой вместо отправки нечитаемого ciphertext наружу.

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
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
