# 013 — 3차 감사 FAIL, LOOP-DOOM-01 적용, 범위 분리

감사자: 독립 서브에이전트 (gpt-5.6-terra medium, 신규) · `VERDICT: FAIL`
대상: `010_branch_policy.md` rev3 (라벨 기반)

## 3연속 FAIL — 패치를 멈춘다

세 라운드 모두 같은 지점에서 막혔다: **`enforce-pr-target.yml`을 어떻게
고칠 것인가.** LOOP-DOOM-01은 같은 phase에서 3회 실패하면 패치를 멈추고
근본 판단으로 돌아가라고 규정한다.

| 라운드 | 설계 | 무너진 이유 |
| --- | --- | --- |
| rev1 | 파일 경로 정규식 + `some()` | 파일 1개로 우회 가능 |
| rev2 | 전량 검사 + 공유 경로 | rename 우회, 3000파일 상한, 공유 디렉터리 과다 |
| rev3 | 메인테이너 라벨 면제 | 라벨은 **triage 권한**이면 붙는다 (메인테이너 전용 아님), 승인 후 force-push 재검증 없음 |

## 3차 지적 판단

### CRITICAL 1 — 라벨은 메인테이너 전용이 아니다

**수용.** 실측으로 확인했다:

    gh api repos/lidge-jun/opencodex/collaborators --jq '...'
    # Wibias    triage=true push=true maintain=false admin=false
    # Ingwannu  triage=true push=true maintain=true  admin=true
    # lidge-jun triage=true push=true maintain=true  admin=true

GitHub 권한표상 **triage 역할이면 라벨을 붙일 수 있다.** 내가 rev3에서
"라벨은 저장소 write 권한자만 붙일 수 있으므로 기여자가 스스로 우회할 수
없다"고 쓴 것은 부정확했다. 외부 기여자는 못 붙이는 게 맞지만, "메인테이너
승인의 증명"으로 쓰기에는 권한 경계가 어긋난다.

### CRITICAL 2 — 라벨 승인 후 head 교체 시 재검증 없음

**수용.** 내가 `synchronize`를 의도적으로 뺐는데, 라벨 설계에서는 그게
치명적이다. 메인테이너가 diff를 보고 라벨을 붙인 뒤 작성자가 force-push로
내용을 통째로 바꿔도 라벨은 유지되고 워크플로는 안 돈다. "사람이 한 번
확인한다"는 설계 목표가 무너진다.

rev2에서는 `synchronize`가 필요했고(파일 목록 의존), rev3에서는 불필요하다고
판단했는데 — 승인 대상이 파일에서 head로 바뀌었을 뿐 재검증 필요성은
그대로였다. 내 판단 오류다.

### MAJOR — #518 수치가 또 낡았다

**수용.** 1시간 만에 바뀌었다:

    # 2차 감사 시점: +1193 / 10커밋
    # 3차 감사 시점: +1245 / 11커밋

살아있는 PR의 수치를 계획 문서에 박아두는 것 자체가 잘못이다. 020에서
절대 수치를 빼고 "분할 직전 재조회" 절차로 대체한다.

### MAJOR — 라벨이 실제로 없다 / 워크플로는 여전히 구 설계

**수용.** `scope: dev2-go` 라벨은 404이고, main·dev의 워크플로는 아직
`EXPECTED_BASE = "dev"`다. 계획이 발효 조건을 고지한 것은 맞지만, 그건
"아직 아무것도 안 됐다"는 뜻이기도 하다.

### MAJOR — CODEOWNERS/라벨은 권한 강제가 아니다

**수용.** ruleset이 비어 있고 브랜치 보호도 없다. 따라서 이 저장소에서
CODEOWNERS든 라벨이든 **운영 신호이지 강제가 아니다.**

### MINOR — 020 수용 기준 중복

**수용.** 020을 정리한다.

## 근본 판단: 요구사항이 두 층으로 나뉜다

세 번 실패하고 나서야 문제가 선명해졌다. 사용자 요청 "dev2-go 기반 PR도
허용"은 사실 두 개의 다른 작업이다.

**층 1 — 정책 선언 (문서).** "dev2-go는 정식 통합선이고, 포팅/리베이스 PR을
환영한다"를 AGENTS.md / CONTRIBUTING.md / MAINTAINERS.md에 쓰는 것.
위험도 낮고, 되돌리기 쉽고, 지금 바로 할 수 있고, 감사에서 아무도
이 부분을 문제 삼지 않았다.

**층 2 — 자동화 게이트 (보안 경계 워크플로).** `enforce-pr-target.yml`을
고치는 것. `pull_request_target` + write 토큰으로 도는 파일이고, 세 번의
감사가 세 개의 서로 다른 우회를 찾아냈고, 실제 발효는 main 승격 시점이며,
그 승격은 사용자 승인 사항이다.

두 층을 한 work-phase에 묶은 것이 실패의 구조적 원인이다. 층 1은 세 번 다
통과했는데 층 2 때문에 함께 막혔다.

## 범위 분리

- **WP2 (지금)** — 층 1만. 문서 3개. dev에 커밋.
  워크플로는 건드리지 않는다. 문서에는 "현재 자동화는 dev2-go PR에
  `[WRONG BRANCH]`를 붙인다"는 **현 상태를 사실대로 적는다.** 정책이
  자동화보다 앞서는 것은 정상이며, 숨기는 것보다 낫다.

- **WP5 (신설, 후속)** — 층 2. `enforce-pr-target.yml` 재설계.
  3차 감사가 제시한 세 가지 보완이 최소 요건이다:
  1. 라벨 actor를 maintainer allow-list로 검증하거나 별도 승인 기록 사용
  2. `synchronize`에서 승인 시점 head SHA와 현재 SHA 비교, 불일치 시 무효화
  3. 라벨 생성·존재 확인을 배포 전 선행 조건으로
  여기에 `enforce-pr-target` 회귀 테스트 추가(현재
  `tests/ci-workflows.test.ts`에 이 워크플로 테스트가 하나도 없다).

  이 work-phase는 보안 경계 변경이므로 MAINTAINERS.md상 명시적 보안 리뷰
  대상이고, 발효에 main 승격이 필요하다. **사용자 승인 없이 진행하지
  않는다.**

## goalplan 변경

- wp2 축소: 문서만.
- wp5 신설: 워크플로 게이트 (사용자 승인 대기).
- 나머지(wp4 메인테이너, wp3 PR 분할)는 층 2에 의존하지 않으므로 그대로.
