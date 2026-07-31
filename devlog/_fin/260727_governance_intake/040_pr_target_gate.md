# 040 — PR 타깃 게이트 재설계 (WP5, 사용자 승인 대기)

분리 근거: `013_audit_round3_and_scope_split.md`
상태: **BLOCKED — 사용자 승인 필요**

## 우선순위 상향 (5차 검토)

층 분리를 할 때는 "문서 먼저, 자동화는 나중에"가 무해하다고 봤다.
그 전제가 틀렸다.

워크플로가 dev2-go PR을 draft로 강등하고, GitHub은 draft PR의 머지를
차단한다. `ready_for_review`를 구독하므로 사람이 ready로 되돌려도 즉시
다시 draft가 된다. 결론:

> **이 work-phase를 끝내기 전까지 dev2-go 대상 PR은 존재는 하되 머지될 수
> 없다.** 사용자 요청 "dev2-go 기반 pr도 허용"은 층 1만으로는 절반도
> 충족되지 않는다.

따라서 040은 "나중에 해도 되는 후속"이 아니라 **요청 충족의 필수 조건**이다.
층 1은 정책 선언으로서 의미가 있지만, 그것만 보고하면 사용자는 열리지도
않은 문을 열었다고 오해하게 된다.

## 왜 별도 work-phase인가

세 번의 독립 감사가 세 개의 서로 다른 우회를 찾아냈다:

| 설계 | 우회 |
| --- | --- |
| 경로 정규식 + `some()` | 범위 파일 1개로 임의 변경 통과 |
| 전량 검사 + 공유 경로 | rename(`previous_filename` 미검사), 3000파일 API 상한, 공유 디렉터리 과다 |
| 메인테이너 라벨 면제 | 라벨은 **triage 권한**이면 부여 가능, 승인 후 force-push 재검증 없음 |

`enforce-pr-target.yml`은 `pull_request_target` 트리거 + 저장소 write
토큰으로 도는 보안 경계 파일이다. MAINTAINERS.md상 GitHub Actions 변경은
명시적 보안 리뷰 대상이다.

게다가 실제 발효는 **main 승격 시점**이다 — `pull_request_target`은 기본
브랜치의 워크플로를 실행하고, 기본 브랜치는 `main`이다. main 승격은
사용자 승인 사항이다.

두 가지가 겹친다: 설계가 세 번 뚫렸고, 배포가 승인 대기다. 그래서
정책 문서(WP2)와 분리했다.

## 실증으로 추가된 요건 (050 참조)

PR #527(스택 PR)에서 실제 동작을 관측했다:

- 제목에 `[WRONG BRANCH]`가 붙고 봇이 retarget을 요구했다 — 정당한 스택
  구조인데도.
- `convertPullRequestToDraft` GraphQL mutation이 **실패**했고, 워크플로
  실행이 `failure`로 끝났다. PR은 ready로 남았다.
- 그런데 상태 마커는 `autoDraftedByBot: true`로 기록됐다 — 실패한 전환을
  성공으로 기록한다.

여기서 요건 두 개가 더 나온다:

6. **스택 PR을 깨뜨리지 않을 것.** 저장소 내부 브랜치를 base로 하는 PR은
   외부 기여자의 잘못된 base와 성격이 다르다. `head`와 `base`가 모두 이
   저장소 소유일 때를 구분해야 한다.
7. **상태 마커와 실제 상태의 정합성.** mutation 성공 여부와 무관하게
   `autoDraftedByBot: true`를 기록하므로, 복구 로직이 잘못된 기록을 믿고
   엉뚱한 복구를 할 수 있다.

## 최소 요건 (3차 감사 제시)

1. **actor 검증.** 라벨을 승인 신호로 쓸 거면 누가 붙였는지 확인해야 한다.
   `github.event.sender`와 maintainer allow-list 대조, 또는 라벨 대신
   메인테이너 리뷰 승인(`pulls.listReviews`) 사용.

       gh api repos/lidge-jun/opencodex/collaborators --jq '.[] | "\(.login) triage=\(.permissions.triage) maintain=\(.permissions.maintain)"'
       # Wibias    triage=true maintain=false
       # Ingwannu  triage=true maintain=true
       # lidge-jun triage=true maintain=true

   triage와 maintain이 갈린다. 라벨만으로는 이 경계를 못 만든다.

2. **head SHA 바인딩.** 승인 시점의 head SHA를 기록하고, `synchronize`에서
   현재 SHA와 비교해 다르면 승인을 무효화한다. 그렇지 않으면 승인 후
   force-push로 내용을 통째로 바꿔도 통과한다.

3. **라벨 선행 생성.** `scope: dev2-go`는 현재 존재하지 않는다
   (`gh api .../labels/scope%3A%20dev2-go` → 404). 워크플로 배포 전에
   만들어야 한다.

## 추가로 필요한 것

4. **회귀 테스트.** `tests/ci-workflows.test.ts`에 `enforce-pr-target`
   테스트가 **하나도 없다**. 상태 전이(차단 → 승인 → 복구 → 승인 취소)를
   덮는 테스트가 없으면 이 워크플로는 다시 뚫린다.

5. **CI 커버리지 (dev2-go 브랜치 작업).** `pull_request` 워크플로는 PR의
   base 브랜치 버전이 실행되므로, dev2-go PR의 CI는 dev2-go에서 고쳐야 한다:

       dev2-go의 ci.yml               → branches: [main, dev, dev2-go]
       dev2-go의 service-lifecycle.yml → 동일
       dev2-go의 go-ci.yml            → pull_request 트리거 추가 (현재 push만)

## 전제 사실 (재확인 필요)

이 저장소에는 **브랜치 보호도 ruleset도 없다**:

    gh api repos/lidge-jun/opencodex/branches/dev/protection   # 404
    gh api repos/lidge-jun/opencodex/branches/main/protection  # 404
    gh api repos/lidge-jun/opencodex/rulesets                  # (없음)

따라서 CODEOWNERS든 라벨이든 **권한 강제가 아니라 운영 신호**다. 게이트를
"보안 통제"라고 부르려면 브랜치 보호부터 켜야 하고, 그건 저장소 관리자
설정이다.

이 사실이 설계 선택을 바꾼다: 강제할 수 없는 것을 정교하게 만드는 것보다,
명확한 신호를 주고 사람이 판단하게 하는 편이 정직하다.

## 승인이 필요한 결정

사용자에게 물어야 할 것:

1. **게이트 설계.** 세 가지 선택지가 있다:

   (a) **단순 예외** — `EXPECTED_BASE`를 `["dev", "dev2-go"]` 허용 집합으로
       바꾼다. 코드 3줄, 뚫릴 표면 없음. 대신 아무 PR이나 dev2-go로 보낼
       수 있고, 잘못된 base는 사람이 리뷰에서 잡는다.
       세 번의 감사가 무너뜨린 것은 전부 "범위를 자동 판정하려는" 설계였다.
       이 안은 그 시도를 포기한다. **현 저장소에 브랜치 보호도 ruleset도
       없다는 점을 감안하면, 정교한 자동 판정은 어차피 강제력이 없다.**
       → 실용적으로 이 안을 권장한다.

   (b) **actor 검증 + head SHA 바인딩** — 3차 감사가 제시한 최소 요건.
       라벨/리뷰 승인 actor를 maintainer allow-list로 검증하고, 승인 시점
       head SHA를 기록해 force-push 시 무효화한다. 안전하지만 코드가 늘고,
       `pull_request_target` write 토큰 위에서 도는 로직이 복잡해진다.

   (c) **워크플로를 dev2-go에 대해 비활성** — base가 dev2-go면 아무것도
       하지 않고 종료. (a)와 실질적으로 같으나 의도가 더 명시적이다.
       **6차 감사 권장안.** (a)의 효과를 가지면서 의도가 분명하고,
       라벨·actor·SHA 상태 저장을 `pull_request_target` write 권한 위에
       얹는 (b)의 공격 표면을 피한다.

   어느 안을 택하든 **회귀 테스트가 승인 조건이다** (5·6차 감사 합의):
   - base=dev2-go PR이 draft로 강등되지 않고 ready 상태를 유지한다
   - base=main 등 그 외 base는 기존대로 차단된다
   - 제목 prefix / draft 복구 상태 전이가 깨지지 않는다
   `tests/ci-workflows.test.ts`에 현재 `enforce-pr-target` 테스트가 하나도
   없으므로, 이 테스트가 이 work-phase의 실질적 산출물이다.

2. **main 승격 시점.** `pull_request_target`은 기본 브랜치(main)의 워크플로를
   실행한다. 승격 없이는 어떤 설계도 발효되지 않는다.

3. **브랜치 보호.** 켜지 않으면 이 게이트도 CODEOWNERS도 권고에 머문다.
   저장소 관리자 설정이다.

## 상태

`NEEDS_HUMAN`. 위 세 결정 없이는 설계를 확정할 수 없고, 확정해도 배포할 수
없다.

---

## 승인 결과 (2026-07-27)

사용자가 위 세 결정을 모두 승인했고, 조정 작업은 dev에서 진행하라고 지시했다.

### 채택안: (c) allow-list

`EXPECTED_BASE` 단일 문자열을 `ALLOWED_BASES = ["dev", "dev2-go"]`로 바꾼다.
(b)의 actor 검증 + head SHA 바인딩은 채택하지 않는다. 근거 셋:

- 세 번의 독립 감사가 무너뜨린 설계는 전부 **범위를 자동 판정하려는** 것이었다.
  네 번째 시도를 할 이유가 없다.
- 저장소에 브랜치 보호도 ruleset도 없다. 자동 판정에 강제력이 없는 상태에서
  판정 로직만 정교해지면 정확도가 아니라 착시를 만든다.
- `pull_request_target` write 토큰 위에 라벨·승인 actor·SHA 상태 저장을
  얹으면 공격 표면이 는다. 게이트가 막으려는 것보다 게이트 자체가 위험해진다.

포기하는 것은 명시해 둔다: dev2-go로 잘못 보낸 PR을 자동으로 잡아주지
않는다. 그건 리뷰에서 사람이 잡는다. 강제력이 없는 자동 판정보다 그쪽이
정직하다.

### 발효 경로

`pull_request_target`은 기본 브랜치(main)의 워크플로를 실행한다. dev에서
검증이 끝난 뒤 main 승격을 별도 단계로 보고하고 진행한다. 브랜치 보호도
같은 시점에 다룬다.

### 회귀 테스트

WP6/WP7에서 이미 44개 특성화 테스트와 변이 스크립트 12종(131변이)을 깔아
뒀다. 이 변경은 그 그물 위에서 이뤄진다 — 게이트를 바꿀 때 무엇이 깨지는지
테스트가 먼저 말한다.

---

## 감사 15~17라운드 (2026-07-27)

allow-list 구현(`d761e880`), 문서 8종 동기화(`10b1d2aa`), CI 트리거 확장
(`5229717b`) 뒤에 독립 감사를 두 번 더 돌렸다. 두 번 다 FAIL이 나왔고, 두 번
다 지적을 변이 스크립트로 먼저 재현한 뒤 봉쇄했다.

### 15라운드 → `76c25710`

5종 전부 SURVIVED로 실측 재현(`/tmp/mut18.py`).

| 변이 | 성질 |
|---|---|
| `types: [opened]` (ci.yml / service-lifecycle.yml) | 기본값 축소. 아무것도 지우지 않으면서 PR 생성 이후 커밋의 CI를 없앤다 |
| 코멘트 문구를 `context.payload.pull_request.base.ref`로 (2지점) | 호출과 인자는 그대로, 텍스트만 거짓말. main 타깃 작성자가 "currently targets `dev`"를 본다 |
| `if (process.versions.node.startsWith("24")) return;` | 핀 고정 액션의 `action.yml`이 `using: node24`인데 하네스는 v20.19.0을 보고했다 |

봉쇄:

- 하네스 `nodeLikeProcess()`를 v24.10.0으로 정정하고, 워크플로의 액션 핀을
  같이 읽는 프로브 테스트로 major를 고정했다. 런타임을 재핀하면 여기서 깨진다.
- `on.pull_request` 키 집합을 정확 동등으로 고정 — **없는 키를 고정하는 것도
  어설션이다.**
- 두 메시지 경로 모두 live base를 말하는지 본문으로 어설션.

### 16라운드 → `2b03e908`

`ci.yml`의 `paths` 목록이 통째로 미검증이었다. 한 줄씩 지워도 4종 전부
SURVIVED(`/tmp/mut19.py`). 워크플로는 남아 있고 브랜치 목록도 맞는데, 그
표면만 건드린 PR에서 잡이 아예 발화하지 않는다. required check면 영원히
pending, 아니면 그냥 우회다.

`service-lifecycle.yml`은 기존 텍스트 어설션이 이미 잡고 있었다 —
`svc-drop-service`는 CAUGHT였다. 갭은 `ci.yml`에만 있었다.

봉쇄: `pull_request.paths`와 `push.paths`를 정확 집합 동등으로 고정하고,
둘이 서로 같아야 한다는 것도 어설션했다. 트리거 하나에서만 검사받고 dev에
들어오는 경로를 막는다. `/tmp/mut20.py` 8변이 전부 CAUGHT.

### 누적 교훈에 더할 것

**7. 필터는 삭제 없이 삭제한다.** `types:` 축소와 `paths:` 한 줄 제거는
디프에서 스코프 정리처럼 보인다. 지워진 코드가 없으니 코드 리뷰가 잡을
단서도 없다. 실행 여부를 결정하는 목록은 전부 정확 집합으로 고정한다.
