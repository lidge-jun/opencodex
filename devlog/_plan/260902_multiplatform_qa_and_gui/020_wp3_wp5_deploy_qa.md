# 020 — wp3/wp4/wp5: 3-OS 배포와 QA

호스트마다 설치 형태가 다르므로 절차도 다르다. 형태를 통일하지 않는다는 것이
`000`의 복구 계약이고, 배포도 같은 원칙을 따른다.

## wp3 — `macmini-cf` (macOS, 소스 체크아웃, 서비스 실행 중)

가장 조심스러운 호스트다. 사용자의 실제 프록시가 launchd로 돌고 있다.

1. 현재 상태 기록: `git -C ~/opencodex rev-parse HEAD`(0cc73411a),
   `readlink ~/.bun/bin/ocx`, `launchctl list | grep opencodex`.
2. `git fetch && git checkout dev && git pull` → `bun install`.
3. QA: `ocx status`, `ocx ready --json`, `/healthz`, `/readyz`.
4. **복구**: `git checkout 0cc73411a`, `bun install`, 서비스 재기동 확인.

서비스를 내려야 한다면 반드시 다시 올린다. 내린 채로 끝나면 복구 실패다.

## wp4 — `lidge`(Linux, npm 글로벌) + `intmb`(macOS, 미설치)

**`lidge`**: 현재 `@bitkyc08/opencodex@2.21.0`. dev 기준으로 올리고
QA 후 2.21.0으로 되돌린다. 되돌림 증거는 `npm ls -g` 출력이다.

**`intmb`**: 아무것도 없다. 설치 전에 없는 것들을 목록으로 남긴다
(`ocx`, `~/.opencodex`, npm 글로벌 엔트리, bun). 테스트 후 그 목록이
다시 비어 있어야 한다. 부산물 하나라도 남으면 복구 실패다.

## wp5 — `desktop-c795oh4` (Windows, MINGW64)

현재 `@bitkyc08/opencodex@2.32.1`. 경로가 `/c/Users/user/AppData/Roaming/npm/ocx`
라 POSIX 셸 가정이 깨질 수 있다. Windows 고유 실패(경로 구분자, 심볼릭 링크
권한, 서비스 등록)를 별도 시나리오로 본다. QA 후 2.32.1로 복원.

## QA 시나리오 (`cxc-qa` §4 적대적 클래스)

각 호스트에서 아래를 구동하고 `.codexclaw/evidence/<sid>/qa/<scenario>/`에
`invocation.txt` + 아티팩트 + `verdict.json`을 남긴다.

| 클래스 | 무엇을 하나 |
| --- | --- |
| 정상 경로 | `ocx status`, `ocx ready --json`, `/healthz`, `/readyz` |
| 빈 입력 | 인자 없는 서브커맨드 |
| 오입력 | 없는 플래그, 잘못된 서브커맨드 |
| 경계 | 없는 라우트로 `capabilities --route` (exit 4 기대) |
| 반복 | 같은 명령 두 번 — 멱등성 |
| 좁은 뷰포트 + CJK | GUI 320/736px 렌더 (호스트가 GUI를 서빙할 때) |

`NA`는 구조적으로 적용 불가할 때만 쓰고 이유를 적는다. 실행하지 못한
시나리오는 skip이 아니라 FAIL이며 블로커를 함께 적는다.

## wp6 — 스택 PR과 머지

work-phase 체인이 스택 모양이므로 PR도 스택으로 올린다. CI는 즉시 기다리지
않고 후행 추적한다. 최종적으로 admin으로 전부 머지한다.

## 제약 재확인

로컬 전체 스위트 금지. 푸시는 `--no-verify`. `dev`/`main`/`preview`
직접 푸시 금지. 원격 호스트의 사용자 자격증명과 `~/.opencodex` 내부 계정
데이터는 건드리지 않는다.

