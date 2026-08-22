---
title: Компаньон шлюза Replit
description: Сопрягите opencodex с собственным развёртыванием Replit, которое ретранслирует OpenAI Chat и Anthropic Messages через Replit AI Integrations — опциональный пользовательский сценарий, а не канонический пресет реестра.
---

**Компаньон шлюза Replit** — это пользовательский Bun-сервис из
[`integrations/replit-gateway`](https://github.com/lidge-jun/opencodex/tree/dev/integrations/replit-gateway),
работающий **внутри вашего развёртывания Replit**. Он читает учётные данные Replit AI Integrations из
среды Repl и предоставляет opencodex два нативных конечных пункта:

```text
opencodex (локально)
  -> HTTPS + ваш ключ шлюза
  -> ваше развёртывание Replit (integrations/replit-gateway)
  -> upstream Replit AI Integrations (OpenAI Chat / Anthropic Messages)
```

opencodex никогда не получает секреты `AI_INTEGRATIONS_*`. Вы задаёте отдельный **ключ шлюза**
(`REPLIT_GATEWAY_KEY`), который opencodex хранит локально и отправляет как `Authorization: Bearer …` в
каждом запросе.

> **Только пользовательский сценарий.** `replit` и `replit-anthropic` **не** являются каноническими
> пресетами реестра. opencodex не заявляет официального провайдера Replit; продвижение в реестр
> заблокировано до письменного разрешения Replit (см. [Порог доказательств](#порог-доказательств)).

> **Экспериментально — развёртывание не проверено.** Код и контракт v1 (`experimental-pending-canary`); **live-развёртывание на Replit не верифицировано.**

## Что нужно

- **Платный план Replit** с доступными
  [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations).
- **Ручное одобрение**, когда Replit Agent просит подключить управляемые интеграции OpenAI и Anthropic.
  opencodex не автоматизирует вход в Replit, биллинг и диалоги интеграций.
- Пакет шлюза, развёрнутый по публичному **HTTPS**-origin (обычно `https://<repl>.replit.app`).
- Запущенный прокси opencodex (`ocx start`) для мастера панели или CLI.

Развёртывание и настройка — в
[README пакета](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md).

## Развёртывание шлюза (кратко)

1. Скопируйте `integrations/replit-gateway/` в Bun Repl.
2. Добавьте `server.ts` с `loadGatewayConfigFromEnv()`, `createGatewayServer()` и
   `Bun.serve({ fetch: gateway.fetch, port, hostname: "0.0.0.0" })`.
3. Одобрите управляемые интеграции **OpenAI** и **Anthropic** в интерфейсе Replit.
4. **Подтвердите наблюдаемые имена `AI_INTEGRATIONS_*` без вывода значений** (ниже).
5. Задайте секреты: `REPLIT_GATEWAY_KEY` (**32–512** печатаемых ASCII), `REPLIT_GATEWAY_PUBLIC_ORIGIN`, списки моделей и четыре точных имени интеграции.
6. Убедитесь, что `GET /healthz` и аутентифицированный `GET /v1/models` успешны.

### Имена среды Replit (неверифицированная наблюдаемая конвенция)

Требуются: `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`. **Не официальный внеплатформенный контракт Replit**; **canary в ожидании**.

```bash
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u
```

Ключ шлюза **32–512** печатаемых ASCII:

```bash
openssl rand -base64 48 | tr -d '\n'
```

Храните только в Replit Secrets и при сопряжении opencodex — не в git.

## Сопряжение с opencodex

Установка записывает **два** пользовательских провайдера, производных от origin развёртывания:

| id провайдера | Адаптер | base URL | Примечания |
| --- | --- | --- | --- |
| `replit` | `openai-chat` | `<origin>/v1` | Обнаружение через `GET /v1/models` |
| `replit-anthropic` | `anthropic` | `<origin>` | Bearer; `liveModels: false` |

Оба используют один ключ шлюза. Непроизводные поля (выбранные модели, pacing, пользовательские
заголовки без учётных данных) сохраняются при замене пары.

### CLI — `ocx provider install-replit`

```bash
export REPLIT_GATEWAY_KEY='your-gateway-key'
ocx provider install-replit --origin https://my-app.replit.app
```

Источник ключа (один): `REPLIT_GATEWAY_KEY`, `--stdin` или `--gateway-key-file <path>`. Ключ **нельзя**
передавать в argv.

Полезные флаги: `--allow-custom-domain`, `--replace`, `--set-default`, `--json`.

Перед записью конфигурации opencodex проверяет только **неоплачиваемые** конечные точки:
`GET <origin>/healthz`, `GET <origin>/v1/models` (Bearer).

### Мастер панели

На странице **Providers** нажмите **Replit gateway…**:

1. Введите **HTTPS origin** и **ключ шлюза**.
2. При необходимости включите **Allow custom domain**.
3. Опционально установите **replit** провайдером по умолчанию.
4. При успехе отображаются тайминги проб health и models.

Если пара уже существует, перед **Replace pair** требуется явное подтверждение. Указано, что это
**не** канонический пресет.

## Opt-in для пользовательского домена

По умолчанию только HTTPS origin с `.replit.app`. Opt-in **не доказывает** владение и **не снимает** ответственность за **DNS rebinding/TLS** после установки. opencodex **выполняет** синтаксис HTTPS, оценку destination/DNS и HTTPS-пробы — **разово**, без гарантии постоянного контроля.

## Холодный старт

Развёртывания Replit могут «засыпать». Первый запрос после простоя может быть медленным или вернуть
`upstream_error` / `upstream_timeout`. Таймаут проб при установке — 8 с. Платные upstream-запросы не
повторяются автоматически.

## Лимиты шлюза (v1)

| Лимит | По умолчанию |
| --- | --- |
| Макс. тело запроса | 32 MiB |
| Макс. заголовки | 32 KiB |
| Макс. параллельных запросов | 10 |
| Таймаут upstream | 300 с |
| Таймаут клиента | 310 с |

HTTP-редиректы upstream отклоняются. Допустимые диапазоны — в README пакета.

## Категории ошибок

Шлюз возвращает стабильные JSON-категории ошибок (без секретов и тел запросов):

`auth_failed`, `config_invalid`, `request_too_large`, `headers_too_large`,
`unsupported_content_encoding`, `model_not_allowed`, `concurrency_limited`, `upstream_timeout`,
`client_timeout`, `client_aborted`, `redirect_rejected`, `upstream_error`, `internal`.

Типичные HTTP-коды: `401` аутентификация, `400` запрещённая модель, `413` слишком большое тело, `415` закодированное тело, `429` лимит параллелизма, `408` таймаут клиента, `504` таймаут upstream, `502` сбой upstream/редиректа.

## Нативные возможности (v1)

**Поддерживается** — потоковая ретрансляция OpenAI Chat и Anthropic Messages. SSE `: heartbeat\n\n` только на **завершённых границах строк**.

**Политика отложенного LF:** при разделённом CRLF и задержке `\n` trailing `\r` может считаться границей строки для heartbeat. **Байты полезной нагрузки не изменяются**; в редких split-CRLF случаях **тайминг** может отличаться.

## Не поддерживается в v1

- Канонический пресет Replit или плитка в селекторе
- Google Gemini, OpenRouter и др. через этот шлюз
- OpenAI Responses, изображения, аудио, транскрипция
- Преобразование протоколов OpenAI ↔ Anthropic
- Автоматические повторы upstream, кэш, нормализация
- CORS для браузера
- `Content-Encoding`, отличный от identity
- live-обнаружение моделей на `replit-anthropic`
- Любая автоматизация действий Replit

## Конфиденциальность, кредиты и условия

- **Граница учётных данных:** в `~/.opencodex/config.json` хранится только ключ шлюза.
- **Биллинг:** использование Replit AI Integrations списывается с кредитов Replit по публичным тарифам API.
- **Условия:** **применимые условия Replit** для вашего плана. [ToS](https://replit.com/terms-of-service) (**Replit, Inc.**); **Pro/Enterprise** — [Commercial Agreement](https://replit.com/commercial-agreement). **Внеплатформенная маршрутизация не авторизована.**
- **Логи:** только метаданные; ключи не попадают в ответы management API.

## Порог доказательств

opencodex поддерживает пресеты только с первичными доказательствами
([Участие — доказательства для канонического пресета](/contributing/#evidence-required-for-a-canonical-preset)).
Компаньон Replit **сегодня не соответствует**.

| Элемент | Статус (проверено 2026-08-22) |
| --- | --- |
| **Внеплатформенные** OpenAI Chat + Anthropic Messages | **Не установлено** |
| Имена `AI_INTEGRATIONS_*` | **Неверифицированная конвенция**; canary в ожидании |
| Условия и юрлицо | ToS — **Replit, Inc.**; Pro/Enterprise: Commercial Agreement |
| Внеплатформенная маршрутизация | **Не получено** |
| Именованный владелец сопровождения | **opencodex:** [@lidge-jun](https://github.com/lidge-jun), [@Ingwannu](https://github.com/Ingwannu) ([`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md)). **Replit:** не партнёр этого сценария. |
| Дата проверки | **2026-08-22** |

**Продвижение в реестр заблокировано.** `replit` / `replit-anthropic` отсутствуют в
`src/providers/registry.ts`.

## См. также

- [README пакета](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)
- [Спецификация](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/2026-08-22-replit-gateway-design.md)
- [Провайдеры](/guides/providers/)
- [Веб-панель](/guides/web-dashboard/)
