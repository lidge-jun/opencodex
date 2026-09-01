# 000 — 조사: 네 호스트의 현재 설치 상태

배포하기 전에 각 호스트가 **어떻게** 설치돼 있는지부터 확정한다. 복구가
"되돌린다"가 되려면 되돌릴 지점이 기록돼 있어야 하고, 네 호스트의 설치 형태가
전부 다르기 때문이다. 아래는 2026-09-02 실측이다.

## 호스트 인벤토리

| 호스트 | OS | 설치 형태 | 실측 |
| --- | --- | --- | --- |
| `macmini-cf` | macOS arm64 | **소스 체크아웃** | `~/opencodex` @ `0cc73411a` (dev), `~/.bun/bin/ocx` → `~/opencodex/bin/ocx.mjs` 심볼릭 링크, launchd `com.opencodex.proxy` PID 80761 **실행 중**, bun 1.3.14 |
| `lidge` | Linux x86_64 | **npm 글로벌** | `@bitkyc08/opencodex@2.21.0`, node/npm `/usr/bin`, bun `/usr/local/bin`, `~/.opencodex` 존재, 서비스 없음 |
| `intmb` | macOS | **미설치** | `ocx` 없음, `~/.opencodex` 없음, npm 글로벌 없음, bun 없음 |
| `desktop-c795oh4` | Windows (MINGW64) | **npm 글로벌** | `@bitkyc08/opencodex@2.32.1`, `~/AppData/Roaming/npm/ocx`, `~/.opencodex` 존재, bun 1.3.14, node v24.19.0 |

Tailscale 이름 해석: 사용자가 말한 "macbook"과 "desktop"은 SSH 별칭으로 각각
`intmb`와 `desktop-c795oh4`다. `macbook`/`desktop`은 해석되지 않는다.
`win`은 websocket 핸드셰이크에서 끊어져 쓰지 않는다.

## 복구 계약 (RESTORE-01)

각 호스트는 **자기 원래 형태로** 돌아간다. 형태를 통일하지 않는다.

| 호스트 | 복구 목표 | 검증 방법 |
| --- | --- | --- |
| `macmini-cf` | `~/opencodex`를 `0cc73411a`로, 심볼릭 링크 유지, launchd 서비스 재기동 | `git rev-parse`, `readlink`, `launchctl list` |
| `lidge` | npm 글로벌 `2.21.0` 복원 | `npm ls -g` 출력 |
| `intmb` | **완전 제거** — 설치 전 상태 | `ocx` 부재, `~/.opencodex` 부재 |
| `desktop-c795oh4` | npm 글로벌 `2.32.1` 복원 | `npm ls -g` 출력 |

`intmb`가 가장 조심스럽다. 없던 것을 설치했다가 지우는 것이므로 `~/.opencodex`
같은 부산물이 남으면 복구 실패다. 설치 전에 무엇이 없었는지 목록으로 남기고,
제거 후 그 목록이 여전히 비어 있는지 확인한다.

`macmini-cf`의 실행 중 서비스는 두 번째로 조심스럽다. 사용자의 실제 프록시가
거기서 돌고 있으므로, 테스트 때문에 내렸다면 반드시 다시 올린다.

## 배포 대상

`dev` HEAD `e40245e4c`, `package.json` 버전 `2.40.0`. 이번 배포에는 직전
사이클에서 고친 `fix(client): tell the dashboard it is a client`가 포함된다.

## 이 유닛이 하지 않는 것

- 원격 호스트의 사용자 자격증명이나 `~/.opencodex` 내부 계정 데이터 변경.
- 로컬 전체 스위트 실행(`bun run test`) — 금지돼 있다.
- `dev`/`main`/`preview` 직접 푸시 — 전부 PR 경로.

