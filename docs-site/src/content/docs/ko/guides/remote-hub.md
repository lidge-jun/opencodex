---
title: Remote Hub 배포
description: Linux, macOS, Docker에서 관리 포트는 로컬에만 열고 Tailscale Serve와 헤드리스 OAuth를 사용하는 방법입니다.
---

Remote Hub를 쓰면 프로바이더 인증 정보와 사용량 기록은 허브 한 곳에 두고, 인증된 클라이언트가 허브의 데이터 API를 직접 사용합니다. 브라우저용 관리 API는 별도입니다. 선택 사항인 관리 리스너는 `127.0.0.1`에만 열리며 대시보드와 `/api/*`만 제공합니다.

관리 포트에서는 `/v1/*`, `/healthz`, `/readyz`, WebSocket을 제공하지 않습니다. 이 포트를 직접 공개하거나 방화벽에 열지 말고 Tailscale Funnel도 사용하지 마세요.

## 역할과 데이터 흐름

- `standalone`: 데이터와 관리를 한 컴퓨터에서 처리합니다.
- `hub`: 프로바이더 키, 카탈로그, 사용량 기록을 보관합니다.
- `client`: 연결 정보와 클라이언트 전용 데이터 키 하나만 보관합니다.

Codex와 Claude 요청은 클라이언트에서 허브의 데이터 리스너로 바로 갑니다. 대시보드나 로컬 관리 릴레이를 거치지 않습니다.

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

허브가 발급한 클라이언트별 키는 권한이 제한된 `service-api-token` 파일에 저장됩니다. `config.json`에는 저장되지 않습니다. 연결 중 사용량은 허브 기록에서 해당 `apiKeyId`만 조회하고, 연결을 끊은 뒤에는 로컬 기록을 봅니다. 두 기록은 서로 복제되지 않습니다.

## 보안과 동의 경계

- 프로바이더/OAuth 인증 정보는 허브 밖으로 복사하지 마세요.
- 데이터 키는 `service-api-token` 또는 `OCX_API_TOKEN_FILE`로 전달하며 관리 권한이 없습니다.
- 관리자 토큰은 일반 관리 작업만 할 수 있습니다. 브라우저 동의 세션을 만들거나 저장소 Star 같은 동의 작업을 승인할 수는 없습니다. 그런 작업에는 서버가 발급한 `gui-session`, 일치하는 Origin, CSRF 토큰이 필요합니다.
- `Tailscale-User-Login`은 별도 관리 리스너에서만 신뢰합니다. 공개 리스너의 같은 헤더는 무시합니다. `remoteGui.allowedTailscaleUsers`에는 허용할 로그인 ID를 정확히 적으세요.

## systemd 또는 launchd

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
ocx service status
```

`ocx service install`은 키를 기존 `service-api-token` 경로에 안전하게 저장합니다. plist나 systemd unit에는 실제 키가 들어가지 않습니다.

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
```

`/healthz`의 `200`은 프로세스가 살아 있다는 뜻뿐입니다. 실제 배포 확인에는 `/readyz`, 인증된 `GET /v1/catalog`, 실제 모델 요청 1회가 모두 필요합니다.

## Tailscale Serve

```bash
ss -ltnp | grep 10101
lsof -nP -iTCP:10101 -sTCP:LISTEN
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

관리 포트는 `127.0.0.1:10101`에서만 보여야 합니다. `hub.managementPublicOrigin`은 Serve가 표시한 정확한 HTTPS Origin으로 설정하세요. 직접 TLS 프록시를 운영한다면 `tailscale cert hub-name.tailnet-name.ts.net`으로 ts.net 전체 FQDN 인증서만 발급하고 `127.0.0.1:10101`로만 프록시하세요. 임의의 `Tailscale-User-*` 헤더를 만들지 말고, 신뢰할 수 있는 Tailscale 신원이 없으면 일회용 pairing을 사용하세요.

## 헤드리스 OAuth

```bash
ocx config set oauthOpenBrowser false
```

인증된 대시보드에서 `POST /api/oauth/login`을 시작하고, 운영자 컴퓨터에서 반환된 URL을 엽니다. 콜백이 허브에 닿지 않으면 최종 리디렉션 URL이나 코드를 `POST /api/oauth/login/code`의 `{provider,input}`으로 전달하세요. OAuth 코드를 argv, 로그, 이슈, 스크린샷에 남기지 마세요.

## 키 교체와 연결 해제

```bash
ocx connect rotate --pairing-code-stdin
# HTTPS에서만:
ocx connect rotate --admin-token-stdin
```

기존 키와 새 키는 같은 `apiKeyId`로 최대 10분 동안 함께 유효합니다. 클라이언트는 기존 키를 `service-api-token.prev`에 백업하고, 새 키를 원자적으로 적용해 `/v1/catalog`로 확인한 다음 확정합니다. 결과가 불확실하면 임시 권한을 다시 넣어 같은 명령을 실행하세요. 현재 파일과 `.prev`를 모두 확인한 뒤 확정하거나 복원합니다.

`ocx disconnect`는 허브가 꺼져 있어도 로컬 상태를 복원하며 허브 키를 삭제하지 않습니다. 연결을 끊은 뒤에는 허브 대시보드의 **Integrations → API Keys**에서 키를 삭제해야 합니다. `ocx connect revoke --admin-token-stdin`은 연결 중에만 사용할 수 있으며 저장된 `apiKeyId`만 사용합니다.

## Docker

롤백할 때도 두 볼륨과 마운트 경로를 유지하세요. 기존 볼륨의 소유권과 권한은 자동으로 복구되지 않습니다. Compose 없이 실행할 때의 named volume 지정과 별도 상태 경로는 [영문 기준 가이드](/guides/remote-hub/#docker-compose)를 참고하세요.

상태는 두 볼륨에 분리해 보관합니다. `ocx-state`는
`OPENCODEX_HOME=/home/bun/.opencodex`, `codex-state`는
`CODEX_HOME=/home/bun/.codex`에 연결됩니다. 두 제품의 `auth.json` 형식이 다르므로
홈을 같은 폴더로 합치지 마세요. 루트 파일 시스템이 read-only여도 이 두 홈은 쓰기 가능합니다.

카탈로그는 자동 생성되지 않습니다. 인증된 `/v1/catalog` 검사 전에 유효한
`/home/bun/.codex/opencodex-catalog.json`을 생성하거나 가져와야 합니다.
빈 홈에서 `catalog_not_found` 404는 정상입니다. 업그레이드는 기존 `ocx-state`를
유지하고 `codex-state`를 추가하지만 파일을 자동 이동하지 않습니다. 이전 우회 설정으로
`.opencodex`에 둔 카탈로그는 백업한 뒤 카탈로그만 owner-only 권한으로 옮기세요.
두 제품의 `auth.json`을 서로 덮어쓰면 안 됩니다. 사용자 지정 `CODEX_HOME`은 그 정확한
디렉터리를 쓰기 가능한 볼륨에 연결하고, 기본 카탈로그를
`${CODEX_HOME}/opencodex-catalog.json`에 준비해야 합니다. `model_catalog_json`으로
별도 파일을 지정했다면 그 경로도 영속 보관하세요. 명시적 이전이 완료되기 전까지는
기존 사용자 지정 환경 변수와 볼륨 경로의 대응을 유지하세요.

opencodex는 공식 컨테이너 이미지를 배포하지 않지만, 저장소 루트의 `Dockerfile`과 `compose.yaml`로 digest가 고정된 소스 이미지를 직접 빌드할 수 있습니다. 최초 실행 전에 데이터 키를 stdin으로 초기화하세요. 키는 출력되지 않으며 `ocx-state` 볼륨의 owner-only `service-api-token`에 저장됩니다.

호스트에 Git과 Bun이 필요합니다. 이미지를 빌드할 때마다 Git이 추적하는 소스로 정식 매니페스트를 생성하고, 생성부터 빌드 사이에는 소스를 변경하지 마세요. 생성된 JSON은 Git에 추가하지 않으며 `.git`은 Docker 컨텍스트에서 제외됩니다. 호스트 포트는 기본적으로 `127.0.0.1`에 바인딩됩니다. 원격 공개는 `OPENCODEX_BIND_ADDRESS=<LAN-또는-Tailscale-IP> docker compose up -d`로 명시적으로 선택하며, `0.0.0.0`은 모든 인터페이스에 공개합니다. 방화벽과 인증된 TLS/tailnet 프런트엔드로 보호하세요.

빌드는 오래된 매니페스트를 거부하며 모든 SHA-256을 컨텍스트와 복사된 파일에 각각 대조합니다. 누락·불일치 파일, 매니페스트에 없는 추가 소스, 심볼릭 링크는 거부됩니다. `package.json`, `bun.lock`과 `scripts/`에서 유일하게 포함하는 `scripts/model-metadata.source.json`이 필수입니다.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

이미지는 non-root `bun` 사용자로 실행되고 루트 파일 시스템은 read-only이며 공개 포트는 `10100` 하나뿐입니다. 토큰을 `ARG`, `ENV`, `COPY`, Compose YAML, 이미지 기록, 명령행에 넣지 마세요. Docker socket, 호스트의 홈이나 Codex 홈, SSH agent, 프로바이더 키도 마운트하지 마세요. 컨테이너 안의 `127.0.0.1:10101` 관리 포트는 같은 네트워크 네임스페이스의 TLS/tailnet 프런트엔드로만 연결하고 직접 publish하지 마세요.

컨테이너 healthcheck의 `/healthz`가 통과한 뒤 `/readyz`, 인증된 `/v1/catalog`, 실제 모델 응답을 별도로 확인하세요.

`docker compose down`은 `ocx-state`와 `codex-state`를 모두 보존합니다. `docker compose down --volumes`는 두 볼륨을 모두 삭제하여 설정, OAuth 인증 정보, 사용량 기록, 데이터 키, Codex 상태와 카탈로그를 지웁니다. 업그레이드나 재시작 대신 사용하지 마세요.

## 롤백과 문제 해결

`tailscale serve reset`은 노드의 모든 매핑을 지우므로 먼저 `tailscale serve status`를 확인하세요. 서비스 롤백 때는 같은 `OPENCODEX_HOME`을 유지한 채 이전 릴리스를 `ocx service repair`로 복구합니다.

- 허브가 꺼져 있으면 `ocx disconnect`로 오프라인 복원할 수 있지만 원격 키는 삭제되지 않습니다.
- 일시적 허브 오류에서는 검증된 마지막 카탈로그를 유지합니다. 인증·스키마·크기·프로토콜 오류는 로컬 프로바이더로 대체하지 않습니다.
- `.prev` 복구가 필요하면 두 파일을 지우지 말고 임시 권한과 함께 `ocx connect rotate`를 다시 실행하세요.
- `hub-too-new` 또는 `hub-too-old`가 나오면 메시지가 가리키는 오래된 쪽을 업그레이드하세요. 불일치는 로컬 파일을 쓰기 전에 차단됩니다.
- pairing 코드는 일회용이며 반복 실패는 429로 제한됩니다. 코드를 잃었거나 소진했다면 새로 만드세요.
- 루프백이 아닌 HTTP pairing은 `--allow-insecure-http`를 명시해야 합니다. 관리자 토큰은 HTTP로 보내지 않습니다.
- 브라우저 로그아웃/만료는 해당 원격 세션만 끊습니다. 데이터 키와는 별개입니다.
- 연결 해제 후 남은 키는 허브의 **Integrations → API Keys**에서만 폐기할 수 있습니다.
