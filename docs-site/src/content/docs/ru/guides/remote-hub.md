---
title: Развёртывание Remote Hub
description: Hub с локальным контуром управления, Tailscale Serve и OAuth без локального браузера.
---

Remote Hub хранит учётные данные провайдеров, каталог и статистику на одном хосте. Авторизованные клиенты обращаются непосредственно к его плоскости данных. Контур управления отделён: необязательный listener привязан только к `127.0.0.1` и обслуживает панель и `/api/*`, но не `/v1/*`, `/healthz`, `/readyz` или WebSocket. Не публикуйте `10101` и не используйте Tailscale Funnel.

## Роли и границы доверия

`standalone` объединяет всё на одной машине; `hub` владеет секретами и статистикой; `client` хранит только состояние подключения и отдельный ключ данных.

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

Ключ клиента записывается в защищённый `service-api-token`, а не в `config.json`. При подключении статистика читается с hub и фильтруется по `apiKeyId`; после отключения используется локальное хранилище. Зеркалирования нет.

Admin token разрешает обычное управление, но никогда не создаёт consent session. Для действий с согласием нужны `gui-session`, совпадающий Origin и CSRF. Заголовок `Tailscale-User-Login` доверен только отдельному management ingress; точные логины задаются в `remoteGui.allowedTailscaleUsers`.

## Сервис и Tailscale Serve

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

systemd/launchd читает секрет из `service-api-token`; plist и unit не содержат его значения.

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` подтверждает только работу процесса. Проверьте также `/readyz`, авторизованный `GET /v1/catalog` и реальный ответ модели. Собственный TLS-прокси должен использовать `tailscale cert hub-name.tailnet-name.ts.net` и проксировать только на `127.0.0.1:10101`. Не подделывайте `Tailscale-User-*`; без доверенной идентификации используйте одноразовое pairing.

## OAuth, ротация и отключение

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# только HTTPS:
ocx connect rotate --admin-token-stdin
```

OAuth запускается через `POST /api/oauth/login`. Если callback недоступен, передайте итоговый URL или код как `{provider,input}` в `POST /api/oauth/login/code`. Не помещайте код в argv или логи.

При ротации старый и новый ключи действуют под одним `apiKeyId` не более десяти минут. Старый ключ сохраняется в `service-api-token.prev`, новый устанавливается атомарно и проверяется через `/v1/catalog`, затем подтверждается. При неопределённом результате повторите команду с временными полномочиями и не удаляйте кандидаты до проверки.

`ocx disconnect` восстанавливает локальное состояние даже без hub, но не отзывает удалённый ключ. После отключения отзыв возможен только на странице hub **Integrations → API Keys**. `ocx connect revoke --admin-token-stdin` доступен только пока клиент подключён.

## Docker и устранение неполадок

При откате сохраняйте оба тома и их точки монтирования. Владельцы и права существующих томов не исправляются автоматически. Именованные тома вне Compose и отдельные пути состояния описаны в [основном руководстве](/guides/remote-hub/#docker-compose).

Состояние хранится в двух отдельных томах: `ocx-state` для
`OPENCODEX_HOME=/home/bun/.opencodex` и `codex-state` для
`CODEX_HOME=/home/bun/.codex`. Форматы `auth.json` у двух продуктов несовместимы,
поэтому не объединяйте их домашние каталоги. Оба тома доступны для записи при
корневой файловой системе только для чтения.

Каталог моделей автоматически не создаётся. Перед проверкой авторизованного
`/v1/catalog` создайте или импортируйте корректный файл
`/home/bun/.codex/opencodex-catalog.json`. Для пустого каталога состояния ответ
404 `catalog_not_found` ожидаем. Обновление сохраняет `ocx-state` и добавляет
`codex-state`, но не переносит файлы автоматически. Если обходное решение хранило
каталог моделей в `.opencodex`, сначала сделайте резервную копию, затем перенесите
только каталог моделей с доступом лишь для владельца. Не перезаписывайте один
`auth.json` другим. При переопределении `CODEX_HOME` монтируйте именно эту директорию
для записи и сохраняйте каталог по умолчанию в `${CODEX_HOME}/opencodex-catalog.json`.
Если `model_catalog_json` задаёт другой файл, его разрешённый путь также должен
храниться постоянно. До явного переноса сохраняйте прежнее соответствие переменных
окружения и томов. `docker compose down` сохраняет оба тома, а
`docker compose down --volumes` удаляет и `ocx-state`, и `codex-state`, включая
учётные данные, историю использования, ключ данных, состояние и каталог Codex.
Это разрушительная операция, а не способ обновления или перезапуска.

Официального Docker-образа нет, но репозиторий содержит поддерживаемые `Dockerfile` и `compose.yaml` для локальной сборки Bun-образа, закреплённого по digest. Перед первым запуском один раз передайте ключ данных через stdin; он не выводится и сохраняется с доступом только для владельца в volume `ocx-state`.

На хосте нужны Git и Bun. Перед каждой сборкой создавайте канонический манифест из отслеживаемых Git исходников и не меняйте их до завершения сборки. Сгенерированный JSON не добавляйте в Git; `.git` исключён из контекста Docker. По умолчанию порт хоста привязан к `127.0.0.1`. Для удалённого доступа явно задайте `OPENCODEX_BIND_ADDRESS=<LAN-или-Tailscale-IP> docker compose up -d`; `0.0.0.0` открывает все интерфейсы. Защитите доступ брандмауэром и аутентифицированным TLS/tailnet-фронтендом.

Сборка отклоняет устаревший манифест, сверяя каждый SHA-256 с файлами контекста и затем образа. Отсутствующие или изменённые файлы, лишние исходники и символические ссылки запрещены. Обязательны `package.json`, `bun.lock` и единственный включаемый файл из `scripts/` — `scripts/model-metadata.source.json`.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

Контейнер работает от непривилегированного пользователя `bun`, с корневой файловой системой только для чтения и публикует только `10100`. Не публикуйте `10101` и не помещайте секреты в `ARG`, `ENV`, `COPY`, Compose, историю образа или argv. После healthcheck отдельно проверьте readiness, аутентифицированный каталог и реальный запрос. `docker compose down` сохраняет volume; `docker compose down --volumes` удаляет также конфигурацию, учётные данные и ключ.

- При недоступном hub можно отключиться офлайн, но отзыв ключа останется незавершённым.
- LKG сохраняется только при временном сбое; при ошибке auth, схемы, размера или протокола локального fallback нет.
- Для `.prev` сохраните оба файла и повторите ротацию с временными полномочиями.
- `hub-too-new`/`hub-too-old` указывает, какую сторону обновить; локальные записи ещё не сделаны.
- Pairing одноразовый, попытки ограничены 429; потерянный код создайте заново.
- Для не-loopback HTTP нужен `--allow-insecure-http`; admin token по HTTP не отправляется.
- Logout/expiry браузерной сессии не отзывает ключ данных.
- Перед `tailscale serve reset` просмотрите все mappings через `tailscale serve status`.
