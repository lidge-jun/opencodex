# 002 — 열린 PR 트리아지 매트릭스

조사 시점: 2026-07-27, `dev` = `f327db1e`
대상: `gh pr list --state open` 17건

## UNSTABLE의 실제 의미

`mergeStateStatus=UNSTABLE`로 뜨는 PR 대부분은 테스트 실패가 아니다. fork PR의
Cross-platform CI / React Doctor 워크플로가 `conclusion=action_required` 상태로
승인 대기 중이라서다. 확인:

```
gh run list --json conclusion --jq '.[] | select(.conclusion=="action_required")'
  → fix/gui-update-install-failure-recovery (#533)  314eb53a
  → split/426-01-namespace-foundation      (#512)  aef5628f
  → feat/glm-provider                      (#536)  26e51840
  → feat/image-bridge                      (#424)  a8b769c9
  → feat/gemini-inline-image               (#355)  d3c876e6
```

즉 이 5건은 "CI 실패"가 아니라 "CI 미실행"이다. 승인은 메인테이너 권한 행위이며
이번 루프의 자동 실행 범위 밖이다 — 승인 자체가 fork 코드를 CI에서 실행시키는
결정이기 때문이다.

## `enforce-target` FAILURE의 진짜 원인 (A단계 감사 정정)

> **WP3 감사 추가 정정.** 이 절의 원인 분석은 유효하나 발화 조건이 좁다. 실패는 잘못된
> 타깃 **전부**가 아니라 **draft 전환이 실제로 시도될 때만** 난다. 이미 draft인 PR은 그
> 뮤테이션을 건너뛰어 통과한다. 실측: #536이 `dev`로 리타깃된 뒤 `feat/glm-provider`의
> enforce-target 실행(30250881926, 30250880040)이 **success**다. 즉 "ready 상태 + 잘못된
> 타깃" 조합에서만 드러나는 결함이다.
>
> 또한 `ALLOWED_BASES`는 `["dev", "dev2-go"]`다(`d761e880`). `dev2-go` 타깃은 더 이상
> 위반이 아니며, #455에 남은 `[WRONG BRANCH]` 제목은 그 커밋 이전에 붙은 잔재다.

초안은 이를 "타깃 검사가 통합 브랜치가 아닌 base를 거부한 것"으로 읽었다. **오독이다.**
워크플로 실패 로그(run 30240509333, `feat/glm-provider`)의 실제 내용:

```
GraphqlResponseError: Request failed due to following response errors:
 - Resource not accessible by integration
##[error]Unhandled error: GraphqlResponseError
response: { data: { convertPullRequestToDraft: null }, errors: [ [Object] ] }
```

`enforce-pr-target.yml`은 잘못된 타깃을 발견하면 (a) 제목에 `[WRONG BRANCH] ` 접두사를
붙이고 (b) `convertPullRequestToDraft` GraphQL 뮤테이션으로 draft 전환을 시도한다.
`permissions:`는 `pull-requests: write`만 부여하는데, draft 전환에는 그것으로 부족하다.
워크플로가 `core.setFailed`를 호출하는 경로가 없으므로 잡은 **처리되지 않은 예외로 죽는다.**

실측 확증:

| PR | 제목 접두사 | draft 상태 |
|----|-------------|------------|
| #527 | `[WRONG BRANCH]` 붙음 | `isDraft: false` (전환 실패) |
| #536 | `[WRONG BRANCH]` 붙음 | `isDraft: false` (전환 실패) |

접두사는 REST로 성공하고 draft 전환은 GraphQL에서 실패한다. 즉 **잘못된 타깃의 모든 PR에서
재현되는 실제 워크플로 결함**이며, 이번 트리아지가 발견한 신규 버그다. 후속 work-phase
후보로 기록한다(수정은 `.github/workflows/` 변경이므로 `AGENTS.md`상 보안 리뷰 대상).

## 매트릭스

| # | 제목 요약 | 성격 | 상태 | 판정 |
|---|-----------|------|------|------|
| 526 | sync가 실제로 카탈로그/캐시를 썼는지 보고 | 버그(#476) | CLEAN, CI 통과 | **MERGE-READY** — 신호만 추가, 소비자 없음. 저위험 |
| 527 | 카탈로그 쓰기 후 stale app-server 경고 | 버그(#476) | `enforce-target` FAIL | **BLOCKED-BY-STACK** — ~~#526 머지 시 자동 해소~~ **틀림.** `delete_branch_on_merge=false`라 수동 리타깃이 필요하다. `030` 참조 |
| 529 | 아카이브 정리 + 격리 (phase 2 of #42) | 기능 | CLEAN, CI 통과 | **MERGE-READY** — 단 +3264/-21로 큼. 별도 리뷰 필요 |
| 528 | 이미지 브리지 P2 후속 | 버그 후속 | CLEAN | **BLOCKED-BY-DEP** — #424 의존. #424가 먼저 |
| 424 | Grok 이미지 브리지 | 기능 | CI 미승인, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 355 | Gemini 인라인 이미지 출력 | 기능 | CI 미승인, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 533 | npm 캐시 실패 시 프록시 보존 | 버그(실장애) | CI 미승인 | **NEEDS-SECURITY-REVIEW** — 의존성 설치 경계. 본문이 메인테이너 보안 리뷰를 명시 요청 |
| 512 | Codex 계정 네임스페이스 기반 | 기능(#425) | CI 미승인, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 536 | Zhipu GLM 프로바이더 | 기능 | `main` 타깃 → FAIL | **NEEDS-RETARGET** — 작성자가 `dev`로 변경해야 함 |
| 455 | 임시 검증 export 트리거 | 잡무 | DIRTY(충돌), +69609/-275 | **CLOSE-CANDIDATE** — 자기 소유 임시 draft. 목적 소멸 시 종결 대상 |
| 491 | OAuth 로그인이 저장된 API 키 삭제 방지 | 버그 | draft, CHANGES_REQUESTED | **NEEDS-AUTHOR** — 보안 경계 |
| 493 | 계정별 Claude rate limit | 기능 | draft, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 495 | main 계정 최후 수단 예약 | 기능 | draft, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 498 | opt-in 네이티브 서브에이전트 기본값 | 기능 | draft, CHANGES_REQUESTED, +2427 | **NEEDS-AUTHOR** |
| 447 | Kiro 브라우저 멀티계정 로그인 | 버그 | draft, CHANGES_REQUESTED | **NEEDS-AUTHOR** — 인증 경계 |
| 429 | Cursor 셸 alias 힌트 주입 중단 | 버그 | draft | **NEEDS-AUTHOR** |
| 461 | `ocx opencode` 런처 | 기능 | draft | **NEEDS-AUTHOR** |

## 종결 가능 대상

엄밀히 이번 루프에서 닫을 수 있는 PR은 **#455 하나**다.

- 자기(`lidge-jun`) 소유이므로 타 기여자 작업을 가로채지 않는다.
- 제목이 스스로 `[WRONG BRANCH] chore: temporary verification export trigger`이고
  본문상 목적이 일회성 검증이다.
- DIRTY(충돌) 상태이고 +69609/-275라 머지 경로가 없다.
- `dev2-go` 타깃이며 해당 검증은 이미 종료됐다(WP3에서 재확인 필요).

나머지 16건은 닫으면 안 된다. draft + CHANGES_REQUESTED는 "작성자가 작업 중"이라는
뜻이지 "포기"가 아니다. 외부 기여자 PR을 메인테이너가 일방 종결하면 기여 의욕을
꺾는다.

## 머지 순서 판정

```
#526 (CLEAN, 신호만)
   └─→ #527 (머지 후에도 base는 그대로 — 수동 리타깃 필요)

#424 (CI 승인 필요)
   └─→ #528 (tip 6d6b252에서 분기, #424 선행 필요)
```

`#528`의 의존은 본문 주장이 아니라 커밋 그래프로 확인했다. `refs/pull/528/head`(`553e9afc`)가
`0fba6e90 feat(images): add Grok image bridge for non-OpenAI models` 등 #424의 커밋을
포함한다. 다만 `#424`의 **현재 head**(`a8b769c9`)는 `#528`의 조상이 **아니다** — #424가
그 이후 갱신됐다는 뜻이므로, #424를 먼저 머지하면 #528은 리베이스가 필요하다.

#526→#527이 이번 루프에서 판정 가능한 유일한 스택이다. 다만 머지 자체는 메인테이너
결정이며, 사용자가 이번 루프에서 승인한 것은 `dev` 푸시(#539 수정)까지다. PR 머지는
별도 승인이 필요하다 — 판정과 문서화까지가 WP3의 범위다.

## 스코프 경계 기록

이번 루프에서 **하지 않는** 것과 그 이유:

- fork CI 승인: 승인은 fork 코드를 CI 러너에서 실행시키는 보안 결정이다.
- PR 머지: 사용자 승인 범위는 `dev` 푸시로 한정됐다.
- 타 기여자 PR 코드 직접 수정: `AGENTS.md` 리뷰 정책상 리뷰어의 역할은 지적이지 대필이 아니다.
