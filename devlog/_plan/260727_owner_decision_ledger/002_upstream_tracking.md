# 002 — 업스트림 추적 상태

확인 시각: 2026-07-27, `gh issue view` 실측.

## 추적 중인 업스트림 티켓

| ocx 이슈 | 업스트림 | 업스트림 상태 | 최종 갱신 | 판단 |
| --- | --- | --- | --- | --- |
| #92 (V2 cross-provider NEW_TASK 유실) | openai/codex#32453 | OPEN | 2026-07-12 | **인용 불일치** — 발견 3 참조 |
| #417 (한국어 음성 U+FFFD) | openai/codex#35161 | **OPEN** | 2026-07-24 | 유효, 최근 활동 있음 |
| #543 (Claude Code mid-turn queue 무시) | anthropics/claude-code#1124 | **CLOSED** | closed 2025-05-16 | **인용 무효** — 아래 참조 |
| #462 (모델 제거 시 Codex 크래시) | 없음 | — | — | 업스트림 티켓 미제출 |
| #401 (voice chat 모델 변경) | 없음 | — | — | 업스트림 티켓 미제출 |
| #241 (라우팅 모델 Desktop 피커 미표시) | 없음 | — | — | 업스트림 티켓 미제출 |

실질적으로 유효한 추적은 **#417 하나뿐**이다.

## 발견 1 — #543이 인용한 업스트림 이슈는 닫혀 있다

`#543`의 메인테이너 코멘트(2026-07-27T08:26Z)는 anthropics/claude-code#1124를
"같은 native 증상의 업스트림 리포트"로 인용하며, 이를 근거로 native-vs-proxy
대조 실험을 요구했다.

실측(`gh issue view 1124 --repo anthropics/claude-code`):
**state=CLOSED, closedAt=2025-05-16T14:10:06Z.** 1년 이상 전이고, 리포터가
검증한 클라이언트(Claude Code 2.1.220)보다 한참 앞선다.

게다가 리포터는 그 대조 실험을 이미 수행해 답변했다(08:34Z): native Claude
Code 2.1.220에서 mid-turn queue가 **정상 동작**한다고. 즉 우리가 근거로 든
업스트림 티켓은 닫혔고, 우리가 요구한 대조 실험은 우리 쪽에 불리한 결과로
돌아왔다.

**오너 결정 아님 — 지원 업무.** 리포터가 "지원되는 로깅 스위치를 알려주면
`OCX_QUEUE_543` 캡처를 하겠다"고 되물었는데, 그 스위치는 이미 있다:
`src/lib/debug-settings.ts:7`의 `ocx debug claude on|off|status|reset` 및
`OCX_CLAUDE_DEBUG=1`. 한국어·중국어 문서에도 기재돼 있다. 답변만 하면 된다.

> **stale 위험 정정.** 초안은 `stale-needs-info.yml`이 돌고 있다고 가정했으나,
> 실측상 이 워크플로는 `origin/dev`에만 있고 `origin/main`(기본 브랜치)에
> **없다**. 예약 워크플로는 기본 브랜치에서만 실행되므로 **현재 동작하지
> 않는다.** 설사 돌더라도 `days-before-issue-stale: 14` +
> `remove-stale-when-updated: true`이고 #543은 07-27에 갱신됐다. 시한 압박 없음.

## 발견 2 — 업스트림 티켓 없이 upstream-tracking 라벨만 붙은 항목

`#462`, `#401`, `#241`은 `upstream-tracking` 라벨을 달고 있지만 대응하는
업스트림 이슈 링크가 본문/코멘트 어디에도 없다.

이 라벨의 정의는 "Blocked on an upstream (Codex CLI/Desktop) fix; kept open for
discoverability"다. 업스트림에 티켓이 없으면 그 fix는 영원히 오지 않는다.
추적이 아니라 보류에 가깝다.

**결정 지점**: 세 건에 대해 (a) 업스트림 이슈를 우리가 제출할 것인가,
(b) 라벨을 `wontfix`/`roadmap`으로 정직하게 바꿀 것인가, (c) 그대로 둘 것인가.

#417이 유일한 모범 사례다: openai/codex#35161이 실재하고 OPEN이며 2026-07-24에
갱신됐다.

## 발견 3 — #92의 업스트림 인용도 정확하지 않다

#92가 인용한 openai/codex#32453의 제목은 "Model switch is blocked when
previous-model compaction hits HTTP 429"다. 이건 스레드 중간에 섞여 들어온
**compaction/429 문제**이고, 메인테이너가 2026-07-18 코멘트에서 직접
"the compaction/429 reports mixed in here are a separate issue (upstream
#32453-family), not this encryption path"라고 분리해 놓았다.

즉 #92의 본체(Fernet `encrypted_content`로 NEW_TASK body 유실)에 대응하는
업스트림 티켓은 **인용된 적이 없다**. 2026-07-18 코멘트가 "Draft is ready and
will be filed separately"라고 했으나, 이후 코멘트(07-22, 07-23)에도 실제 제출
링크가 없다.

**결정 지점**: #92의 업스트림 이슈를 실제로 제출할 것인가. 제출하지 않으면
"upstream fix를 기다린다"는 우리 공개 입장에 대응하는 티켓이 없는 상태가
계속된다.
