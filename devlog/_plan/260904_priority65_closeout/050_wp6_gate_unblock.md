# wp6 — PR #3251 / #3327 게이트 해제 후 랜딩

두 PR 모두 코드는 정확하고, `enforce-target`이 GUI 스크린샷 게이트 하나 때문에
빨간 상태다. 이 work-phase는 게이트를 정직하게 푸는 것이지 코드를 고치는 것이 아니다.

## PR #3251 (@abhisheksharma2411, +194/-2, 12파일)

요청한 service tier가 실제로 granted 됐는지 로그 UI에 표시한다.

백엔드는 이미 `tierOutcome`을 GUI로 보낸다 — `src/server/request-log.ts:424`가
`RequestLogEntry`에 싣고, 타입은 `src/types/provider.ts:129-133`의
`confirmation: "confirmed" | "assumed" | "downgraded" | "unknown"` + `fastDowngradeReason`.
GUI 소비는 0건이다(`rg tierOutcome gui/src/`). 계산은 되는데 표시가 없는 공백이고,
이 PR은 순수 소비자 추가다.

저자가 `assumed`를 `confirmed`로 바꾸지 않은 것이 중요하다. 그렇게 하면 #2558을
재도입한다. 불확실성을 감추지 않고 드러내는 쪽이 맞다.

### UX 판정 (cxc-dev-uiux-design)

`UX-STATE-01` 관점에서 이 변경은 **불확실성 표현**이다. `assumed`는 로딩도 에러도
아닌 제3의 상태이고, 이것을 `confirmed`처럼 보이게 하는 것이 원래 결함이었다.
세 문자열이 서로 구분되고 각각이 무엇을 뜻하는지 툴팁에서 읽히면 계약을 만족한다.

i18n 키를 새로 만들지 않은 결정도 지지한다. 9개 로케일에 검증 불가능한 번역 8개를
지어내는 것보다, 이웃 필드가 이미 번역 없이 출력하는 기술 식별자와 같은 취급이 정직하다.

## PR #3327 (@olddonkey, +70/-10, 2파일)

`tests/provider-quota.test.ts`(+26/-10)와 `gui/tests/provider-capacity-shell.test.tsx`(+44/-0).
프로덕션 파일 0개. `gui/tests/`를 건드려서 스크린샷 게이트에 걸린 것이고, 테스트만
바꾼 PR에 UI 스크린샷을 요구하는 것은 게이트의 오탐이다.

캐시 identity 단정이 실제 계약과 일치한다: `src/providers/quota.ts:2497`의
`if (!forceRefresh && cacheFresh) return cache!.response`가 클론 없이 같은 객체를
돌려주므로 `toBe` 비교가 옳다.

### 남는 지적 하나

`expect(JSON.stringify(refreshed)).not.toContain("tier")`는 그물이 너무 넓다.
무관한 필드에 "tier" 문자열이 들어오면 오탐한다. 커밋을 하나 더 얹어
`aggregation`/`currentAccount` 경로로 좁힌다. 형제 테스트와 스타일이 같아
판정을 뒤집을 정도는 아니지만, 게이트를 여는 김에 정리한다.

## 게이트 해제 방법

`.github/workflows/enforce-pr-target.yml`에 waiver 경로가 **두 개** 있다(`:755`의
`screenshotWaivedByLabel || hasGuiOverride({ comments })`).

1. **라벨 경로** — `gui-screenshot-waived` 라벨이 존재하고, **그 라벨을 붙인 사람이
   MAINTAINERS.md에 등재**되어야 한다(`:738-743`). 등재되지 않은 사람이 붙이면
   무시하고 경고만 남긴다(`:744-747`). 라벨 provenance는 이벤트 로그의 최신
   `labeled`에서 읽는다.
2. **코멘트 경로** — `hasGuiOverride({ comments })`. 라벨보다 가벼우므로 일회성
   false positive에는 이쪽이 적절할 수 있다.

`@lidge-jun`은 MAINTAINERS.md `:10`에 Project owner로 등재되어 있으므로 두 경로 모두
유효하다.

#3327은 이 waiver가 정확히 의도된 용례다 — 테스트 전용 PR에 대한 false positive.
#3251은 실제 UI 변경이므로 waiver가 아니라 스크린샷이 옳다. 스크린샷은 사람 산출물이라
이 세션이 만들 수 없다. 따라서 #3251은 리베이스 + 게이트 상태 보고까지만 하고,
스크린샷 첨부 또는 waiver 판단은 메인테이너에게 남긴다.

## 스코프

- IN: #3327 waiver + 그물 좁히는 커밋 + 머지. #3251 리베이스 + 현재 상태 보고.
- OUT: #3251에 가짜 스크린샷을 만들어 붙이는 것. #3379의 나머지 두 항목.

## Accept criteria

- #3327이 dev의 조상이 되고, 스쿼시 커밋에 `Co-authored-by: olddonkey` 트레일러가 남는다
  (이메일은 `gh api .../pulls/3327/commits`로 구현 시점 조회 — devlog에 평문 금지).
- 좁힌 단정이 `bun test tests/provider-quota.test.ts`에서 green.
- #3251은 dev 최신 위로 리베이스되고, 남은 차단이 스크린샷 하나임이 PR에 기록된다.

## Verifier 사전 확인

| 커맨드 | exit | 변경 대상을 읽는가 |
|--------|------|--------------------|
| `bun test tests/provider-quota.test.ts` | 0 | 예 — `src/providers/quota.ts`를 import |
| `gh pr checks 3327` | 게이트 상태 | 예 — head SHA 체크 롤업 |
