# 022 — wp4 결과: `lidge`(Linux) + `intmb`(macOS 미설치)

## `lidge` — npm 글로벌

`2.21.0` → `2.39.0` 갱신 후 QA, 다시 `2.21.0`으로 복원했다.

`ocx`가 PATH에 없어서 `npm root -g`로 실제 경로를 찾아 실행했다
(`~/.local/lib/node_modules/@bitkyc08/opencodex`). PATH 부재는
설치 문제가 아니라 이 호스트의 셸 설정이고, 사용자 환경이므로 건드리지 않았다.

CLI 계약이 macOS와 동일하다: 빈 입력 exit 0, 오플래그 exit 1, 미매칭 라우트
exit 4. 프록시를 띄우지 않은 상태의 `ready --json`은
`{"ready":false,"status":"unreachable"}` — 이게 올바른 응답이다.

실제 기동도 확인했다. `OPENCODEX_HOME`을 `mktemp -d`로 잡아 사용자 설정을
건드리지 않고 `--port 10777`로 띄웠다: healthz 200(version 2.39.0),
readyz 200, 반복 200/200, `/v1/nope` 404, GUI `/` 200. `stop` 후
000(down). 임시 홈은 삭제했다.

## `intmb` — 아무것도 없는 호스트

node, npm, bun 전부 없었다. 시스템에 런타임을 설치하는 것은 되돌리기 어려운
외부 상태 변경이라 다른 길을 찾았다: `~/.nvm`에 node `22.22.3`이 이미
있었고, `npm i --prefix $(mktemp -d)`로 격리 설치했다. 전역 npm은 손대지
않았다.

### 예상하지 못한 것 — `ocx start`가 사용자 Codex 설정을 주입한다

프록시를 띄웠더니 로그에 이렇게 찍혔다:

```
Pointed Codex's built-in openai provider at the opencodex proxy (openai_base_url).
  Codex model catalog: ~/.codex/opencodex-catalog.json
WARNING: 4 Codex app-server process(es) still running ...
```

이 호스트에는 사용자의 실제 Codex가 돌고 있었다. `start`는 설계상 Codex를
프록시로 향하게 하는 것이고 `stop`이 되돌린다 — 실제로 `config.toml`의
opencodex 참조는 정지 후 0건이었다. 계약은 지켜졌다.

그런데 `stop`이 되돌리지 않는 부산물이 남았다:

```
~/.codex/.opencodex-native-main.claim.sqlite
~/.codex/.opencodex-native-main.owner.sqlite
~/.codex/opencodex-catalog.json
```

사전 목록에 없던 파일이므로 복구 대상이다. 이름을 하나씩 지정해 삭제했다 —
글롭이나 재귀 삭제는 쓰지 않았다. 삭제 후 `~/.codex`에 opencodex 흔적 0건,
`config.toml` opencodex 참조 0건.

**교훈:** 미설치 호스트에서 `ocx start`를 부르는 것은 "설치 테스트"가 아니라
"사용자 Codex 설정 변경"이다. 사전 부재 목록을 파일로 남겨두지 않았다면 이
세 파일은 그대로 남았을 것이다.

## 복구 대조

| 항목 | `lidge` 사전 → 사후 | `intmb` 사전 → 사후 |
| --- | --- | --- |
| npm 글로벌 | 2.21.0 → **2.21.0** | none → **none** |
| `ocx` PATH | none → **none** | none → **none** |
| `~/.opencodex` | 존재 → **존재** | none → **none** |
| bun | 1.3.14 → **1.3.14** | none → **none** |
| node/npm | (시스템) | none → **none** |
| 포트/임시파일 | free / none | free / none |

증거: `.codexclaw/evidence/<sid>/qa/{lidge,intmb}-*/`

