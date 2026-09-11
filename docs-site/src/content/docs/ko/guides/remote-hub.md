---
title: Remote Hub 배포
description: Linux, macOS, Docker에서 포트 하나로 동작하는 opencodex 허브를 구성합니다. 루프백 companion 리스너, 스스로 준비되는 데이터 토큰, ocx hub invite, 로컬 전용 관리 인그레스, Tailscale Serve, 헤드리스 OAuth를 다룹니다.
---

Remote Hub를 쓰면 프로바이더 인증 정보와 사용량 기록은 허브 한 곳에 두고, 인증된 클라이언트가 허브의 데이터 API를 직접 사용합니다. 브라우저용 관리 API는 별도입니다. 선택 사항인 관리 리스너는 `127.0.0.1`에만 열리며 대시보드와 `/api/*`만 제공합니다.

데이터 플레인은 **포트 하나**입니다. 원격 컴퓨터는 `hostname:port`를 자기 전용 키로 호출하고, 허브 자신의 프로세스는 **같은 포트**의 `127.0.0.1`을 자격 증명 없이 호출합니다. 후자를 담당하는 것이 루프백 companion 리스너입니다. 아래 [설치 레시피](#systemd-또는-launchd)로 시작한 뒤, [`ocx hub invite`](#다른-컴퓨터-초대하기)로 다른 컴퓨터에 그대로 붙여 넣을 명령을 건네세요.

관리 포트에서는 `/v1/*`, `/healthz`, `/readyz`, WebSocket을 제공하지 않습니다. 이 포트를 직접 공개하거나 방화벽에 열지 말고 Tailscale Funnel도 사용하지 마세요.

## 보안과 동의 경계

- 프로바이더/OAuth 인증 정보는 허브 밖으로 복사하지 마세요.
- 데이터 키는 `service-api-token` 또는 `OCX_API_TOKEN_FILE`로 전달하며 관리 권한이 없습니다.
- 관리자 토큰은 일반 관리 작업만 할 수 있습니다. 브라우저 동의 세션을 만들거나 저장소 Star 같은 동의 작업을 승인할 수는 없습니다. 그런 작업에는 서버가 발급한 `gui-session`, 일치하는 Origin, CSRF 토큰이 필요합니다.
- `Tailscale-User-Login`은 별도 관리 리스너에서만 신뢰합니다. 공개 리스너의 같은 헤더는 무시합니다. `remoteGui.allowedTailscaleUsers`에는 허용할 로그인 ID를 정확히 적으세요.

## 역할과 데이터 흐름

- `standalone`: 데이터와 관리를 한 컴퓨터에서 처리합니다.
- `hub`: 프로바이더 키, 카탈로그, 사용량 기록을 보관합니다.
- `client`: 연결 정보와 클라이언트 전용 데이터 키 하나만 보관합니다.

Codex와 Claude 요청은 클라이언트에서 허브의 데이터 리스너로 바로 갑니다. 대시보드나 로컬 관리 릴레이를 거치지 않습니다.

임시 권한은 stdin으로만 전달하며 설정 파일이나 토큰 파일에 저장되지 않습니다.

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

이 줄을 직접 만들 필요는 없습니다. 허브에서 `ocx hub invite`를 실행하면 코드를 발급하고, 두 Origin이 모두 채워진 명령을 그대로 출력합니다. [다른 컴퓨터 초대하기](#다른-컴퓨터-초대하기)를 보세요.

허브가 발급한 클라이언트별 키는 권한이 제한된 `service-api-token` 파일에 저장됩니다. `config.json`에는 저장되지 않습니다. 연결 중 사용량은 허브 기록에서 해당 `apiKeyId`만 조회하고, 연결을 끊은 뒤에는 로컬 기록을 봅니다. 두 기록은 서로 복제되지 않습니다.

## systemd 또는 launchd

데이터 리스너는 허브의 Tailscale 주소에 바인드하고, 허브 자신의 프로세스가 같은 포트를 자격 증명 없이 쓸 수 있도록 루프백 companion을 켜고, 관리 평면은 따로 공개합니다. 아래 값은 예시입니다.

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set corsAllowOrigins '["http://localhost:10100"]'

# 새로 만든 standalone 설정에는 `hub`나 `remoteGui` 객체가 없고, `ocx config set`은 없는 부모를
# 만들어 주지 않습니다. 중첩 경로를 먼저 쓰면 `config parent path not found: hub`로 실패합니다.
# `runtimeRole`을 설정해도 객체는 생기지 않습니다. 빈 객체를 먼저 만들고 필드를 설정하세요.
ocx config set hub '{}'
ocx config set remoteGui '{}'
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set hub.dataPublicOrigin '"https://hub-name.tailnet-name.ts.net:8443"'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'

# 포트 하나. 원격 컴퓨터는 100.64.0.10:10100을 자기 키로 호출하고, 허브의 로컬 프로세스는
# 같은 포트의 127.0.0.1:10100을 자격 증명 없이 호출합니다.
ocx config set unauthenticatedLoopbackListener '{"enabled":true}'

# 손으로 내보낼 토큰은 없습니다. install이 허브 전용 데이터 플레인 토큰을 직접 준비합니다.
ocx service install
ocx service status
ocx status                # "Hub:" 블록이 위의 모든 값을 요약합니다
```

설정이 완전히 비어 있다면 객체를 한 번에 설정할 수도 있습니다.

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","dataPublicOrigin":"https://hub-name.tailnet-name.ts.net:8443","managementIngress":{"enabled":true,"port":10101}}'
ocx config set remoteGui '{"allowedTailscaleUsers":["operator@example.com"]}'
```

이 형태는 객체가 아직 없을 때만 쓰세요. 객체 전체를 설정하면 병합이 아니라 **교체**되므로, 이미 `hub.managementIngress`가 있던 설정에 위 줄을 실행하면 인그레스가 조용히 사라집니다. 기존 설정을 수정할 때는 부모가 이미 있으므로 필드를 하나씩 설정하면 되고, 그 경우 다른 값은 건드리지 않습니다.

값이 받아들여지는지를 결정하는 두 가지. 값은 먼저 JSON으로 파싱되고 실패하면 원시 문자열로 처리하므로 URL은 `'"https://…"'`처럼 적습니다. 객체, 배열, 불리언, 숫자는 올바른 JSON이어야 합니다. 그리고 `hub`와 `remoteGui`는 strict 스키마라서 오타 난 키는 쓰는 시점에 `schema_invalid: hub.<field>`로 거부됩니다. 효과 없는 설정으로 남지 않습니다. `managementPublicOrigin`과 `dataPublicOrigin`은 경로·쿼리·프래그먼트가 없는 순수 Origin이어야 합니다.

### 데이터 플레인 토큰은 스스로 준비됩니다

`ocx service install` 앞에 `export OPENCODEX_API_AUTH_TOKEN=…` 단계는 없습니다. 루프백이 아닌 바인드에서 설치 과정이 다음 우선순위로 데이터 admission 토큰을 결정하고, 결과를 owner-only `service-api-token` 파일(모드 `0600`)에 기록합니다.

1. **`OPENCODEX_API_AUTH_TOKEN`** — 설치하는 셸이 내보낸 값이 있을 때. 값을 직접 관리하고 싶은 운영자는 계속 직접 관리할 수 있습니다.
2. **기존 `service-api-token` 파일.** 이 재사용이 `ocx service install`, `ocx service repair`, 재시작을 멱등하게 만듭니다. 새로 만들면 이미 교환된 클라이언트 키가 모두 조용히 무효가 됩니다. 재사용하는 파일도 그냥 믿지 않고 다시 검사합니다. 아래 관리자 토큰 단락을 보세요.
3. **무작위 32바이트(hex) 새 값.** 손으로 하던 단계를 없애는 분기입니다.

명령은 **경로**만 출력하고 값은 절대 출력하지 않습니다. launchd plist와 systemd user unit은 프로세스가 시작할 때 그 보호된 파일을 읽으며, 토큰 문자열이 정의 파일에 들어가지 않습니다. 값을 `ocx config show`, unit/plist 출력, 스크린샷, 지원 번들에 붙여 넣지 마세요. 포그라운드 `ocx start`도 같은 파일을 읽으므로, 토큰을 내보내지 않아도 루프백이 아닌 hostname에 바인드합니다.

**관리자 토큰**은 어디에서 발견되든 거부하며, 그 자리에 맞는 해결책을 알려 줍니다. `OPENCODEX_API_AUTH_TOKEN`에 있으면 `unset OPENCODEX_API_AUTH_TOKEN` 후 다시 실행하세요. 재사용하는 `service-api-token` 파일에 있으면(원래 사고의 형태이고, 과거에 관리자 토큰을 그 파일에 손으로 붙여 넣은 컴퓨터에서는 여전히 나타날 수 있습니다) 파일을 삭제하고 `ocx service repair`를 실행하세요. 변수를 unset하는 것은 파일에 대해 아무 의미가 없습니다. 두 검사는 루프백 단축 경로보다 앞에서 실행되므로 루프백 설치도 검사합니다. 실행 래퍼는 hostname과 무관하게 그 파일을 `OPENCODEX_API_AUTH_TOKEN`으로 읽어 들이고, 그것이 부팅 시 관리 API를 닫아 버리는 원인입니다.

두 평면은 서로 다른 자격 증명입니다. 데이터 토큰은 `/v1/*` 호출자를 허용할 뿐 관리 권한이 없습니다. 서비스가 토큰을 직접 준비하므로 어느 쪽도 내보낼 이유가 없습니다. 파일이 한 번 만들어진 뒤에는 `ocx service repair`가 환경 변수를 다시 요구하지 않습니다.

`ocx status`는 값 없이 상태만 보고합니다: `present (file)`, `unsafe (file)`(파일은 있지만 owner-only가 아님 — 권한을 고치세요), `admin-collision (file)`(사고의 형태이며, 블록이 결과와 해결책을 함께 출력합니다), `missing`. 상태는 항상 **파일**에 관한 것입니다. 실행 래퍼가 exec 전에 파일로 환경 변수를 덮어쓰기 때문입니다. 현재 셸에 `OPENCODEX_API_AUTH_TOKEN`이 설정되어 있는지는 별도 하위 줄로 보고합니다. 그 값은 같은 셸에서 포그라운드 `ocx start`가 쓰게 되는 값이기 때문입니다.

### 한 포트, 그리고 포트를 지정하는 대안

`port` 없이 쓰는 `unauthenticatedLoopbackListener: {"enabled": true}`가 *companion* 형태입니다. 공개 리스너가 tailnet 주소에서 쓰는 것과 **같은 포트 번호**로 `127.0.0.1`에 소켓을 하나 더 엽니다. 로컬 통합이 이미 기록하는 주소가 바로 그것이라서, 허브에 새 포트를 가르칠 필요가 없고 원격에 열리는 데이터 표면은 포트 하나로 유지됩니다.

companion 형태는 `hostname`이 루프백도 와일드카드도 아닌 구체 주소일 때만 허용됩니다. `127.0.0.1`, `localhost`, `0.0.0.0`, `::`에서는 공개 리스너가 이미 그 루프백 주소를 쓰고 있으므로, opencodex가 두 번째 바인드를 실패하게 두지 않고 쓰는 시점과 시작 시점에 충돌을 지목하며 거부합니다. 그런 바인드에서는 리스너 자체가 필요 없습니다. 루프백 바인드는 이미 로컬 호출자를 허용합니다.

두 표면을 서로 다른 포트에 두고 싶다면 기존 *포트 지정* 형태도 그대로 동작합니다.

```bash
ocx config set unauthenticatedLoopbackListener '{"enabled":true,"port":10104}'
```

`port`를 지정하면 로컬 통합이 리스너를 따라 `http://127.0.0.1:10104`를 기록합니다. 이 포트는 프록시 포트와 달라야 하고 OS가 자동 할당하지 않습니다. 임시 포트는 재시작 때마다 바뀌는데 이미 실행 중인 app-server는 예전 `base_url`을 들고 있기 때문입니다.

**이 필드를 바꾸면 프록시를 재시작하세요.** 소켓은 시작할 때 한 번 바인드되고 로컬 클라이언트 파일도 그때 결정된 값으로 기록되므로, 실행 중인 허브는 예전 답을 유지합니다. 포트 지정 허브에서는 이것이 `ocx claude`가 리스너에 닿는지 `404`를 받는지의 차이입니다. 백그라운드 서비스라면 명령은 항상 재시작하는 `ocx service restart`입니다. [macOS 서비스 운영](#macos-서비스-운영)을 보세요. `ocx restart`는 다른 명령입니다. 직접 띄운 프록시 프로세스를 재시작하며, 서비스 관리자가 감독하는 서비스를 다루지 않습니다.

### 허브 자신의 로컬 클라이언트

예전에는 허브가 자기 자신을 쓸 수 없는 유일한 컴퓨터였습니다. `ocx claude`, Claude Desktop, Cursor, `system-env` 주입, 라우팅 vision 헬퍼는 모두 `http://127.0.0.1:<port>`를 호출하는데, 리스너가 tailnet 주소에 바인드되어 있으면 그 주소는 존재하지 않습니다. 루프백 리스너를 켜면 허브에서도 동작합니다.

```bash
ocx sync          # 이제 허브가 자기 Codex/Grok 블록을 기록합니다
ocx claude        # 허브 자신의 루프백 주소로 연결된 Claude Code
```

이 리스너는 추론 경로만 제공합니다: `POST /v1/responses`와 그 WebSocket 업그레이드, `POST /v1/responses/compact`, `POST /v1/messages`, `POST /v1/chat/completions`, `POST /v1/alpha/search`, `GET /v1/models`, 그리고 실시간 음성 표면입니다. `POST /v1/messages/count_tokens`는 의도적으로 허용하지 않으므로 Claude Code는 로컬 토큰 추정으로 대체합니다. 실행이 깨지는 문제가 아니라 표시상의 손실입니다. `/api/*`, `/healthz`, `/readyz`, 대시보드는 이 리스너에서 모두 `404`입니다. `ocx claude`의 탐색 호출 같은 로컬 관리 읽기는 관리 자격 증명을 들고 인증된 관리 표면으로 가며, 인증 없는 소켓으로 가지 않습니다. 관리 인그레스와 이 리스너가 서로 다른 것인 이유가 그것입니다.

리스너를 **끈** 상태에서는 허브가 의도적으로 자기 클라이언트 설정을 고치지 않으며, 건너뛸 때마다 무엇이 막았는지 말해 줍니다.

```text
This machine is a hub; it does not rewrite its own Codex/Grok/Claude configs unless
unauthenticatedLoopbackListener is enabled.
```

이 문장은 `clientIntegrations` 토글이 아니라 허브 게이트를 뜻합니다. 게이트로 건너뛴 경우 `ocx ensure`는 기존 관리 Grok 블록을 제거하지 않고 그대로 두며, `ocx restore back`도 존재하지 않는 경쟁 작성자를 탓하는 대신 게이트를 보고합니다.

### 데이터 플레인 수용 검사

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

### 데이터 리스너에 TLS 붙이기

위의 Serve 매핑은 **관리** 인그레스만 공개합니다. 그 인그레스는 `/v1/*`, `/healthz`, `/readyz`를 제공하지 않으므로 그것만으로는 원격 클라이언트에게 쓸 수 있는 데이터 플레인이 생기지 않습니다. opencodex는 자체적으로 TLS를 종료하지 않습니다. 리스너는 평문 HTTP이고 HTTPS는 항상 운영자가 소유한 프런트엔드입니다.

Serve를 데이터 플레인의 프런트엔드로도 쓸 수 있습니다. macOS에서는 한 단계가 더 필요합니다. Tailscale Serve는 `127.0.0.1`로만 프록시할 수 있어서 노드 자신의 tailnet 주소에 바인드한 리스너를 목표로 지정할 수 없고, App Store 빌드의 macOS 클라이언트는 원격 목적지를 아예 거부합니다. 허브에 루프백 포워더를 두고 Serve를 그쪽으로 보내세요.

```bash
# 루프백 TCP 포워더면 무엇이든 됩니다(socat이 한 예). 허브가 쓰지 않는 포트를 고르세요.
# 루프백 companion을 켰다면 127.0.0.1:10100은 opencodex 자신의 소켓입니다.
socat TCP-LISTEN:10110,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10110
tailscale serve status   # 매핑 두 개: 443 -> 10101, 8443 -> 10110
```

**대신 Serve를 루프백 companion 리스너로 보내지 마세요.** companion은 `127.0.0.1:10100`의 실제 소켓이라 매핑은 만들어지지만, 아래 함정과 똑같이 실패합니다. companion은 루프백 admission 정책을 적용하므로 `Host` 헤더가 루프백이어야 하는데, Serve는 `Host: hub-name.tailnet-name.ts.net`을 전달합니다. companion은 자기 `Host`가 루프백인 *허브 위의* 프로세스를 위한 것이고, TLS 프런트엔드가 필요한 자격 증명 admission과 `Host` 처리를 갖춘 쪽은 tailnet에 바인드된 리스너입니다. 포워더가 그 리스너를 전달합니다.

Serve가 허용하는 HTTPS 포트는 제한적입니다. 포트가 실제로 매핑되었는지 `tailscale serve status`로 확인하세요. 포워더는 허브와 같은 수명을 갖게 하세요. 백그라운드 셸 작업은 재부팅에서 사라지지만 서비스는 살아나므로, 실행 중이면서 TLS로는 닿지 않는 허브가 남습니다. `ocx service install`과 함께 launchd나 systemd로 띄우세요.

그다음 두 Origin을 따로 지정해 연결합니다. 위치 인자 URL이 **데이터** Origin이고(`/readyz`와 `/v1/catalog`를 가져오는 곳), `--management-url`이 pairing과 키 발급에 쓰는 대시보드 Origin입니다. 두 Origin이 같은 포트일 필요는 없습니다.

```bash
# `ocx hub invite`가 코드까지 채워서 출력해 주는 바로 그 줄입니다.
echo '<pairing-code>' | ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --pairing-code-stdin
```

`--management-url`을 생략하면 `/readyz` 응답이 보고하는 `hub.managementPublicOrigin`을 씁니다. 두 Origin이 다르면 명시하는 편이 분명합니다. 두 Origin을 허브에 `hub.dataPublicOrigin`과 `hub.managementPublicOrigin`으로 기록해 두면 `ocx hub invite`가 대신 출력해 줍니다.

**데이터 리스너를 `127.0.0.1`에 바인드해서 우회하지 마세요.** 루프백 바인드는 opencodex가 "순수 로컬 배포"를 인식하는 방법입니다. 데이터 자격 증명을 요구하지 않게 되고, 대신 요청의 `Host` 헤더도 루프백이어야 합니다. TLS 프런트엔드는 `Host: hub-name.tailnet-name.ts.net`을 전달하므로 `/v1/catalog`는 `403 origin_rejected`를 돌려주는데, 그 검사를 하지 않는 `/readyz`는 여전히 `200`입니다. 배포는 건강해 보이고 모델은 서비스하지 못합니다. 요청 경로에서 `X-Forwarded-Host`를 읽는 곳이 없으므로 프런트엔드가 고칠 수도 없습니다. 리스너는 tailnet 주소에 두세요. 그쪽은 자격 증명 admission이 켜져 있고 `Host` 검사가 적용되지 않습니다.

이 함정은 **바인드**에 관한 것이고 지금도 유효합니다. 허브 자신의 프로세스에게 `127.0.0.1` 소켓을 주는 것은 별개의 문제이고, [`unauthenticatedLoopbackListener`](#한-포트-그리고-포트를-지정하는-대안)가 그 문제에 대한 공식 답입니다. 공개 바인드는 admission을 켠 채 tailnet 주소에 남고, 두 번째 소켓이 로컬 호출자를 받습니다. 위에서 말한 이유로 그것은 TLS 목적지가 아닙니다.

`0.0.0.0` 바인드도 동작하고 포워더가 필요 없어집니다. 리스너가 루프백에서도 닿기 때문입니다. 다만 모든 인터페이스에 데이터 포트를 공개하므로 다른 네트워크를 신경 쓰지 않아도 되는 호스트에서만 선택하세요. 와일드카드 바인드에서는 공개 리스너가 이미 `127.0.0.1:<port>`를 쓰고 있어서 companion 형태가 거부된다는 점도 함께 기억하세요.

Serve가 올라온 뒤 HTTPS 데이터 Origin으로 수용 검사를 다시 실행하세요: `/readyz`, 인증된 `GET /v1/catalog`, 실제 모델 요청 1회.

## 다른 컴퓨터 초대하기

`ocx connect` 줄을 손으로 쓰는 대신 허브에서 이것을 실행하세요.

```bash
ocx hub invite
```

일회용 단기 pairing 코드를 발급하고, 다른 컴퓨터에서 실행할 명령을 출력합니다.

```text
# Run on the other machine:
echo '<code>' | ocx connect https://hub-name.tailnet-name.ts.net:8443 --management-url https://hub-name.tailnet-name.ts.net --pairing-code-stdin
```

데이터 Origin은 `--data-url` → `hub.dataPublicOrigin` → 바인드 주소 순서로 결정됩니다. 마지막 대체는 바인드가 다른 컴퓨터가 실제로 호출할 수 있는 주소일 때만 쓸 수 있습니다. 루프백이나 와일드카드 바인드에서는 `http://localhost:<port>`가 되어 상대 컴퓨터가 자기 자신을 호출하게 되고 일회용 코드가 헛되게 소모되므로, `invite`는 대신 거부하고 `ocx config set hub.dataPublicOrigin` 줄(그리고 이번 초대에만 적용하는 `--data-url` 형태)을 출력합니다. 명시한 `--data-url`이나 `hub.dataPublicOrigin`은 되묻지 않습니다. SSH 터널에서는 루프백 데이터 Origin이 정당합니다.

관리 Origin은 `hub.managementPublicOrigin`이며, `invite`에서 `--management-url`은 **덮어쓰기가 아니라 확인**입니다. grant는 설정된 Origin에 묶이고 교환 시 그 값과 비교하므로, 다른 값을 주면 허브가 거부할 코드를 출력하는 대신 두 Origin을 모두 지목하며 거부합니다.

초대가 성공할 때마다 **묶인 브라우저 Origin**도 stderr에 출력합니다. grant는 Origin 하나에 묶이고 원격 `ocx connect`는 `Origin: http://localhost:<자기 설정 포트>`를 보내므로, 묶인 Origin이 기본값 `http://localhost:10100`이 아니면 상대 컴퓨터가 그 포트에서 이미 실행 중이어야 합니다. 그렇지 않으면 허브가 교환을 거부하고 코드가 소모됩니다. 출력되는 안내가 어떤 포트인지 알려 주고, 대신 기본 Origin을 허용하는 방법도 제시합니다.

동작할 수 없는 상태라면 `invite`는 코드를 만들기 **전에** 거부합니다: `runtimeRole`이 `hub`가 아님, `hub.managementPublicOrigin` 없음, 루프백이 아닌 평문 관리 Origin, 잘못된 `--data-url`, 데이터 Origin이 이 컴퓨터의 루프백이 될 상황, attested 프록시가 실행 중이 아님. 전제 조건 하나는 따로 적을 만합니다.

**`corsAllowOrigins`에 참가할 컴퓨터의 로컬 브라우저 Origin이 있어야 합니다.** `ocx connect`는 grant를 교환할 때 `Origin: http://localhost:<자기 프록시 포트>`를 보내고 grant는 Origin에 묶이므로, `hub.managementPublicOrigin` 자신이나 `corsAllowOrigins`의 루프백 항목만 일치할 수 있습니다. 둘 다 없으면 `invite`는 0이 아닌 코드로 끝나고 아무것도 발급하지 않으며 정확한 명령을 알려 줍니다.

```bash
ocx config set corsAllowOrigins '["http://localhost:10100"]'
```

**참가하는** 컴퓨터의 프록시 포트를 쓰세요. 기본값은 `10100`입니다. 위의 설치 블록에 이미 들어 있습니다. 배열 전체를 설정하면 기존 배열을 교체하므로, 허브에 이미 항목이 있다면 `invite`가 출력하는 줄을 그대로 실행하세요. 그 줄에는 기존 항목과 새 Origin이 함께 들어 있습니다. 현재 값은 `ocx config get corsAllowOrigins`로 확인합니다.

`ocx hub invite --json`은 `{ code, expiresAt, dataUrl, managementUrl, command }`를 출력하며 `expiresAt`은 ISO 8601입니다. 코드는 비밀입니다. 일회용이고 수명은 5분이며 허브에서 요청 수를 제한하고, 저장하거나 로그·이슈에 붙여 넣으면 안 됩니다. `--clients codex,claude`로 출력된 명령이 어떤 클라이언트 설정을 허브로 향하게 할지 고릅니다.

`invite`는 기존 pairing 흐름에 대한 편의 명령이고 두 번째 메커니즘이 아닙니다. `ocx gui pair`가 쓰는 attested 로컬 경로를 그대로 사용하므로 관리자 토큰이 필요 없고 셸에 무엇도 내보내지 않습니다. 키 교체, 폐기, 연결 해제에 관한 내용은 이렇게 참가한 컴퓨터에도 그대로 적용됩니다.

## macOS 서비스 운영

`ocx service install`과 `ocx service repair`는 실행 중인 허브에 다시 실행해도 안전합니다. repair는 plist를 먼저 렌더링해 비교합니다. 렌더링 결과가 디스크의 바이트와 같고, 토큰 파일도 그대로이며, `launchctl print`가 그 plist에서 로드된 작업을 보고하면 repair는 `0600`을 다시 확인하고 설치 상태를 갱신한 뒤 `service is already loaded from the current plist; nothing to do.`를 출력하고 끝냅니다. launchd를 전혀 건드리지 않습니다. 이전 빌드는 정상 작업도 무조건 bootout해서 진단 명령이 장애가 되었습니다.

**항상 재시작하는 명령은 `ocx service restart`입니다.** 더 이상 `repair`의 별칭이 아닙니다. 같은 갱신을 수행하고, 그 결과 아무것도 reload되지 않았다면 — 위의 정상·무변경 경우 — 이미 로드된 작업을 `launchctl kickstart -k`로 제자리에서 재시작하고, `launchctl print`로 작업이 살아 있는지 다시 확인한 뒤 한 줄을 출력합니다.

```bash
ocx service restart
# ℹ️  service restarted (launchctl kickstart -k gui/501/com.opencodex.proxy).
```

`unauthenticatedLoopbackListener`, `hostname`, `port`를 바꾼 뒤에 실행할 명령이 이것입니다. kickstart는 eviction 구간을 만들지 않으므로, 예전의 무조건 repair와 달리 장애가 아닙니다.

서브커맨드 없는 `ocx service`는 여전히 `restart`가 아니라 `repair`를 고릅니다. "현재 상태로 맞춘다"는 멱등한 동작이고, 정상인 허브를 바운스하라는 요청이 아니기 때문입니다. `ocx service repair`는 원래 용도, 즉 더 오래된 plist에서 로드된 작업이나 로드되지 않은 작업에 쓰고, 정상 작업에서는 계속 아무것도 하지 않는다고 기대하세요.

`launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy`를 직접 실행하거나 `ocx service stop` 다음 `ocx service start`를 실행하는 방법도 여전히 동작하고, 실패 경로가 앞의 명령을 대안으로 알려 줍니다. 다만 둘 다 이제 권장 경로는 아닙니다.

Linux와 Windows에는 이 공백이 없었습니다. `ocx service restart`는 각각 `systemctl --user restart`와 예약 작업의 stop 후 start로 끝나며, 어떤 동사로 요청했든 재시작했습니다.

`ocx service status`는 네 가지 launchd 상태를 구분하고, 마지막 것이 자주 잘못 읽힙니다.

| 요약 | 뜻 |
| --- | --- |
| `installed and loaded` | 도메인이 응답하고 이 plist가 만든 명령을 실행 중입니다. 정상입니다. |
| `installed and loaded from an OLDER plist` | 작업은 실행 중이지만 더 이상 일치하지 않는 정의에서 왔습니다. `ocx service repair`가 바로 이 경우를 위한 것입니다. |
| `installed, not loaded` | 모든 도메인이 "없음"으로 답했고, 작업이 사라졌다는 증거입니다. repair가 다시 등록합니다. |
| `installed; launchd state could not be verified` | `launchctl`에 물어볼 수 없었습니다(예: `gui/<uid>` 도메인에 접근할 수 없는 컨텍스트). 허브가 죽었다는 증거가 **아닙니다**. 아무것도 repair를 권하지 않고, 물어볼 수 없던 조사 결과가 실행 중인 프록시를 죽은 것으로 표시하지도 않습니다. |

예전에는 물어볼 수 없던 경우를 "not loaded"로 보고했고, 그 때문에 운영자가 정상 서비스에 repair를 실행하고 업데이터가 서비스 포트에 경쟁 프록시를 띄웠습니다.

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

컨테이너 리스너는 `0.0.0.0`에 바인드되므로 컨테이너 자신의 루프백 주소에서도 이미 닿습니다. 와일드카드 바인드에서는 companion 형태가 거부되므로 `unauthenticatedLoopbackListener`는 여기에 해당하지 않습니다. 위의 토큰 부트스트랩이 서비스가 직접 하는 토큰 준비 단계의 컨테이너판이며, 역시 한 번만 실행합니다.

이미지는 non-root `bun` 사용자로 실행되고 루트 파일 시스템은 read-only이며 공개 포트는 `10100` 하나뿐입니다. 토큰을 `ARG`, `ENV`, `COPY`, Compose YAML, 이미지 기록, 명령행에 넣지 마세요. Docker socket, 호스트의 홈이나 Codex 홈, SSH agent, 프로바이더 키도 마운트하지 마세요. 컨테이너 안의 `127.0.0.1:10101` 관리 포트는 같은 네트워크 네임스페이스의 TLS/tailnet 프런트엔드로만 연결하고 직접 publish하지 마세요.

컨테이너 healthcheck의 `/healthz`가 통과한 뒤 `/readyz`, 인증된 `/v1/catalog`, 실제 모델 응답을 별도로 확인하세요.

`docker compose down`은 `ocx-state`와 `codex-state`를 모두 보존합니다. `docker compose down --volumes`는 두 볼륨을 모두 삭제하여 설정, OAuth 인증 정보, 사용량 기록, 데이터 키, Codex 상태와 카탈로그를 지웁니다. 업그레이드나 재시작 대신 사용하지 마세요.

## 롤백과 문제 해결

`tailscale serve reset`은 노드의 모든 매핑을 지우므로 먼저 `tailscale serve status`를 확인하세요. 서비스 롤백 때는 같은 `OPENCODEX_HOME`을 유지한 채 이전 릴리스를 `ocx service repair`로 복구합니다.

- 허브가 꺼져 있으면 `ocx disconnect`로 오프라인 복원할 수 있지만 원격 키는 삭제되지 않습니다.
- 일시적 허브 오류에서는 검증된 마지막 카탈로그를 유지합니다. 인증·스키마·크기·프로토콜 오류는 로컬 프로바이더로 대체하지 않습니다.
- `.prev` 복구가 필요하면 두 파일을 지우지 말고 임시 권한과 함께 `ocx connect rotate`를 다시 실행하세요.
- `hub-too-new` 또는 `hub-too-old`가 나오면 메시지가 가리키는 오래된 쪽을 업그레이드하세요. 불일치는 로컬 파일을 쓰기 전에 차단됩니다.
- pairing 코드를 잃었거나 소진했다면 `ocx hub invite`를 다시 실행하세요. grant는 일회용이고 반복 실패는 코드 존재 여부를 드러내지 않는 방식으로 제한됩니다.
- `ocx hub invite`가 `No loopback browser origin is admitted for pairing`이라고 하면 허브가 허용하는 루프백 브라우저 Origin이 없다는 뜻이며 아무것도 발급되지 않았습니다. 오류가 출력한 `ocx config set corsAllowOrigins` 줄을 참가할 컴퓨터의 프록시 포트로 실행하세요.
- `ocx hub invite`가 광고할 데이터 Origin이 이 컴퓨터의 루프백이 된다고 하면, 바인드가 루프백 전용이거나 와일드카드이고 `hub.dataPublicOrigin`이 설정되지 않은 상태입니다. 광고할 주소가 없고 tailnet/LAN 주소를 추측하지도 않습니다. 아무것도 발급되지 않았습니다. `hub.dataPublicOrigin`을 설정하거나 이번 초대에만 `--data-url`을 주세요.
- 참가하는 컴퓨터의 교환이 거부되고 코드가 소모되면, grant가 그 컴퓨터가 보내지 않는 Origin에 묶였던 것입니다. 초대 출력의 `Bound browser origin:` 줄을 다시 보세요. 상대 컴퓨터가 실행해야 하는 포트를 알려 주거나, 허브에서 `http://localhost:10100`을 허용하는 방법을 제시합니다.
- `ocx hub invite`가 `--management-url`을 거부하면, 허브에서 그 플래그는 `hub.managementPublicOrigin`을 덮어쓰는 것이 아니라 확인하는 것입니다. 설정을 바꾸거나 플래그를 빼세요.
- 허브에서 `ocx claude`가 native로 실행되거나 허브가 자기 클라이언트 설정을 쓰지 않으면 `unauthenticatedLoopbackListener`가 꺼져 있습니다. 건너뛴 메시지가 게이트를 지목합니다. 리스너를 켜고 프록시를 재시작하세요. 서비스 설치라면 `ocx service restart`입니다.
- 허브에서 `ocx claude`가 리스너로부터 `404`를 받으면, 리스너 경로가 생기기 전이나 포트가 바뀌기 전에 시작된 프로세스가 아직 돌고 있는 것입니다. `ocx service restart`로 재시작하세요. [macOS 서비스 운영](#macos-서비스-운영)을 보세요.
- macOS에서 `ocx service repair`가 `nothing to do`를 출력하고 프로세스가 바뀌지 않는 것은 정상입니다. 정상 작업의 repair는 의도적으로 no-op입니다. 새 프로세스가 필요했다면 `ocx service restart`를 실행하세요. 로드된 작업을 제자리에서 kickstart하고 `service restarted (launchctl kickstart -k …)`를 보고합니다. 그것이 실패할 때에만 `launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy`가 수동 대안이며, 실패 메시지가 그 명령을 알려 줍니다.
- `ocx service install`이 `OPENCODEX_API_AUTH_TOKEN`을 거부하면 그 값은 관리자 토큰입니다. `unset OPENCODEX_API_AUTH_TOKEN` 후 다시 실행하세요. 서비스가 데이터 플레인 토큰을 직접 준비합니다.
- 허브가 부팅에서 계속 죽고 `ocx status`가 `admin-collision (file)`을 보이면, `service-api-token` 파일에 관리자 토큰이 들어 있어서 허브가 관리 API를 닫은 상태입니다. 파일을 삭제하고 `ocx service repair`를 실행해 데이터 플레인 토큰을 준비하세요. 이 경우 환경 변수를 unset해도 해결되지 않습니다. 원인은 파일입니다.
- 루프백이 아닌 평문 HTTP로는 pairing을 할 수 없고, 이를 우회하는 플래그도 없습니다. 관리 Origin을 HTTPS 뒤에 두거나 루프백에서 pairing하세요. 관리자 토큰은 HTTP로 보내지 않습니다.
- `/v1/catalog`가 `403 origin_rejected`인데 `/readyz`가 `200`이면 데이터 리스너가 TLS 프런트엔드 뒤에서 루프백에 바인드되어 있습니다. [데이터 리스너에 TLS 붙이기](#데이터-리스너에-tls-붙이기)를 보세요.
- 브라우저 로그아웃/만료는 해당 원격 세션만 끊습니다. 데이터 키와는 별개입니다.
- 연결 해제 후 남은 키는 허브의 **Integrations → API Keys**에서만 폐기할 수 있습니다.
