# 001 — 라이브 계측 원시 증거

수집 2026-07-30, in-app 브라우저 + CDP `Network` 도메인.
대상: `http://localhost:10100` (서빙본 = npm 전역 `v2.7.43`, 에셋 `index-cmds12BG.js`).
계정 식별자는 GUI가 이미 마스킹한 형태(`k***1@gmail.com`)만 기록한다.

## E1 — 서빙 에셋 대조

```
DOM: ["/favicon.png","/assets/index-cmds12BG.js","/assets/index-Czw-jpTU.css"]

/Users/jun/.bun/install/global/node_modules/@bitkyc08/opencodex/gui/dist/assets:
  index-Czw-jpTU.css   106440  Jul 30 07:12
  index-cmds12BG.js   1293275  Jul 30 07:12

/Users/jun/Developer/new/700_projects/opencodex/gui/dist/assets:
  index-Cvkkoo0h.js   1352269  Jul 30 21:18
  index-bncC71Q8.css   154111  Jul 30 21:18
```

CSS 규칙 존재 여부:

```
# 서빙본
.codex-auto-switch-controls{flex:none;align-items:flex-end;gap:12px;margin-left:auto;display:flex}
.codex-auto-switch-input-wrap{align-items:center;gap:6px;display:flex}
.codex-auto-switch-controls{justify-content:space-between;align-items:flex-end;width:100%}
# → .account-pool-strategy-card 없음

# 로컬 dev dist
.codex-auto-switch-controls{flex:none;align-items:flex-end;gap:12px;margin-left:auto;display:flex}
.account-pool-strategy-card{gap:8px;margin-top:16px;padding:14px 16px;display:grid}
.codex-auto-switch-controls{justify-content:space-between;align-items:flex-end;width:100%}
```

## E2 — 리로드 시 요청 순서

```
/api/codex-auth/active
/healthz
/api/claude-code
/api/codex-auth/accounts
/api/codex-auth/active
/api/config
```

## E3 — 탭 전환별 요청 (4초 관측창)

```
goto #providers (38 requests):
/api/codex-auth/accounts, /api/codex-auth/active, /api/config, /api/oauth/providers,
/api/provider-quotas, /api/oauth/status?provider=xai, …anthropic, …kimi, …kiro,
…google-antigravity, …cursor, …github-copilot,
/api/codex-auth/accounts, /api/codex-auth/active, /api/usage?range=30d,
/api/provider-quotas, /api/selected-models,
/api/oauth/accounts?provider=anthropic, …cursor, …google-antigravity, …kimi, …xai, …kiro,
/api/providers/keys?name=alibaba-token-plan-intl, …opencode-go, …zenmux,
/api/oauth/accounts?provider=anthropic&quota=1, …cursor&quota=1,
/api/provider-quotas, /api/provider-quotas,
/api/oauth/accounts?provider=google-antigravity&quota=1, /api/provider-quotas,
/api/oauth/accounts?provider=kimi&quota=1, /api/provider-quotas,
/api/oauth/accounts?provider=xai&quota=1, /api/provider-quotas,
/api/oauth/accounts?provider=kiro&quota=1, /api/provider-quotas

goto #codex-auth (4 requests):
/api/codex-auth/active, /api/codex-auth/accounts, /api/codex-auth/active, /api/config

goto #models (7 requests):
/api/combos, /api/models, /api/provider-context-caps, /api/providers,
/api/selected-models, /api/v2, /api/shadow-call-settings

goto #codex-auth again (4 requests): 동일
```

`/api/provider-quotas` 8회 중복이 프로바이더 탭 요청 폭발의 최대 항목이다.

## E4 — 응답 상태·지연

```
click 모델:
/api/combos                200    4ms
/api/provider-context-caps 200    6ms
/api/providers             200    7ms
/api/models                200  126ms
/api/selected-models       200  127ms
/api/v2                    200    3ms
/api/shadow-call-settings  200    3ms
/healthz                   200    1ms

click Codex 인증:
/api/codex-auth/active     200    2ms
/api/codex-auth/accounts   200    4ms
/api/codex-auth/active     200    4ms
/api/config                200    6ms
```

요청은 정상적으로 나가고 정상적으로 빠르게 돌아온다.

## E5 — 콜드 리로드 → 첫 계정 행

`rows` = 마스킹 이메일 매치 수, `status` = `[role=status]` 개수,
`skel` = 스켈레톤 클래스 개수, `len` = `main` 텍스트 길이.

```
40ms   rows=0 skel=0 status=0 len=0
113ms  rows=0 skel=0 status=2 len=213
185ms  rows=0 skel=0 status=2 len=213
257ms  rows=0 skel=0 status=2 len=213
329ms  rows=0 skel=0 status=2 len=213
402ms  rows=0 skel=0 status=2 len=213
480ms  rows=7 skel=0 status=0 len=653   ← 첫 계정 행
552ms+ 이후 안정
```

`skel=0`이 전 구간 유지 — 서빙본에는 계정 스켈레톤이 표시되지 않는다.

## E6 — 사이드바 전환 시 빈 창

50ms 간격 샘플, `r`=계정행 `s`=status `p`=퍼센트 배지.

```
→providers:      firstAccountRow=23ms   23:r7/s0/p5  89:r0/s0/p0  154:r0/s0/p0 …
→codex-auth(1):  firstAccountRow=82ms   19:r0/s0/p11 82:r7/s0/p5  144:r7/s0/p5 …
→models:         firstAccountRow=22ms   22:r7/s0/p5  86:r0/s1/p0  148:r0/s1/p0 …
→codex-auth(2):  firstAccountRow=82ms   18:r0/s1/p0  82:r7/s0/p5  144:r7/s0/p5 …
```

`23ms`/`22ms`의 `r7`은 직전 화면 잔상이며, 그 다음 샘플에서 `r0`으로 떨어진다.
Codex 인증 재방문은 일관되게 **82ms**에 첫 행이 나타난다 → 약 60–80ms 빈 창.

## E7 — 강제 새로고침 (`할당량 새로고침`)

```
DOM (150ms 간격):
276:r7p5s0  438:r7p5s0  601:r7p5s0  764:r7p5s0  928:r7p5s1  1091:r7p5s1 … 2396:r7p5s1

network:
/api/codex-auth/active             200    3ms
/api/codex-auth/accounts?refresh=1 200  908ms
```

908ms 내내 계정 행이 유지된다(`r7`). 강제 경로는 `loading`으로 되돌리지 않는다는
코드 판정(`000_research.md` §2)과 일치한다.

## E8 — 빠른 연속 전환 / 취소된 요청

180ms 간격으로 프로바이더→Codex→모델→Codex→사용량→Codex 6연속 전환 후:

```
Network.loadingFailed events: 0
console warn/error: 0
최종 상태: rows=7, skeleton=0
```

취소된 요청도, 콘솔 경고도 없다. 즉 경합·취소로 데이터가 유실되는 경로는
서빙본에서 관측되지 않았다. 증상의 실체는 상태 전이와 빈 창이다.

## E9 — 30초 폴링 관측 (36초, 변화만 기록)

```
13ms rows=7 status=0 "" len=653
```

이 세션에서는 폴링 중 깜빡임이 재현되지 않았다. `000_research.md` §2의 `setLoadState("loading")`은
`accountsCount === 0`일 때만 로더를 그리므로(`CodexAccountPoolLoadStates`의
`loadState === "loading" && accountsCount === 0` 분기), 계정 행이 이미 있으면 화면이
유지된다.

따라서 폴링이 화면에 드러나는 상태는 두 가지뿐이다.

1. 콜드 마운트 후 **첫 성공 응답 도착 전** — `accounts`가 아직 빈 배열.
2. 계정 풀이 **실제로 0개**인 경우.

요청 실패나 세션 만료는 여기에 해당하지 않는다. 실패 분기는 `setAccounts`를 호출하지
않고 컴포넌트는 계정 카드를 계속 렌더하므로, 기존 행이 남은 채 에러 배너만 위에 붙는다.
A 감사 3라운드에서 릴리스본 코드로 확인된 사실이다.

이 조건부 경로는 구현 단계에서 활성화 증거를 따로 잡아야 한다
(`C-ACTIVATION-GROUNDING-01`).

## E10 — 서버 측 루프백 (비인증 3회)

```
/healthz                   200  0.000489 0.000386 0.000406
/api/config                401  0.000416 0.000484 0.000373
/api/codex-auth/accounts   401  0.000378 0.000384 0.000467
/                          200  0.000531 0.000506 0.000466
```

`/Users/jun/.opencodex/service.log` 2026-07-30분: 401 / timeout / quota / codex-auth
관련 라인 0건.
