---
title: CLI 레퍼런스
description: 모든 ocx 명령어와 플래그.
---

opencodex의 CLI는 `ocx`입니다. 사용법을 보려면 `ocx help`(또는 `--help` / `-h`)를 실행하세요.

## 설정 및 라이프사이클

### `ocx init`

대화형 설정 마법사입니다. 프로바이더(프리셋 또는 사용자 지정), API 키(직접 입력 또는 `${ENV}`),
기본 모델, 프록시 포트를 입력받아 `~/.opencodex/config.json`을 저장하고, 선택적으로 프록시를
`$CODEX_HOME/config.toml`(기본값 `~/.codex/config.toml`)에 주입합니다.

### `ocx start [--port <port>]`

프록시 서버를 시작합니다(기본 포트 `10100`). PID 파일을 기록하며 두 번째 인스턴스 실행을 거부합니다.
시작 시 각 프로바이더의 모델을 Codex의 카탈로그에 동기화합니다. 종료 시에는 네이티브 Codex를
복원합니다 — 단, 관리형 서비스로 실행된 경우(`OCX_SERVICE=1`)는 예외입니다.

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

실행 중인 프록시를 (PID로) 중지하고, PID 파일을 제거한 뒤 네이티브 Codex를 복원합니다. 관리형
백그라운드 서비스가 설치되어 있다면, `ocx stop`이 먼저 서비스를 중지하여 프록시가 재생성되지
않도록 합니다. 동일한 동작은 웹 대시보드의 **Stop** 버튼(`POST /api/stop`)에서도 사용 가능합니다.

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

프록시를 중지하지 **않고** 네이티브 Codex를 복원합니다 — 주입된 설정 줄과 라우팅된 카탈로그
항목을 제거하여 일반 `codex`가 다시 네이티브로 동작하도록 합니다. `eject`는 `restore`의 별칭입니다.

### `ocx status`

읽기 전용 진단 요약을 출력합니다: 프록시 PID, `/healthz` 연결 상태, 대시보드 URL,
설정 파일 경로, 기본 프로바이더, Codex 자동 시작 설정, 서비스 상태, shim 상태.

## 모델 및 Codex

### `ocx sync`

설정된 모든 프로바이더로부터 실시간 모델 목록을 가져와 병합된 카탈로그를 Codex에 다시 주입합니다.
프로바이더를 추가한 후, 또는 사용 가능한 모델을 새로 고치려 할 때 실행하세요.

## 인증

### `ocx login <provider>`

프로바이더의 OAuth 로그인 플로우를 실행하고 자격 증명을 `~/.opencodex/auth.json`에 저장합니다
(자동 갱신됨). 지원: `xai`, `anthropic`, `kimi`.

```bash
ocx login xai
```

### `ocx logout <provider>`

프로바이더에 저장된 OAuth 자격 증명을 제거합니다.

## 대시보드

### `ocx gui`

`http://localhost:<port>`에서 [웹 대시보드](/opencodex/ko/guides/web-dashboard/)를 엽니다. 프록시가
실행 중이 아니면 자동으로 시작합니다.

## 백그라운드 서비스

### `ocx service <subcommand>`

opencodex를 로그인 시 관리되는 백그라운드 서비스(macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**)로 실행합니다. 로그인 시 자동으로 시작되고 크래시 시 자동으로 재시작됩니다. 서비스 실행은
`OCX_SERVICE=1`을 설정하므로 재시작이 Codex 설정을 변경하지 않습니다.

| Subcommand | Action |
| --- | --- |
| `install` | 서비스를 생성하고 시작합니다. |
| `start` | 설치된 서비스를 시작합니다. |
| `stop` | 서비스를 중지하고 네이티브 Codex를 복원합니다. |
| `status` | 서비스 실행 여부를 보고합니다. |
| `uninstall` | 서비스를 제거하고 네이티브 Codex를 복원합니다. (별칭: `remove`) |

```bash
ocx service install
ocx service status
ocx service uninstall
```

### `ocx codex-shim <subcommand>`

PATH에 있는 `codex` 바이너리를 래퍼 스크립트로 교체하여, `codex` 실행 시 opencodex 프록시가
자동으로 시작되도록 합니다. 원본 바이너리는 백업되며 제거 시 복원됩니다.

Codex가 업데이트되어 래퍼를 덮어쓰면, 다음 `install` 호출 시 자동 복구됩니다 — 새 바이너리가
백업되고 새 래퍼가 작성됩니다.

| Subcommand | Action |
| --- | --- |
| `install` | shim을 설치합니다 (stale 상태면 자동 복구). |
| `uninstall` | shim을 제거하고 원래 Codex 바이너리를 복원합니다. |
| `status` | shim 상태를 보고합니다 (설치됨 / stale / 없음). |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
항상 프록시를 켜두려면 `ocx service`를 사용하세요 (권장). 데몬 없이 가볍게 온디맨드로
쓰려면 `ocx codex-shim`을 사용하세요 — `codex` 실행 시에만 프록시가 시작됩니다.
:::

## 도움말

`ocx help`, `ocx --help`, `ocx -h` — 사용법과 예제를 출력합니다.

:::note
`ocx gui`는 동작하지만 짧은 `ocx help` 목록에서는 생략되어 있습니다.
:::
