# 260726 — 쿨다운/라우팅 락아웃 하드닝 (조사 · 근거 · 범위)

조사 문서. 구현 계약은 `010_cooldown_escape.md`에 있다 (LEXICO-SPLIT-01).

## 계기

Threads 사용자 제보(macOS 27 beta 1, Plus, 서드파티 프로바이더 연결): Codex 앱이 전부
먹통이고 Chat만 정상. 429를 봤고, 앱 캐시 삭제와 재설치로도 복구되지 않았다. 결국
`~/.codex/config.toml`의 주입된 `openai_base_url`을 주석 처리하니 즉시 복구됐다.

## 구조적 원인 (코드 확인)

주입 한 줄이 앱/CLI/SDK 전체의 유일한 모델 경로가 된다. Chat 탭만 이 설정을 읽지 않아
살아남는다. 그래서 "앱 전체 먹통 + Chat만 정상"은 프록시 경로 장애의 지문이다.

두 갈래가 이 지문을 만든다.

**A. 프록시 부재** — `src/codex/autostart-health.ts:69`에서 `shimCoverage`가 구조적으로
`cli-only`로 고정된다. shim은 Desktop/app-server를 절대 커버하지 않는다. launchd 서비스
없이 주입만 된 사용자는 재부팅 후 연결 거부만 받는다.

**B. 로컬 429 쿨다운 핀** — `src/server/responses/core.ts:476`이 업스트림에 가지 않고
`429 rate_limit_error "Selected Codex account is cooling down"`을 자체 반환한다.
#433은 이 중 "먼 미래 resetAt이 24h 상한까지 핀" 부분만 고쳤다(`5b97c993`, v2.7.40).

## #433 이후 남은 갭 (이번 유닛의 대상)

#433 유닛 `000_plan.md:47`이 명시적으로 범위 밖으로 남긴 항목이 그대로 갭이다.

**G1 — 탈출구 부재.** `clearCodexUpstreamHealthForAccount`의 유일한 호출자는
`src/codex/account-lifecycle.ts:17`(계정 삭제/주 계정 교체)뿐이다. 사용자가 쿨다운을
직접 풀 수 있는 CLI/관리 API 표면이 없다. `src/cli/account.ts:18` USAGE에도 없다.
API 키 풀은 `oauth-account-routes.ts:240`에서 `clearKeyCooldowns`를 쓰는데, Codex 계정
쿨다운에는 대응물이 없다. 재시작이 유일한 탈출구라는 #433의 증상이 부분적으로 남아 있다.

**G2 — retry-after 소스는 probe 대상이 아님.** `routing.ts:256`이
`cooldownSource === "retry-after"`를 probe에서 제외한다. 이는 의도된 설계(리터럴 존중)지만,
상위가 긴 Retry-After를 주면 G1이 없는 한 탈출구가 전혀 없다. 이 둘의 조합이 실제
락아웃을 만든다.

**G3 — 429 본문이 원인을 말하지 않음.** 반환 문자열은 "Selected Codex account is cooling
down"뿐이다. 어느 계정인지, 언제 풀리는지, 무엇을 하면 되는지가 없다. 사용자가
`config.toml`을 직접 뒤져 주석 처리하는 결말은 이 침묵의 직접 결과다.
`Retry-After` 헤더도 붙지 않는다(`claude-messages.ts:374`는 붙이는데 이 경로는 아니다).

**G4 — Desktop 커버리지 없이 주입 허용.** `src/cli/init.ts:180`이 주입을 먼저 하고
`:185`에서 shim 설치를 묻는다. shim은 Desktop을 커버하지 못하는데도, launchd 서비스
설치 여부와 무관하게 주입이 진행된다. `startupHealthSummary`는 사후 진단일 뿐 주입
시점의 게이트가 아니다.

## 확정된 사실 (증거)

- `v2.7.40` = `5b97c993` 포함 태그, 릴리스 2026-07-25 23:15 +0900. 제보 시점 기준
  대다수 사용자는 2.7.39 이하다.
- 쿨다운 진단은 이미 존재한다: `src/cli/doctor.ts:95`, `src/cli/status-oauth.ts:16`,
  GUI `oauth-health-display.ts`. 즉 **보는 것은 되는데 푸는 것이 안 된다.**
- `getCodexAccountHealthSnapshot`(`routing.ts:313`)이 읽기 전용 스냅샷을 이미 제공하므로
  G3의 본문 강화는 새 상태 저장 없이 가능하다.

## 범위 밖

- Design B 주입 방식 자체의 변경. 회귀 위험이 크고 이번 증상의 원인이 아니다.
- `api.openai.com` 자동 폴백. 프로바이더·과금·프라이버시 기대를 바꾸므로 기본값이 될 수 없다.
- WebSocket 426(#324) 경로. 의도된 HTTP 폴백 유도이며 전면 먹통과 무관하다.
- macOS 27 beta / 앱 캐시 / 대화기록 소실. OS·바이너리 변경 없이 TOML 한 줄로 복구된
  사실이 이들을 배제한다.
