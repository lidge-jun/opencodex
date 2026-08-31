---
title: CLI 수명 주기
description: 설정, 시작, 중지, 서비스, 진단, 동기화, 업데이트 명령입니다.
---

이 명령들은 로컬 opencodex 프록시와 Codex 연동을 설치, 실행, 점검, 복구, 업데이트합니다.

## 설정

### `ocx init` · `ocx setup`

대화형 설정 마법사입니다 (`setup`은 `init`의 별칭입니다). 공급자(프리셋 또는 사용자 지정),
API 키(리터럴 또는 `${ENV}`), 기본 모델, 프록시 포트를 묻고 `~/.opencodex/config.json`에 저장합니다.
원하면 프록시를 `$CODEX_HOME/config.toml`(기본값 `~/.codex/config.toml`)에 주입하고,
Codex 자동 시작 shim도 설치합니다.

## 프록시 수명 주기

### `ocx start [--port <port>]`

프록시 서버를 시작합니다(권장 포트는 `10100`). 해당 포트가 이미 사용 중이면 opencodex가 다른
사용 가능한 포트를 골라 기록합니다. PID와 런타임 포트 상태를 기록하고, 두 번째 활성 인스턴스는 시작하지
않습니다. 시작할 때는 각 공급자의 모델을 Codex 카탈로그로 동기화합니다. 종료할 때는 기본 Codex를
복원합니다. 단, 관리형 서비스로 실행한 경우(`OCX_SERVICE=1`)는 예외입니다.

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

실행 중인 프록시를 PID 기준으로 중지하고, PID 파일을 삭제한 뒤 기본 Codex를 복원합니다. 관리형
백그라운드 서비스가 설치되어 있으면 `ocx stop`이 먼저 그 서비스를 중지하므로 프록시가 다시
올라올 수 없습니다. 웹 대시보드의 **Stop** 버튼도 같은 동작(`POST /api/stop`)을 하지만, Windows 작업 스케줄러는 예외입니다. 작업이 끝나도 래퍼가 프록시를 다시 띄울 수 있어서, 대시보드는 `respawnable_service`로 거절하고 아무것도 바꾸지 않은 채 `ocx stop` 실행을 안내합니다.

### `ocx restart`

프록시가 실행 중이면 확인된 정확한 PID와 포트에 in-place 재시작을 요청하고, 정상 드레인을
기다린 뒤 같은 포트에 다른 런타임 PID가 올라왔는지 확인합니다. 이 과정에서 관리형 라우팅과
서비스 감시는 유지되며, 요청 결과가 불확실해도 별도의 stop/start로 재실행하지 않습니다.
실행 중인 프록시가 없을 때만 일반 `ensure` 시작 동작으로 전환합니다.
실행 중인 리스너를 런타임 PID로 증명할 수 없으면(업데이트 전 프록시 포함) `ensure`나
stop/start 대체 동작 없이 안전하게 실패합니다. 소유권을 확인한 뒤 `ocx stop`과 `ocx start`를
순서대로 한 번 실행하세요.

### `ocx ensure`

백그라운드 프록시가 실행 중인지 멱등적으로 보장한 다음, 살아 있는 모델 카탈로그를 동기화합니다.
`codexAutoStart`가 `false`이면 자동 시작이 비활성화되었다고 출력하고 아무것도 하지 않습니다.

### `ocx restore [back]` · `ocx eject [back]`

프록시를 중지하지 않고 기본 Codex를 **복원**합니다. 주입된 설정 줄과 라우팅된 카탈로그 항목을
제거하므로 일반 `codex`가 다시 네이티브로 동작합니다. `eject`는 `restore`의 별칭입니다.

둘 중 어느 표기든 `back`을 붙이면 이미 실행 중인 프록시를 가리키도록 일반 `codex`를 다시
연결하되, 프록시 수명 주기는 바꾸지 않습니다.

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai --yes`

역방향 복구 지원이 생기기 전, 초기 개발 빌드에서 Codex App 기록을 재매핑하던 오래된 빌드를 위한
명시적 복구 명령입니다. 기록 데이터베이스가 잠겨 있으면 먼저 Codex를 종료해 주세요.

이 명령은 광범위하고 파괴적인 재태깅입니다. 사용자 메시지가 있고 현재 `opencodex`로 표시된 모든
thread를 `openai`로 바꾸고, `exec`를 `cli`로 정규화하며 event marker를 설정합니다. 정상적인
dedicated-provider history도 포함됩니다. 상태를 백업하고 이 전체 범위를 의도한 경우에만 실행하세요.

### `ocx uninstall` · `ocx remove`

서비스와 프록시를 중지하고, 서비스와 Codex shim을 제거한 뒤, 기본 Codex를 복원합니다. 그 다음
복원 단계가 모두 성공했을 때만 opencodex 로컬 설정을 제거합니다. `remove`는 `uninstall`의
별칭입니다. 설정 정리에는 새 설치로 만들어진 소유권 메타데이터가 필요하며, 오래된 디렉터리나
공유 디렉터리는 그대로 남깁니다.

## 상태 및 헬스

### `ocx status [--json]`

읽기 전용 진단 요약을 출력합니다. 프록시 PID, `/healthz` 도달 가능 여부, 대시보드 URL,
설정 경로, 기본 공급자, Codex 자동 시작 설정, 서비스 상태, shim 상태, 그리고 마스킹된
실제로 적용되는 Codex 홈이 포함됩니다. 명시적이고 높은 신뢰도의 Windows Orca 런타임 홈 시그니처만
실행 가능한 App 홈 불일치 경고를 추가하며, `CODEX_HOME`을 자동으로 바꾸지는 않습니다.

일반 출력에는 OAuth 로그인 요약 뒤에 **OAuth health** 블록도 표시합니다. 모든 알려진 계정이
정상이면 `OAuth health: ok`를, 그렇지 않으면 `OAuth health: warning`과 함께 건강하지 않은
각 계정마다 한 줄씩(공급자, 마스킹된 계정 ID, 재인증 필요, 속도 또는 할당량 제한, 갱신
충돌 같은 상태), 그리고 선택적인 `Action:` 힌트를 보여줍니다. 계정 ID는 마스킹되며 토큰과
이메일은 절대 출력하지 않습니다. `--json` 계약에는 이 헬스 블록이 아직 포함되지 않습니다.

```bash
ocx status
ocx status --json
```

축약 예시 형태는 다음과 같습니다.

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

실제 객체에는 `listen`(포트, 호스트명, 런타임/설정 소스), 설정 로드 진단, 번들 Codex 플러그인
진단도 포함됩니다. JSON 스키마는 추가만 허용합니다. 앞으로 버전에서 필드가 추가될 수는 있지만,
기존 필드는 안정적으로 유지되어야 합니다. 이 스키마는 API 키, OAuth 토큰, Authorization 헤더,
요청 내용, 이메일, 계정 식별자를 의도적으로 제외합니다.

### `ocx health [--json]`

실행 중인 프록시의 신원 확인을 수행합니다. 일반 출력은 PID/포트를 보고하고, `--json`은
`{ok, pid, port}`를 내보냅니다. 이 명령은 정상일 때만 종료 코드 0을, 그렇지 않으면 1을 반환하므로
서비스 프로브에 적합합니다.

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

인증이 필요 없는 `GET /readyz` 엔드포인트로 동기화 후 준비 상태를 확인합니다. 준비되면 `200`,
`pending` 또는 종단 상태인 `failed`이면 `Retry-After: 1`과 함께 `503`을 반환합니다. HTTP의 정제된
식별 필드는 `{service, version, uptime, pid, port, status}`입니다. `/readyz`가 없는 이전 프록시는
`unreachable`로 fail-closed하며, `/healthz`는 준비 상태가 아닌 별도의 liveness 확인입니다. 기본값은 한 번의
probe이며, `--wait`는 준비 또는 timeout까지 polling하지만 종단 `failed`를 확인하면 즉시 종료합니다.
기본 timeout은 45초이며, `--timeout <seconds>`는 `--wait`와 함께 써야 하고 양의 정수인 1~300초 범위를 받습니다. CLI JSON은
`{ready, status, pid, port}`를 출력하며 `status`는 `ready`, `pending`, `failed`,
`unreachable` 중 하나입니다. 종료 코드는 ready가 0, not-ready/pending/failed/timeout/unreachable이
1, 잘못된 인수가 64입니다.

### `ocx doctor`

읽기 전용 환경 및 연결 진단을 실행합니다. 상태 경로와 파일시스템 유형, WSL 이중 설치, 프록시
환경/설정, ChatGPT 도달 가능성, Codex 플러그인 및 프로젝트 설정 경고, 보류 중인 기록 마이그레이션이
포함됩니다. Codex 앱 홈 대상 지정 섹션은 좁은 범위의 Windows Orca 런타임 홈 불일치도 감지하고,
해당할 때 서비스 마이그레이션을 설명합니다. 이 진단에 표시되는 경로는 OS 사용자 이름을 마스킹합니다.
doctor는 복구 힌트를 보여 주지만 직접 적용하지는 않습니다.

**OAuth 안정성** 섹션은 자격 증명 저장소에 쓰기 가능한지, `OPENCODEX_HOME` 아래에 refresh
single-flight/lock 파일을 만들 수 있는지, 건강하지 않은 OAuth 또는 Codex pool 계정(마스킹된 ID)과
복구용 `Action:`, 그리고 Codex 전달 경로가 공식 클라이언트 메타데이터를 꾸며 내지 않는다는
정적 OK를 보고합니다. doctor는 자격 증명을 변경하거나 복구를 적용하지 않습니다.

## 카탈로그 동기화

### `ocx sync [--restart-codex]`

설정된 모든 공급자에서 라이브 모델 목록을 가져와 병합된 카탈로그를 Codex에 다시 주입합니다.
공급자를 추가한 뒤나 사용 가능한 모델을 새로 고칠 때 실행합니다.

오래 실행 중인 Codex `app-server` 프로세스가 아직 살아 있으면, `opencodex-catalog.json` /
`models_cache.json`가 업데이트되었더라도 이전 인메모리 모델 목록을 계속 서비스할 수 있다고 경고합니다.
`--restart-codex`를 붙이면 현재 사용자가 소유한 `codex … app-server`와 `codex-code-mode-host`
프로세스 중 일치하는 것에만 `SIGTERM`을 보냅니다(활성 작업이 중단될 수 있습니다). 광범위한
`pkill -f codex` 매칭은 의도적으로 피합니다.

### `ocx sync-cache [--restart-codex]`

Codex의 로컬 모델 선택기 캐시를 무효화하여, 활성 opencodex 카탈로그에서 다시 빌드되게 합니다.
`ocx sync`와 같은 오래된 `app-server` 경고와 선택적 `--restart-codex` 동작이 적용됩니다.

## 백그라운드 서비스

### `ocx service [install|repair|restart|start|stop|status|uninstall|remove]`

로그인 관리형 백그라운드 서비스로 opencodex를 실행합니다(macOS **launchd**, Linux **systemd** 사용자
유닛, Windows **Task Scheduler**). 로그인 시 자동 시작하고 충돌 시 자동 재시작합니다. 서비스 실행은
`OCX_SERVICE=1`을 설정하므로 재시작해도 Codex 설정이 흔들리지 않습니다.

| 하위 명령 | 동작 |
| --- | --- |
| 없음 | 서비스가 없으면 설치하고 시작하며, 이미 있으면 새로 고쳐 재시작합니다. 정상인 Windows 작업 스케줄러 정의는 재사용하지만, 오래된 정의는 다시 등록되어 관리자 권한 승인이 필요할 수 있습니다. |
| `install` | 서비스를 생성하고 시작합니다. |
| `repair` | 설치된 서비스를 제자리에서 새로 고친 뒤 재시작합니다. 정상인 Windows 작업 스케줄러 정의는 재사용하지만, 오래된 정의는 다시 등록되어 관리자 권한 승인이 필요할 수 있습니다. |
| `restart` | `repair`의 별칭입니다. |
| `start` | 설치된 서비스를 시작합니다. |
| `stop` | 서비스를 중지하고 기본 Codex를 복원합니다. |
| `status` | 서비스와 프록시 진단, 로그 경로를 보고합니다. |
| `uninstall` | 서비스를 제거하고 기본 Codex를 복원합니다. |
| `remove` | `uninstall`의 별칭입니다. |

```bash
ocx service
ocx service install
ocx service repair
ocx service restart
ocx service status
ocx service uninstall
```

Windows에서는 bare `ocx service`가 Task Scheduler와 WinSW 양쪽 모두 부재가 입증된 후에만 설치
경로를 실행합니다. 상태 조회 중 하나라도 불확실하면 아무것도 등록하지 않고 `ocx service status`
실행을 안내합니다. 부재를 확인한 뒤에만 명시적인 `ocx service install`을 사용하세요.

Windows에서는 `ocx service status`가 Task Scheduler 등록 상태를 ID가 검증된 OpenCodex 프록시
도달 가능성과 별도로 보고합니다. 로컬라이즈된 `schtasks` 표는 출력하지 않으므로, 요약은 Windows
코드 페이지에서도 읽기 쉽습니다.

Windows에서 Task Scheduler 항목을 만들려면 권한 상승이 필요합니다. 인식되는 로컬라이즈된
접근 거부 텍스트는 기존 안내 경로를 유지합니다. 그 텍스트를 읽을 수 없으면, 대체 경로는 소유된
명령 형태 `/create /tn opencodex-proxy /xml <non-empty-path> /f`, 상태 1, 그리고 상승하지
않은 토큰의 확인이 필요합니다. 그러면 대시보드의 Startup Safety 작업이 UAC를 자동으로 요청할 수
있습니다. 그 대체 경로로도 토큰 상태를 판별할 수 없으면 원래 스케줄러 오류를 유지합니다. 외부
작업이나 외부 연산은 자동 권한 상승 표시를 절대 내지 못합니다. 대시보드 UAC 프롬프트를 승인하거나
상승된 PowerShell 창에서 `ocx service install`을 다시 실행해 주세요.

### `ocx codex-shim <install|status|uninstall|remove>`

PATH 위의 스크립트 기반 `codex` 런처를 가벼운 자동 시작 스크립트로 감쌉니다. 정확한 실행 파일
호출을 깨지 않도록 실제 `codex.exe` 대상은 손대지 않습니다.

설치나 복구를 확정하기 전에 OpenCodex는 서비스 시작을 우회한 상태에서 저장된 런처를
`--version`으로 실행합니다. 런처가 `codex`를 shim으로 다시 해석해 재귀하거나, 0이 아닌 코드로
종료하거나, 5초를 초과하거나, 실행 중인 자식 프로세스를 남기거나, 안전하게 검증·정리할 수 없으면
변경을 거부하고 롤백합니다. 따라서 `codex-shim install`은 무조건 성공하는 명령이 아닙니다. 거부되면
PATH 항목이 구체적인 실행 파일 또는 런처를 가리키도록 Codex를 다시 설치한 뒤 재시도하세요. 동적
명령 관리자의 런처가 이 검증을 충족할 수 없다면 대신 `ocx service install`을 사용하세요.
업그레이드할 때 현재 검증 가드가 없는 기존 Unix shim은 다시 생성하고 검증합니다. 저장된 런처가
안전하지 않으면 OpenCodex는 위험한 wrapper를 그대로 두지 않고 구버전 shim을 제거한 뒤 원래
런처를 복원합니다.

완료된 외부 Codex 업데이트가 설치된 shim을 덮어쓰면, 다음 일반 `ocx` 명령이 안정적인 새 런처를
백업하고 명령을 처리하기 전에 shim을 복원합니다. 부작용 없는 검사 명령 `ocx system codex-cli-update check`와 예약된 `ocx system codex-cli-update` namespace의 잘못된 호출은 이 복구를 수행하지 않습니다. 아직 변경 중인 런처는 건드리지 않고 나중에 다시 시도합니다.
복구 실패는 요청한 명령을 실패시키지 않고 경고만 표시합니다. 수동 대체 수단은 `ocx codex-shim install`
입니다. `codexShimAutoRestore`를 `false`로 설정하거나, 프로세스 수준에서 제외하려면
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`을 설정합니다.

| 하위 명령 | 동작 |
| --- | --- |
| `install` | shim을 설치합니다(오래된 경우 복구도 수행합니다). |
| `uninstall` | shim을 제거하고 원래 Codex 바이너리를 복원합니다. |
| `remove` | `uninstall`의 별칭입니다. |
| `status` | shim 상태(설치됨, 오래됨, 누락)를 보고합니다. |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[서비스와 shim]
항상 켜져 있는 백그라운드 프록시에는 `ocx service`를 사용합니다(권장). 데몬 없이 가볍게 필요할
때만 시작하려면 `ocx codex-shim`을 사용합니다. 이 경우 프록시는 `codex`를 실행할 때만 시작됩니다.
:::

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Windows 상태 트레이 아이콘을 설치하고 제어합니다. Windows 로그인 시 시작되며, 프록시를 원클릭으로
제어할 수 있습니다. `start`와 `stop`은 아이콘만 제어합니다. 프록시 제어는 메뉴를 사용하세요.
`--no-start`는 `install`에 적용되며, 트레이를 바로 실행하지 않고 설치합니다.

## 대시보드

### `ocx gui`

프록시가 실행 중이 아니면 자동으로 시작하면서 [웹 대시보드](/guides/web-dashboard/)를
`http://localhost:<port>`에서 엽니다.

## 업데이트

`ocx update`는 OpenCodex 자체를 업데이트하며 Codex CLI를 업데이트하지 않습니다. [system 검사 명령](/ko/reference/cli/agents/)의 `ocx system codex-cli-update check`로 설정된 Codex CLI 후보의 provenance를 제한된 읽기 전용 방식으로 확인할 수 있습니다. 이 명령은 package registry를 조회하거나 업데이트를 설치하지 않습니다.

### `ocx update [--tag latest|preview]`

npm에서 opencodex를 자체 업데이트합니다. 안정판 설치는 `@latest`를 사용하고, 미리보기 설치는
`--tag latest|preview`를 주지 않으면 `@preview`를 유지합니다. 소스 체크아웃을 감지하면 대신
`git pull && bun install`을 실행하라고 안내하고, 해당 태그에서 이미 최신 버전이면 아무 동작도 하지
않습니다. npm 설치에서는 어떤 프로세스도 중지하기 전에 Unix 캐시의 소유권과 접근 가능성을 제한된
범위에서 검사합니다. 중첩 심볼릭 링크는 `lstat`으로 확인하되 따라가지 않으며, Windows에서는 이
Unix 전용 검사를 명시적으로 건너뜁니다. 검사에 실패하면 트레이와 프록시가 실행 중인 상태에서
업데이트를 중단합니다. 그 다음 실행 중인 프록시가 있으면 파일을 교체하기 전에 중지합니다. 설치된
서비스는 자동으로 다시 빌드해 시작하며, 포그라운드 설치에서는 다음 단계로 `ocx start`를 출력합니다.
대시보드 업데이트 기록은 저장 전에 프로필/캐시 경로와 UID/GID 값을 가립니다.

```bash
ocx update
ocx update --tag preview
```

새 버전은 [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)가
npm에 게시하면 사용할 수 있게 됩니다.
