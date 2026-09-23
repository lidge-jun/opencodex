---
title: Клиенты MiniMax
description: Направляйте текстовые команды MiniMax Code и MiniMax CLI через OpenCodex, не раскрывая учётные данные MiniMax.
---

MiniMax выпускает два разных продукта для командной строки. OpenCodex подключает каждый
через тот протокол, который продукт действительно поддерживает:

- **MiniMax Code** (`mcode`) — агент для разработки с пользовательскими провайдерами Anthropic Messages.
- **MiniMax CLI** (`mmx`) — мультимодальный CLI платформы. Только его ресурс `text` использует
  Anthropic-совместимый API, который OpenCodex может маршрутизировать.

## MiniMax Code

Сначала установите MiniMax Code и войдите в систему по инструкции MiniMax. Затем запустите
OpenCodex и подключите обратимую файловую интеграцию:

```bash
ocx start
ocx integration client enable --client mcode
ocx mcode
```

![Интеграция MiniMax Code с изолированными примерными данными](/screenshots/minimax-code-integration.png)

Интеграция добавляет один блок в `~/.minimax/config.yaml`:

```yaml
custom_provider:
  opencodex:
    name: OpenCodex
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: opencodex-loopback
      baseURL: http://127.0.0.1:10100
      authMode: api-key
    models:
      anthropic/claude-opus-5:
        limit:
          context: 1000000
```

Фактический список моделей, известные размеры контекстных окон и ступени effort берутся
из работающего каталога OpenCodex. Если для модели нет достоверного размера окна или
ступеней effort, соответствующее поле опускается, а значение не угадывается. MCode
хранит выбранный effort в сессии, поэтому OpenCodex экспортирует `effortOptions`, не
перезаписывая этот выбор. Блок не записывает настоящий ключ, не заменяет
`defaultModel` и не меняет ваш вход в MiniMax. В MCode выберите модель в разделе
`custom_provider:opencodex/...`.

Перед запуском клиента `ocx mcode` проверяет, что этот провайдер указывает на работающий
прокси. После однократного включения `ocx sync` обновляет принадлежащий интеграции блок
при изменении порта или возможностей каталога. Автоматическая синхронизация никогда не
создаёт чужой блок, не восстанавливает удалённый вами блок и не перезаписывает файл,
который изменился после записи OpenCodex; для намеренного повторного подключения
используйте команду включения. Отключить или восстановить интеграцию можно через ту же
систему операций с журналом:

```bash
ocx integration client disable --client mcode
ocx integration client history --client mcode
ocx integration client restore --op <opId> [--confirm-drift]
```

Учитываются `MINIMAX_DATA_DIR` и прежняя переменная `MAVIS_DATA_DIR`. Относительные
переопределения отклоняются: OpenCodex и MCode могут запускаться из разных каталогов.

## MiniMax CLI (`mmx`)

Установите официальный CLI отдельно:

```bash
npm install -g mmx-cli
mmx --version
```

Чтобы направить текстовую команду через OpenCodex, используйте обёртку и id модели OpenCodex:

```bash
ocx mmx text chat \
  --model anthropic/claude-opus-5 \
  --message "Explain this function"

ocx mmx --output json text chat \
  --model openai/gpt-5.6-sol \
  --message "Return a JSON summary"
```

MMX жёстко добавляет `/anthropic/v1/messages` к базовому URL API. На время работы
дочернего процесса обёртка запускает временный мост на loopback. Он принимает только
POST-запросы к этому пути Messages и `/anthropic/v1/messages/count_tokens`, сопоставляя
их с существующими эндпоинтами данных OpenCodex `/v1/messages` и
`/v1/messages/count_tokens` и сохраняя тела запросов и параметры запроса. При этом
действуют обычное преобразование запросов OpenCodex, учёт использования и настроенная
аутентификация конечного провайдера: провайдер получает `x-api-key` или bearer-транспорт
согласно конфигурации. Потоковая передача сохраняет события сообщений и содержимого
Anthropic. Перед пересылкой мост удаляет входящие заголовки учётных данных допуска и
подставляет публичную заглушку `opencodex-loopback`. Другие ресурсы Anthropic не
проксируются, а мост никогда не открывается за пределами loopback.

Обёртка также создаёт временный `MMX_CONFIG_DIR`, содержащий только эту заглушку, и
удаляет его после завершения `mmx`. Ваши `~/.mmx/config.json`, токены OAuth и API-ключ
MiniMax не загружаются и не копируются.

Следующие ограничения преднамеренны:

- Через OpenCodex маршрутизируются только `text chat` и `text repl`.
- Обёртка отклоняет `--api-key`, `--base-url` и `--region`, чтобы учётные данные или
  адрес назначения вызывающей стороны не конфликтовали с изолированным мостом.
- Обёртка работает только через loopback: MMX не умеет отправлять специальный
  заголовок допуска OpenCodex `x-opencodex-api-key` для удалённой привязки.
- Запускайте обычный `mmx` для `image`, `video`, `speech`, `music`, `vision`, `search`, `quota`,
  `auth`, `config`, `file` и `update`: эти команды вызывают API MiniMax, которые OpenCodex
  не эмулирует.

По умолчанию `mmx` использует для текста модель `MiniMax-M3`. Передайте
`--model <provider/model>`, если нужен конкретный маршрут OpenCodex; иначе обычные
правила маршрутизации OpenCodex определят, доступен ли id по умолчанию.
