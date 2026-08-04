# 006 — 정정 기록

초안(`0a230e0d`) 작성 후 독립 감사 2건(coverage lens / decision-framing lens,
read-only)을 돌렸다. 30건의 모순 지적 중 실측으로 확인된 것을 반영한다.

## 사실 오류 — 정정 완료

| # | 초안 주장 | 실측 | 반영 |
| --- | --- | --- | --- |
| C1 | anthropics/claude-code#1124 CLOSED **2025-08-10** | `closedAt=2025-05-16T14:10:06Z` | 002, 001, 005 정정 |
| C2 | enhancement 라벨 이슈 **11**건 | **13**건 | 000, 003 정정 |
| C3 | #509/#521이 roadmap 대기 | 둘 다 `needs-info` 단독. roadmap은 `[540,294,201,178,177,95,42]` | 005 정정 |
| C4 | #418이 IN-FLIGHT PR 담당 | #418에 연결된 PR **없음** | 005 정정, 묶음 C에 편입 |
| C5 | #42가 IN-FLIGHT | #529 MERGED. Phase 2 완료 | 003, 005 정정 |
| C6 | #424 머지하면 #528 따라옴 (+5100) | `git merge-base --is-ancestor` 실측: **528은 424의 현재 head(`a8b769c9`)를 포함하지 않음**. 528 head=`553e9afc` | 004 정정 |
| C7 | #526 머지되면 #527 리타깃 가능 | `delete_branch_on_merge=false`. 리타깃은 **수동**이며 #526 머지와 무관 | 004 정정 |
| C8 | #461이 "세 번째" / "네 번째" 표면 | 파일 간 불일치. 현재 표면 6개 열거와도 불일치 | 004, 005 통일 |
| C9 | #543이 `upstream-tracking` 묶음 | #543 라벨 = `bug, provider-compatibility, needs-info` | 001 정정 |

## 프레이밍 오류 — 질문에서 제거

감사가 "오너에게 물을 필요 없다"고 지적했고 실측으로 동의한 것들. 질문을
줄이는 것이 인터뷰 품질을 올린다.

### F1 — stale 워크플로 위험은 과장

초안은 "#543이 stale 워크플로에 잘못 걸린다"를 묶음 C의 긴급성 근거로 삼았다.

실측:

- `stale-needs-info.yml`은 `origin/dev`에만 있고 **`origin/main`에 없다**.
  기본 브랜치는 `main`이고, 예약 워크플로는 기본 브랜치에서만 돈다.
  → **현재 이 워크플로는 아예 실행되지 않는다.**
- 설사 돌더라도 `days-before-issue-stale: 14` + `remove-stale-when-updated: true`,
  #543 `updatedAt=2026-07-27T08:34Z`. 최소 14일 여유.

묶음 C의 긴급성 근거는 철회한다. 정직성 문제는 남지만 시한은 없다.

### F2 — #543에 답할 로깅 스위치는 이미 존재한다

리포터가 "지원되는 로깅 스위치를 알려주면 마커 캡처를 하겠다"고 되물었고,
초안은 이를 오너 결정으로 분류했다. 실제로는 `src/lib/debug-settings.ts:7`에
`ocx debug claude on|off|status|reset` / `OCX_CLAUDE_DEBUG=1`이 있고 한국어·중국어
문서에도 나와 있다. 답변만 하면 되는 지원 업무다.

### F3 — 스택 PR 허용 여부는 이미 정해져 있다

초안은 #527에 대해 "스택 PR을 허용할 것인가(워크플로 예외)"를 물으려 했다.
`.github/workflows/enforce-pr-target.yml:26`이 `ALLOWED_BASES = ["dev","dev2-go"]`를
하드코딩하고, AGENTS.md 브랜치 정책에 제3의 타깃이 없다. 정해진 정책이므로
질문이 아니라 실행 순서 문제다.

### F4 — #545가 우리 결함인지는 코드로 판정 가능

초안은 이를 오너 질문으로 뒀으나 실측으로 좁혀진다:

- `src/claude/inbound.ts:436` — `raw.max_tokens`를 `body.max_output_tokens`로
  **클램프 없이** 그대로 전달
- `src/server/claude-messages.ts:596` — native ChatGPT passthrough
  (`openai-responses` 어댑터) 경로에서만 `max_output_tokens`를 **삭제**.
  라우팅된 프로바이더는 유지
- `src/claude/outbound.ts:411` — `incomplete_details.reason === "max_output_tokens"`를
  `finish("max_tokens")`로 정상 종료 처리
- `src/server/request-log.ts:610` — `httpStatusForTerminalStatus`가
  `completed`가 아닌 모든 terminal 상태를 **502**로 기록

즉 제보자가 본 "502 대량 누적"은 최소한 **로그 표기 층**에서 우리 코드가 만든다.
`max_tokens: 64`가 어디서 오는지(클라이언트가 보낸 값인지)는 추가 확인이
필요하지만, "우리 결함인가"는 조사로 답할 문제이지 오너가 정할 문제가 아니다.

남는 오너 결정은 라벨과 우선순위뿐이다.

## 구조 오류 — 묶음 재편

### S1 — 묶음 F가 두 축을 섞었다

초안 F는 "우리가 리베이스할 소형 PR(#491, #429)"과 "#526→#527 머지 순서"를
같이 넣었다. 후자는 리베이스 문제가 아니라 base 리타깃 문제다. 분리한다.

### S2 — #491을 워밍업으로 둔 것은 리포지토리 정책 위반

`gh pr view 491 --json files`: `src/oauth/index.ts`, `package.json`, 테스트 1건.
AGENTS.md는 인증·크리덴셜 경로 변경을 **최우선 보안 경계**로 규정하고 명시적
보안 리뷰를 요구한다. `002_pr_triage_matrix.md:76`도 이미 #491을
`NEEDS-AUTHOR — 보안 경계`로 분류했다.

#491을 "작으니까 먼저"로 다룬 것은 철회한다. 크기가 아니라 경계가 기준이다.
#429는 `src/adapters/cursor/*` 3파일 + 테스트 2건으로 보안 경계 밖이다.

### S3 — #533/#447을 "단순 재리뷰"로 낮춘 것도 철회

`002_pr_triage_matrix.md:72,80`이 #533을 `NEEDS-SECURITY-REVIEW`(의존성 설치
경계), #447을 인증 경계로 분류해 뒀다. 초안이 이를 "재리뷰"로 낮춰 기록했다.
원래 분류를 복원한다.

### S4 — #498은 묶음 B의 축이 아니다

B의 축은 "`main` 계정의 의미"다. #498(`syncCodexSubagentDefaults`)은 Codex native
`[agents]` TOML 편집이고 `main` 계정 의미와 무관하다. "opt-in 플래그"라는
모양만 같다. B에서 분리한다.

### S5 — roadmap 방치를 예외로 둔 것이 자기모순

`003`이 "ACCEPT-CYCLE/ACCEPT-GATED/DECLINE 중 어느 것도 아닌 채 열려 있는 것이
가장 나쁘다"고 써 놓고, `005`가 #95/#386/#414/#415를 "대기 상태이므로 묶지
않았다"로 면제했다. roadmap은 세 상태 중 어느 것도 아니다.

→ 묶음 G(로드맵 정직성)를 신설해 편입한다.

## 아키타입 재분류

초안은 **spec-satisfaction**이라 했다. 근거로 든 검증자("열린 이슈 23 + PR 14
전부가 묶음에 배정")를 초안 자신이 위반했다(#509/#521/#95/#386/#414/#415,
PR #533/#447 미배정).

실제 성격은 **decision-elicitation**이다. done을 정의하는 것은 커버리지가 아니라
"각 묶음에 대해 오너가 방향을 정했는가"다. 커버리지는 전제 조건일 뿐이다.
묶음 G 신설로 커버리지는 채우되, 아키타입은 정정한다.

## 반영하지 않은 지적

| 지적 | 사유 |
| --- | --- |
| #95를 "숨은 미결정"으로 봐야 한다 | 동의하나 묶음 G로 흡수되므로 별도 항목 불필요 |
| MAINTAINERS.md 거버넌스(브랜치 보호, @Wibias 요건 2)가 누락 | 타당한 지적이나 **이슈/PR 범위 밖**이다. 이번 원장은 "열린 이슈·PR 중 결정할 것"이 범위이므로 별도 추적으로 남긴다 — `005` 참조 |
| #462가 needs-info인데 묶음 C에 있다 | C에 유지한다. `upstream-tracking` 라벨을 달고 업스트림 티켓이 없다는 사실은 needs-info 여부와 독립이다 |
