# 083 — wp6 — #3327 / #3251 게이트 해제

커밋 `370ea4ae3`(#3327 carry)와 `081570785`(#3251 carry, 두 커밋 순서대로).

두 PR 모두 코드는 정확했고 `enforce-target`의 GUI 스크린샷 게이트 하나만 빨간색이었다.
#3327은 테스트만 바꿨는데 `gui/tests/`를 건드려 걸린 오탐이다.

#3327에서 한 군데를 좁혔다. `not.toContain("tier")`를 봉투 전체에 걸면 `serviceTier`나
`tierOutcome` 같은 무관한 필드 이름에도 걸려, plan 누출과 상관없는 변경에서 터진다.
report rows와 따옴표 키로 한정했다.

#3251은 백엔드가 `tierOutcome`을 이미 보내는데 GUI 소비가 0건이던 진짜 공백이다.
스크린샷은 실제 `gpt-5.6-luna` priority 요청을 프록시로 보내 렌더링을 확인한 뒤 찍었다:
`response tier=default (assumed)`. `assumed`를 `confirmed`로 올리지 않은 저자 판단이
옳다 — 그렇게 하면 #2558을 재도입한다.
