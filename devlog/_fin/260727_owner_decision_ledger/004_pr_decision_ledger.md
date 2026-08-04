# 004 — 열린 PR 결정 원장

측정: 2026-07-27, `gh pr view` 실측. 열린 PR 14건.

## 전체 상태표

| # | 제목 | 라벨 | draft | merge | review | 규모 | 오너 결정 축 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 533 | update: npm 캐시 실패 시 프록시 보존 | bug | ready | MERGEABLE/UNSTABLE | CHANGES_REQ | +2405/-73, 21f | 재리뷰 |
| 528 | images: #424 P2 후속 | bug | ready | CLEAN | — | +2770/-60, 21f | **#424 의존** |
| 527 | codex: stale app-server 경고 | bug | ready | MERGEABLE (enforce-target FAILURE) | — | +1162/-45, 15f | **base가 dev 아님** |
| 526 | codex: 카탈로그 write 여부 보고 | bug | ready | CLEAN | — | +86/-14, 6f | 머지 가능 |
| 512 | codex: 계정 네임스페이스 foundation | enhancement | ready | UNSTABLE | CHANGES_REQ | +1698/-46, 28f | 설계 승인 |
| 498 | codex: native subagent 기본값 opt-in | enhancement | draft | **CONFLICTING** | CHANGES_REQ | +2427/-286, 55f | 정책 |
| 495 | codex: main 계정 최후 수단 예약 | enhancement | draft | UNSTABLE | CHANGES_REQ | +294/-11, 14f | 정책 |
| 493 | quota: Claude 계정별 한도 | enhancement | draft | **CONFLICTING** | CHANGES_REQ | +291/-20, 14f | **#294 승격 여부** |
| 491 | oauth: 로그인이 저장된 API 키 삭제 | bug | draft | **CONFLICTING** | CHANGES_REQ | +251/-4, 3f | 소규모, 충돌만 |
| 461 | cli: `ocx opencode` 런처 | enhancement | draft | **CONFLICTING** | — | +868/-0, 6f | **표면 확장 여부** |
| 447 | kiro: 브라우저 멀티계정 로그인 | bug | draft | CLEAN | CHANGES_REQ | +1625/-137, 20f | **인증 경계 리뷰** |
| 429 | cursor: shell-alias 힌트 주입 제거 | bug | draft | **CONFLICTING** | — | +48/-37, 5f | 소규모, 충돌만 |
| 424 | images: Grok 이미지 브리지 | enhancement | draft | UNSTABLE | CHANGES_REQ | +2333/-59, 22f | **유료 호출 정책** |
| 355 | google: Gemini 인라인 이미지 | enhancement | draft | UNSTABLE | CHANGES_REQ | +1435/-15, 16f | **424와 중복 축** |

합계: ready 4, draft 10. CONFLICTING 5건. CHANGES_REQUESTED 9건.

> #533은 `002_pr_triage_matrix.md:72`에서 `NEEDS-SECURITY-REVIEW`(의존성 설치
> 경계), #447은 같은 문서 80행에서 인증 경계로 이미 분류돼 있다. 초안이 둘 다
> "단순 재리뷰"로 낮춰 기록했던 것을 복원했다.

## 결정 축 1 — 이미지 생성 경로가 두 개다 (#424 / #355 / #528)

이게 가장 큰 미결정이다. 두 PR이 **같은 사용자 문제**를 서로 다른 방식으로 푼다:

| | #424 (Grok 브리지) | #355 (Gemini 인라인) |
| --- | --- | --- |
| 문제 | non-OpenAI 라우팅 시 `image_generation` 호스티드 툴이 죽음 | 동일 |
| 방식 | 합성 함수 툴로 치환 → xAI Grok Imagine 호출 → 아티팩트 주입 → 모델 재호출 | CCA(Antigravity) 이미지 모델로 `/v1/images/generations` 폴백 + `inlineData` 파싱 |
| 비용 | **xAI 유료 호출** 발생 | 사용자의 기존 Gemini/CCA 계정 |
| 규모 | +2333 (+#528의 +2770) | +1435 |
| 아키텍처 | `src/web-search/` 사이드카 패턴 복제 | 기존 google 어댑터 확장 |

#528은 #424의 P2 후속이고 본문이 "**Depends on #424** — 먼저 #424를 머지하라"고
명시한다. 다만 실측상 **#528은 #424의 현재 head를 포함하지 않는다**:

```
424 head = a8b769c9
528 head = 553e9afc
git merge-base --is-ancestor pr424 pr528  → false
```

#528 본문이 밝힌 분기점은 `6d6b252`이고 그 뒤 #424가 더 진행됐다. 따라서
#424를 먼저 머지하면 **#528은 리베이스가 필요하다.** "따라온다"는 초안 서술은
틀렸다. 두 PR 합계 규모는 +5100줄 수준이지만 자동으로 딸려오지 않는다.
(`002_pr_triage_matrix.md:110`이 이미 같은 결론을 냈고 초안이 놓쳤다.)

**결정 지점**: 둘 다 받을 것인가, 하나만 받을 것인가, 어느 쪽을 기본 경로로
삼을 것인가. 둘 다 받으면 "이미지 생성 시 어느 백엔드로 가는가"라는 새 라우팅
규칙이 필요해진다 — 지금 어느 PR도 그걸 정의하지 않는다.

#528이 클램프하려는 것("hand-edited `10000` 값이 xAI 유료 호출을 무한정 태우지
못하게")이 이 축의 성격을 잘 보여준다. #424 경로는 사용자 돈이 나가는 경로다.

## 결정 축 2 — #527이 잘못된 base를 향한다

실측: `#527 base=codex/catalog-written-signal head=codex/app-server-restart`.

제목에 이미 `[WRONG BRANCH]`가 붙어 있고, `enforce-target` 체크가
**FAILURE**다. base가 `#526`의 헤드 브랜치이므로 스택 PR 형태인데, 우리
`enforce-target` 워크플로는 `dev`/`dev2-go`만 허용한다.

두 PR은 #476(카탈로그 변경 미반영)을 승계한 쌍이다. #526(신호 보고, +86줄,
CLEAN)이 먼저 머지되면 #527의 base를 `dev`로 리타깃할 수 있다.

**오너 결정 아님 — 실행 순서 문제.** `.github/workflows/enforce-pr-target.yml:26`이
`ALLOWED_BASES = ["dev","dev2-go"]`를 하드코딩하고 AGENTS.md 브랜치 정책에
제3의 타깃이 없다. 스택 PR 허용은 이미 배제돼 있다.

추가 정정: `delete_branch_on_merge=false`이므로 **#526을 머지해도 #527의 base가
자동으로 옮겨가지 않는다.** 리타깃은 수동이며 #526 머지 여부와 무관하게 지금
할 수 있다. 초안이 기술한 선후 의존은 존재하지 않는다
(`002_pr_triage_matrix.md:67`에 같은 지적이 있다).

## 결정 축 3 — 계정 정책 3종 (#512 / #495 / #498)

세 PR 모두 "계정/기본값을 누가 소유하는가"를 건드린다. 각각 독립적으로 보이지만
한 사용자에게는 겹쳐 보인다.

- **#512** (#425의 foundation): 모델 셀렉터 네임스페이스 → 저장된 Codex 계정 ID.
  `__main__`을 내부 Desktop 계정용으로 예약하고 `@main`을 맵에서만 쓴다.
- **#495**: `mainAccountLastResort` 정책(기본 off). main 로그인을 최후 수단으로
  예약하고, 쿼터 리밸런싱이 건강한 added 계정을 main으로 옮기지 못하게 막는다.
- **#498**: `syncCodexSubagentDefaults`(기본 off). Codex native `[agents]`
  기본값에 injectionModel/effort를 마커 범위 TOML 편집으로 주입.

#512와 #495는 **같은 `main` 계정 개념**을 다르게 다룬다. #512는 이름공간에서
`main`을 실제 풀 계정 ID로 남겨두려 하고, #495는 `main`을 라우팅에서 특별
취급한다. 둘 다 머지되면 "main"이 사용자에게 두 가지 의미를 갖는다.

**결정 지점**: 세 opt-in 플래그를 각각 독립 승인할 것인가, 아니면 계정 정책
하나의 사이클로 묶어 일관된 모델을 먼저 정할 것인가. #498은 55파일
CONFLICTING이라 어차피 재작업이 필요하다.

> **묶음 정정.** #498은 `main` 계정 의미 축이 아니다. Codex native `[agents]`
> TOML 편집이고 계정 정체성과 무관하다. "opt-in 플래그"라는 모양만 공유한다.
> 묶음 B에서 분리한다 — `006_corrections.md` S4.

## 결정 축 4 — 새 클라이언트 표면 (#461)

`ocx opencode`는 `ocx claude`, native Codex injection에 이은 **새 런처 표면**이다.
+868/-0, 순수 추가.

정확히 말하면 "세 번째"는 **런처 명령** 기준이고(native injection, `ocx claude`,
`ocx opencode`), 우리가 지탱하는 **클라이언트 표면**은 그보다 많다: Codex
CLI/App/SDK, Claude Code, Claude Desktop 3P, Cursor, Kiro. 초안이 두 층위를
섞어 "세 번째"와 "네 번째"를 파일마다 다르게 적었다.

표면이 늘면 유지 비용이 영구적으로 늘어난다. 이번 라운드 이슈 중
상당수(#545, #546, #543)가 Desktop 3P 표면에서 나왔다는 점이 그 비용의 실례다.

**결정 지점**: 표면을 하나 더 받을 것인가. 받는다면 지원 등급(1급/실험적)을
무엇으로 선언할 것인가. 현재 PR은 draft/CONFLICTING이고 리뷰가 없다.

## 결정 축 5 — CHANGES_REQUESTED 9건이 멈춰 있다

9건이 변경 요청 상태다. 이 중 CONFLICTING까지 겹친 것이 #498, #493, #491.

`#491`과 `#429`는 작다(+251/3파일, +48/5파일). 둘 다 명확한 버그 수정이고
본문 진단이 구체적이다:

- #491: `upsertOAuthProvider`가 매 OAuth 로그인마다 provider 항목을 프리셋으로
  덮어써서 `apiKey`/`apiKeyPool`이 삭제됨. `allowKeyAuthOverride` 프로바이더
  (`xai`, `github-copilot`)에서 과금 선택이 조용히 뒤집힘.
- #429: Cursor 어댑터가 사용자 메시지에 `"Use exec_command for this shell
  command."`를 덧붙이고, Cursor 대화 영속화가 오염된 프롬프트를 재생.

둘 다 리베이스만 하면 진행 가능한 크기다.

**결정 지점**: 작고 명확한 수정(#491, #429)을 우리가 리베이스해서 살릴 것인가,
기여자 응답을 기다릴 것인가. 메모리 기준 "우리가 수정할 수 있으면 rework나
얹어서 수정하는 방향"에 해당하는 후보군이다.

> **중대 정정.** #491을 "작으니까 먼저"로 다룬 것은 철회한다. 변경 파일은
> `src/oauth/index.ts`, `package.json`, 테스트 1건 — **AGENTS.md가 최우선
> 보안 경계로 규정한 크리덴셜 경로**다. `002_pr_triage_matrix.md:76`도
> `NEEDS-AUTHOR — 보안 경계`로 분류했다. 크기가 아니라 경계가 기준이다.
>
> #429는 `src/adapters/cursor/*` 3파일 + 테스트 2건으로 보안 경계 밖이다.
> 우리가 리베이스할 수 있는 후보는 **#429뿐**이다.

## 참고 — #529는 이미 머지됨

`001_issue_triage_matrix.md`가 #42를 "PR #529가 phase 2 담당, IN-FLIGHT"로
기록했으나 실측상 **#529는 MERGED**다. #42의 Phase 2는 끝났고 남은 것은
Phase 2.1(복원 UI)과 Phase 3(자동 정책)이다.
