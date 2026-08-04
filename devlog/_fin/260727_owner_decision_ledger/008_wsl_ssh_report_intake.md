# 008 — WSL/SSH 제보 접수 (미등록 항목)

접수: 2026-07-28, 오너 구두 제보 — "Windows WSL에서 SSH가 꼬이는 버그가 있다더라"
상태: **저장소에 등록된 흔적 없음**. 이슈·PR·devlog 어디에도 없다.

> **초안 전면 정정 (Mind 감사, 2026-07-28).** 아래 §정정 이전의 초안은 "SSH를
> 다루는 코드가 없다"는 잘못된 전제 위에 서 있었다. 실측으로 반증됐고, 후보
> 순위도 뒤집혔다. 이 문서는 정정본이다.

## 실측 — 등록 여부

```
gh issue list --state all --search "WSL"  → #63(CLOSED, Desktop WSL app-server)만
gh issue list --state all --search "ssh"  → #131 [Bug] GUI OAuth login has no manual
                                            redirect URL / code paste fallback (CLOSED 2026-07-15)
```

**미등록이 아니다.** #131이 바로 "원격 GUI·SSH·loopback 차단 환경에서 로그인을
끝낼 방법이 없다"는 이슈이고, 07-15에 닫혔다. 따라서 이번 제보는 둘 중 하나다:

- **#131의 회귀** — 고쳐진 경로가 다시 깨졌다
- **다른 버그** — #131이 덮지 않는 별개 증상

어느 쪽인지가 다음 행동을 완전히 가른다.

## 실측 — SSH는 이미 모델링돼 있다 (초안의 오류)

초안은 `rg 'SSH_CLIENT|SSH_TTY|SSH_CONNECTION'` 0건을 근거로 "SSH를 다루는 코드는
없다"고 썼다. **환경변수 이름이 잘못된 프로브였다.** 실제로는 세 곳에서 SSH
세션을 명시적으로 다룬다:

| 위치 | 내용 |
| --- | --- |
| `src/service.ts:1298-1321` | `ensureUserBusEnv()` — "SSH sessions frequently start without `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`". `isSystemd()`가 user-bus 프로브 실패 시 runtime dir 존재로 폴백(F9) |
| `src/oauth/index.ts:610` | "Manual fallback: when the browser cannot reach the loopback callback (**remote GUI, SSH**, blocked localhost)" — `submitManualLoginCode()` 경로 |
| `src/server/management/oauth-account-routes.ts:123` | 같은 폴백의 HTTP 표면 (`/api/oauth/login/code`) |
| `tests/windows-deploy-close-regressions.test.ts:38` | "systemd detection tolerates a no-DBUS SSH session (F9)" — 회귀 테스트 존재 |

즉 "SSH가 꼬인다"는 제보는 **빈 땅이 아니라 이미 설계된 경로 안의 회귀나 구멍**일
가능성이 높다. 조사 대상 파일이 초안과 다르다.

## 코드에 실제로 있는 WSL 경로 (조사)

| 경로 | 파일 | 하는 일 |
| --- | --- | --- |
| WSL 런타임 감지 | `src/codex/home.ts:82` `isWslRuntime` | `/proc/version`의 `microsoft\|WSL` 매칭 |
| Windows 홈 탐색 | `src/codex/home.ts:91` `listWslWindowsCodexHomes` | `/mnt/c/Users/*/.codex` 열거 |
| automount 루트 | `src/codex/home.ts` `wslAutomountRoot` | `/etc/wsl.conf`의 `[automount] root` |
| interop shim 거부 | `src/codex/shim.ts:280-316` | Windows쪽 `codex.exe`를 WSL PATH로 잡으면 shim 작성 거부 |
| systemd 안내 | `src/service.ts:1369` | WSL에서 systemd 없을 때 `wsl.conf` 안내 |
| localhost 방향성 진단 | `src/cli/doctor.ts` | WSL2 NAT에서 localhost가 단방향임을 힌트로 안내 |

## 후보 재순위 (정정 후)

| # | 후보 | 근거 | 실제 강도 |
| --- | --- | --- | --- |
| C1 | **#131 회귀** — GUI/CLI 로그인 수동 폴백이 다시 깨짐 | #131이 정확히 이 증상. **PR #491이 07-27 18:59에 `src/oauth/login-cli.ts`를 포함해 승인 0건으로 머지됨** — 제보 12시간 전 | **가장 유력**. 회귀 용의자가 시간·파일 양쪽으로 맞는다 |
| C2 | SSH 포트포워딩으로 원격 프록시 사용 | 저장소가 이 구성을 모델링하지 않음 | 중. 진짜 빈 땅이지만 제보 표현과의 연결이 약함 |
| C3 | WSL2 localhost 단방향 | `doctor.ts:845`가 힌트 제공 | **낮음**. 힌트 안에 `networkingMode=mirrored` 해법이 명시돼 있고, `hostname` 설정 레버도 문서화돼 있다(`docs-site/.../configuration.md:33`) — 발견성 문제지 기능 부재가 아님 |
| C4 | shim interop 거부 | `src/codex/shim.ts:311-314` | **낮음**. 거부 메시지가 복구 명령까지 명시한다. "꼬였다"와 가장 안 맞는다 |
| — | ~~브라우저 자동 열기 실패~~ | ~~`open-url.ts`에 폴백 없음~~ | **기각**. 호출 5곳 전부 URL을 먼저 출력하거나 GUI로 반환하고, `gui/src/components/login-url-block.tsx`가 URL 전문·복사·수동 열기를 제공한다. 실패해도 복구 경로가 있다 |

초안이 최우선으로 올렸던 "브라우저가 안 열린다"는 **이미 해결된 문제**다.
`260727_login_url_copy_parity` 계획이 이미 dev에 반영됐다(`040_outcome.md`의
커밋 6건, `login-url-block.tsx` 존재).

## 이것이 바꾸는 것

PR #491은 원장이 "보안 경계"로 분류한 PR이고(`007_delta_260728.md` §7-B), 승인
없이 머지됐으며, 하필 이번 제보의 최유력 후보 경로(`src/oauth/login-cli.ts`)를
건드렸다. **007 §7-B와 이 문서는 별개 주제가 아니라 같은 사건일 수 있다.**

## 다음 행동 (미승인)

1. 제보 원문(출처·재현 조건)을 받아 C1인지 C2인지 가른다.
2. C1이면 #491 diff를 `src/oauth/login-cli.ts` 기준으로 읽고 #131의 회귀 여부를
   재현으로 확인한다. 이슈는 새로 열지 말고 **#131 재오픈**이 맞을 수 있다.
3. C2면 새 이슈 — 저장소가 모델링하지 않은 유일한 시나리오다.

기록만 했고, 이슈 생성·재오픈·코멘트는 하지 않았다.

## 감사 이력

2026-07-28, `mind_constraint`(read-only) 1회. 이 문서 초안에서 high 4건이
반증됐다: (1) "SSH 코드 없음" 오류, (2) 후보 1 순위 역전, (3) 수정 범위 추정
근거가 이미 완료된 계획, (4) #131 미발견. 전부 반영했다.
