---
title: Grok Build
description: Используйте любую модель, маршрутизируемую opencodex, из CLI xAI Grok Build — пока прокси работает, модели автоматически регистрируются в ~/.grok/config.toml.
---

opencodex отдаёт OpenAI-совместимый `POST /v1/chat/completions` (и `/v1/responses`) на своём
локальном порту, а Grok Build поддерживает custom-модели поверх OpenAI-совместимых серверов.
Начиная с этой интеграции, opencodex автоматически регистрирует весь свой видимый каталог в
Grok Build — вручную редактировать конфигурацию не нужно.

## Авторегистрация

Когда существует `~/.grok`, `ocx start` (а также `ocx ensure` и `ocx restart`) записывает
управляемый блок в `~/.grok/config.toml`:

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... remaining rungs for this model, then one [model.ocx-*] table per visible model,
# each referencing model_provider = "opencodex" ...
# <<< opencodex managed block <<<
```

- **Additive:** ваша собственная конфигурация вне fenced-блока никогда не трогается. Перед первым
  внедрением в уже существующий файл создаётся одноразовая резервная копия
  `~/.grok/config.toml.bak-opencodex`.
- **Idempotent:** каждый `ocx start` (и `ocx ensure`, когда включён автозапуск) заменяет fenced-блок
  текущим каталогом.
- **Removed on teardown:** `ocx stop`, `ocx eject`, `ocx uninstall` и корректное завершение
  не-service-демона удаляют fenced-блок и побайтно восстанавливают ваш файл. Под service manager
  teardown выполняется через `ocx stop`/`ocx uninstall` (процессы service-mode намеренно
  сохраняют блок между respawn'ами).
- **Conflict-safe:** alias, уже объявленные в ваших `[model.*]`, уважаются (opencodex добавляет
  суффиксы к своим записям); повреждённый fence (маркер начала без маркера конца) запрещает любые
  автоматические изменения и просит ручного исправления.

После этого выберите модель в Grok Build:

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

## Уровень рассуждения

Команда Grok Build `/effort` (и флаг `--effort`) работает для моделей, чья запись в каталоге
публикует шкалу уровней. Список моделей читает исходный ответ `GET /v1/models`; записи в нём
должны содержать `supports_reasoning_effort` и пункты меню `reasoning_efforts`. Совместимая с
Grok проекция этой шкалы записывается в каждую управляемую таблицу `[model.*]` через
`supports_reasoning_effort`,
значение `reasoning_effort` по умолчанию и строки
`[[model.<alias>.reasoning_efforts]]`. Для маршрутизируемых моделей opencodex отражает
настроенные уровни провайдера (`reasoningEfforts` / `modelReasoningEfforts` и значение по
умолчанию из `modelDefaultReasoningEfforts`). Эти метаданные описывают шкалу прокси; адаптеры
могут эмулировать рассуждение или преобразовывать уровни в поля конкретного провайдера. Модели
с пустым списком уровней не показывают управление effort. Нативные записи GPT-5.6 сохраняют
закреплённые upstream-шкалы. Допустимые уровни Grok, включая `none` и `minimal`, сохраняются,
когда модель их объявляет. Неподдерживаемые или повторяющиеся уровни, в том числе предназначенный
для Codex `ultra`, исключаются из файла; каждый записанный пункт остаётся доступным для выбора.

Grok Build обращается к opencodex через Responses API. Когда маршрут объявляет шкалу
рассуждений, passthrough Responses пересылает `reasoning.summary` в соответствии с настройкой,
поэтому трассировка рассуждений доходит до Grok нативно в виде элементов reasoning Responses.
Клиент может оставить рассуждение модели и скрыть трассировку с помощью
`reasoning.summary: "none"`. Явно заданный `reasoning.summary` имеет приоритет над значением
по умолчанию для маршрута.

## Замечание об аутентификации

Grok Build требует непустой API-ключ для custom-моделей даже на loopback. Внедряемые записи несут
placeholder (`opencodex-loopback`) — opencodex игнорирует admission key для loopback-подключений,
так что реальный секрет тут не используется.

**Авторегистрация работает только на loopback.** Когда opencodex привязывается к не-loopback-хосту
— включая wildcard `0.0.0.0` и `::`, открывающие все интерфейсы, — запросам нужен ваш настоящий
admission token, а управляемый блок не может безопасно его хранить. Запись буквального токена
поместила бы ваш секрет в `~/.grok/config.toml` и перезаписывала бы установленное вами значение
при каждом `ocx start`/`ensure`/`restart`. Поэтому в этом случае opencodex вообще ничего не
записывает (и удаляет блок, оставшийся от прежней loopback-привязки), а вы настраиваете модели
сами, вне managed-маркеров, где opencodex ничего не сможет затереть. Точный пример таблицы см. в
[ручном рецепте](#manual-recipe-without-auto-registration), а в `base_url` укажите хост, который
действительно достижим из того места, где вы запускаете `grok`, и в `api_key` укажите
`OPENCODEX_API_AUTH_TOKEN`.

Не заменяйте здесь `api_key` на `env_key`. `env_key`, который не
разрешился, не останавливает запрос — Grok откатывается к вашему session token xAI и отправляет
его на любой `base_url`, указанный в записи, а для LAN-развёртывания это plaintext HTTP-endpoint,
который не является xAI.

Внедрённый в запись провайдера `api_key` стоит первым в цепочке учётных данных Grok для этих моделей,
поэтому ходам через opencodex не нужен дополнительный `grok login`. Обычную настройку
`grok login` / `XAI_API_KEY` сохраняйте для нативных grok-моделей и любых harness-функций, которые
напрямую обращаются к xAI.

## Ручной рецепт без авторегистрации

Если вы управляете `~/.grok/config.toml` сами — либо opencodex привязан не к loopback, —
добавляйте блок `[model_providers.opencodex]` и таблицы по одной модели, которые его
ссылают, вне маркеров `# >>> opencodex managed block`:

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Для прокси, доступного по сети, укажите в `base_url` адрес, до которого `grok` реально может
дозвониться, и используйте свой admission token:

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Управляемый блок теперь использует наследование `[model_providers.<id>]`, что требует Grok Build 0.2.109 или новее (выпущен 2026-07-21). На более старых версиях унаследованный `base_url` не применяется к маршрутизации inference — обновитесь, либо используйте прямые поля на уровне модели (`base_url`/`api_backend`/`api_key` в каждой таблице `[model.*]`).

Любой alias, содержащий точку, берите в кавычки: голый `[model.grok-4.5]` — это путь из трёх
сегментов, а не id `grok-4.5`. Сгенерированные alias по этой причине вообще избегают точек.

## Известные ограничения

- **`ocx restart` при установленной службе:** работающий прокси сам управляет drain и заменой,
  поэтому supervision службы и managed block сохраняются. Команда завершается успешно только после
  того, как на том же порту станет здоровым другой процесс с проверенной идентичностью.
- **Время чтения конфигурации:** для наиболее предсказуемого поведения сначала запускайте
  opencodex, а затем `grok`. Grok Build отслеживает `~/.grok/config.toml` и перезагружает его,
  когда секция `[model]` действительно меняется (порядка секунды debounce, сравнение по
  содержимому), поэтому обновлённый блок доходит до уже открытой сессии без перезапуска. Чтобы
  проверить, что именно разобрал Grok, выполните `grok inspect`: он перечисляет источники
  конфигурации и предупреждает о полях, которые отверг. Список разрешённых моделей при этом не
  печатается. Текущая версия Grok Build сообщает о недопустимых полях модели, пропускает их и
  сохраняет остальные данные записи. Синтаксическая ошибка TOML препятствует загрузке файла.
  opencodex пишет файл атомарно, поэтому при каждой перезагрузке Grok видит целый документ.
- **Обновления каталога:** fenced-блок отражает каталог на момент внедрения. После добавления
  провайдеров или моделей выполните `ocx ensure` (или перезапустите прокси), чтобы его обновить.
