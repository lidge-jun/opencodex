# 000 — Wibias 완료선언 PR + 전체 PR/Issue 처분 분류: Plan

> 작성 2026-07-25 KST · 기준 커밋 `3fac781f` (origin/dev, fast-forward pull 완료)
> 선행 유닛: `devlog/_fin/260725_260725-pr-issue-triage/` (tier 분류) — 본 유닛은 그 위에
> **처분(disposition) 결정**을 얹는다. tier는 "상태 분류", disposition은 "행동 결정".

## Objective

Wibias가 "ready → re-review into merge" 라고 선언한 PR 5건(#391 #392 #402 #408 #423)의
실제 머지 적격성을 증거로 판정하고, 이를 포함해 스냅샷 시점의 open PR + open Issue
전량을 단일 처분 축에 배치한 뒤 사용자가 요청한 6개 뷰로 제시한다. 실행(머지/클로즈/코멘트)은 하지 않고
결정 문서만 산출한다 — 실행 승인은 사용자 몫.

### 인벤토리 매니페스트 (스냅샷 고정 — 감사 blocker 1)

고정 카운트는 신규 PR 도착으로 즉시 stale이 된다. 실제로 감사 1회차 중 `#429`
(00:52:59Z), 2회차 중 `#430`(01:00:59Z)이 도착해 21→22→23으로 두 번 변했다. 따라서
**정확한 RFC3339 시각**과 번호 집합으로 고정하고, 그 시각 이후 `createdAt` 항목은
범위 외로 배제한다.

```
snapshot   2026-07-25T01:05:24Z (UTC) = 10:05:24 KST · base 3fac781f
open PR    23 → 430 429 428 427 426 424 413 411 410 409 408 407 406 405 403 402
                392 391 389 385 376 370 355
open Issue 22 → 425 422 420 418 417 415 414 401 399 386 374 373 357 330 294 241
                201 178 177 95 92 42
총 45 항목
```

배제 규칙: `createdAt > 2026-07-25T01:05:24Z`인 항목은 본 유닛 범위 외 → 다음 사이클.
`#429`(00:52:59Z)와 `#430`(01:00:59Z)은 스냅샷 시각 **이전**이므로 포함한다.

## 구조: 2축 (A-gate 감사 후 재설계)

최초 설계는 사용자 요청 6항목을 그대로 "상호배타 카테고리"로 삼았으나 A-gate에서
구조적 모순으로 FAIL 판정을 받았다. 근거: 항목 1(이슈 처리)은 **모든** 이슈에 행동을
부여하는데 항목 3~5(개선 시간축)도 이슈를 받으므로, `#294`는 정의상 1과 4에 동시
소속된다. `#417`/`#241`/`#92`의 `UPSTREAM_TRACKING`도 "행동"이지 "개선 시간축"의
동급 버킷이 아니다. 따라서 축을 분리한다.

**축 1 — Primary disposition (항목당 정확히 하나, 배타적):**

| ID | 의미 | 적용 |
|----|------|------|
| `ALREADY_MERGED` | 이미 머지됨 — 행동 불필요 | PR (#423) |

| ID | 의미 | 적용 |
|----|------|------|
| `MERGE` | 머지 가능 — 코드/CI/리뷰 증거 충족 | PR |
| `MERGE_AFTER_FIX` | 가치 확정, 이름 붙은 blocker 잔존 | PR |
| `REBUILD_ON_DEV` | 의도 유효, 브랜치가 stale/stacked — 재커팅 요청 | PR |
| `AWAIT_AUTHOR` | 변경요청 후 작성자 응답 대기 | PR |
| `AWAIT_VALIDATION` | draft 또는 작성자가 명시한 검증 미완 | PR |
| `AWAIT_REVIEW` | non-draft, 작성자 조치 요청 없음, 독립 리뷰 미결 | PR |
| `AWAIT_CI` | **non-draft** PR에서 필수 체크가 큐/진행/취소 **또는 미실행**, 작성자 수정 요청 없음 | PR |
| `AWAIT_FIX` | 필수 CI가 **실패 확정** 또는 이름 붙은 기술 blocker — 작성자 수리/설명 필요 | PR |
| `FIX_NOW` | 원인 소스 확정 + 수정 범위 좁음 | Issue |
| `PR_IN_FLIGHT` | 진행 중 PR이 커버 (커버율 명시) | Issue |
| `NEEDS_INFO` | 특정 아티팩트 없이는 진행 불가 | Issue |
| `UPSTREAM_TRACKING` | 본 저장소에서 수정 불가 | Issue |
| `ROADMAP` | 정당한 작업, 선행조건 필요 | Issue/PR |
| `DEFER` | 지금 하지 않는 것이 옳음 (적극적 근거) | Issue/PR |
| `CLOSE_MENTION` | 설명 코멘트와 함께 클로즈 | Issue/PR |

### 처분 우선순위 (감사 blocker 2 — 전순서 규칙)

한 항목이 두 처분의 정의를 동시에 만족할 수 있다(감사 반례: `#391`은
`CHANGES_REQUESTED`이므로 `AWAIT_AUTHOR`이면서, 가치 확정 + 이름 붙은 blocker이므로
`MERGE_AFTER_FIX`이기도 하다). 배타성은 정의만으로 보장되지 않으므로 전순서를 둔다.
**위에서 먼저 매칭되는 것이 최종 처분이다:**

```
ALREADY_MERGED > CLOSE_MENTION > UPSTREAM_TRACKING > NEEDS_INFO
  > AWAIT_AUTHOR > REBUILD_ON_DEV > AWAIT_FIX > AWAIT_CI
  > AWAIT_VALIDATION > AWAIT_REVIEW > DEFER > ROADMAP
  > MERGE_AFTER_FIX > PR_IN_FLIGHT > FIX_NOW > MERGE
```

`AWAIT_FIX` 추가 근거 (A-gate 6회차 blocker): `#428`은 3플랫폼 CI가 모두 **실패 확정**
(진행/취소가 아님)인데 `CHANGES_REQUESTED`는 없다. `AWAIT_CI`(진행/미실행)도,
`AWAIT_REVIEW`(비실패 요구)도, `MERGE_AFTER_FIX`(가치 기확립 요구 — 미리뷰 PR엔 부적합)도
아니었다. "CI 실패는 작성자가 고쳐야 한다"는 실제 다음 행동을 담는 처분이 필요하다.

`AWAIT_CI`를 `AWAIT_VALIDATION`보다 앞으로 올린 근거: non-draft PR에서 exact-head 필수
CI가 미완이면 리뷰·검증 논의보다 CI 복구가 먼저다(`#402`의 `windows-latest=CANCELLED`
사례). draft는 `AWAIT_VALIDATION`이 여전히 잡는다 — draft는 CI 이전에 작성자 완료 선언
자체가 없기 때문이다.

따라서 `AWAIT_CI`에는 **non-draft 가드**가 필수다(A-gate 7회차 blocker): 가드가 없으면
`#426`(draft, 필수 job 미실행)이 `AWAIT_CI`로 먼저 매칭되어 "CI 돌려라"라는 잘못된 행동을
지시한다. draft의 실제 다음 행동은 작성자의 ready 선언이다. 가드를 넣으면
`#402 → AWAIT_CI`와 `#426 → AWAIT_VALIDATION`이 동시에 성립한다.

`AWAIT_REVIEW` 진입 조건 — **실행 게이트 기준**(GitHub 상태 문자열 아님):

1. 충돌 없음 (`CONFLICTING`/`DIRTY` 아님), **그리고**
2. 필수 CI job 3종(`ubuntu-latest`/`macos-latest`/`windows-latest`)이 모두 **존재하고
   종료 상태이며 실패 없음**, **그리고**
3. 작성자 조치 불필요 (변경요청·draft·작성자 명시 미검증 없음).

`mergeStateStatus=CLEAN`을 조건으로 쓰면 안 된다(A-gate 5회차 blocker): `UNSTABLE`은
실패가 아니라 "필수 job 미보고/미실행"인 경우가 많고, 실제로 `#355 #385 #424 #427
#429` 5건이 그 상태다. 이들은 리뷰 대기가 아니라 **CI 미실행 대기**이므로
`AWAIT_CI`(필수 job 부재 포함)로 흘러야 한다. 상태 문자열이 아니라 "다음 행동이
무엇인가"로 판정한다.

근거: 차단 상태(누가 공을 갖고 있는가)가 가치 판단(머지할 만한가)보다 우선한다.
`#391`은 `AWAIT_AUTHOR`이 `MERGE_AFTER_FIX`보다 앞서므로 `AWAIT_AUTHOR`로 확정되고,
"CI 3건 실패 + 미해결 리뷰" 사실은 그 행의 증거 필드에 남는다. 뷰 3(그럴만한 개선)에는
`MERGE_AFTER_FIX`가 아니어도 별도 주석으로 노출한다.

`AWAIT_REVIEW` 추가 근거 (A-gate 3회차 blocker): `#429`/`#385`는 non-draft,
`MERGE_AFTER_FIX`도 아니고 변경요청도 없고 draft도 아닌데 **사람 리뷰가 0건**이다.
`MERGE`는 독립 리뷰를 필수로 하므로 이 상태를 담을 처분이 없었다. 즉 "공은
메인테이너에게 있다"가 실제 상태이며, 이는 작성자 대기와 구별해 즉시 리뷰 큐로
노출해야 한다. `AWAIT_REVIEW` 항목은 뷰 3(그럴만한 개선)에 **리뷰 큐**로 별도 표기한다.

`AWAIT_CI` 추가 + 순서 교정 근거 (A-gate 4회차 blocker): 3회차판 순서는
`AWAIT_REVIEW`를 `REBUILD_ON_DEV`보다 앞에 뒀는데, 이는 CONFLICTING/DIRTY인
`#406 #407 #409 #410 #411 #413` 6건을 "리뷰 대기"로 잘못 매칭시켜 **리베이스가
선행이라는 사실을 은폐**한다. 또 `#430`은 필수 3플랫폼 CI가 IN_PROGRESS이므로
리뷰 대기가 아니라 CI 대기다. 따라서 `REBUILD_ON_DEV`를 앞으로 올리고 `AWAIT_CI`를
신설해 `AWAIT_REVIEW` 위에 뒀다.

**우선순위 검증 (first-match 결과):**

| PR | 상태 근거 | first-match |
|----|----------|-------------|
| #426 | draft | `AWAIT_VALIDATION` |
| #391 #392 #389 #376 #370 | CHANGES_REQUESTED | `AWAIT_AUTHOR` |
| #406 #407 #409 #410 #411 #413 | CONFLICTING/DIRTY | `REBUILD_ON_DEV` |
| #428 | 3플랫폼 CI 실패 확정 (GUI lint) | `AWAIT_FIX` |
| #430 | 필수 CI 진행 중 | `AWAIT_CI` |
| #402 | exact-head `windows-latest` CANCELLED | `AWAIT_CI` |
| #355 #385 #424 #427 #429 | 필수 CI job 미실행 (UNSTABLE) | `AWAIT_CI` |
| #426 | draft | `AWAIT_VALIDATION` |
| #403 #405 #408 | 충돌 없음 + 필수 CI 전건 green + 사람 리뷰 0건 | `AWAIT_REVIEW` |

23건 전수 first-match가 유일하게 결정되며, 각 처분이 실제 다음 행동과 일치한다.

**축 2 — 사용자 요청 6개 보고 뷰 (교차 허용, 파생물):**

| # | 사용자 원문 | 파생 규칙 (축 1에서 자동 유도) |
|---|------------|------------------------------|
| 1 | 이슈 어떻게 처리할지 | Issue 전체를 primary disposition별로 제시 |
| 2 | pr들 완료했다고 할꺼 어떻게 처리할지 | #391 #392 #402 #408 #423의 선언 대비 실측 |
| 3 | 개선중에 그럴만 한 개선 | `MERGE` ∪ `MERGE_AFTER_FIX` ∪ `FIX_NOW` |
| 4 | 차후 개선 | `ROADMAP` ∪ `REBUILD_ON_DEV` |
| 5 | defer 가 맞는 개선 | `DEFER` |
| 6 | 멘션클로즈 | `CLOSE_MENTION` |

뷰는 축 1의 함수이므로 뷰끼리의 중복은 결함이 아니다. 배타성은 축 1에서만 강제한다.

## Decision rules (배치 기준 — 사전 고정)

- **`MERGE`:** exact-head CI green + mergeable/CLEAN + 미해결 blocker 없음 + 독립 코드리뷰
  결론 존재. 기여자의 "ready" 자기선언은 증거로 인정하지 않는다.
- **`FIX_NOW`:** 이슈 원인이 소스 `file:line`으로 확정되고 수정 범위가 좁은 것.
- **`ROADMAP`:** 가치 인정 + **독립 검증 가능한 선행조건 아티팩트**(PR#/Issue#/commit/
  release/spec) + 소유자 + 관측 가능한 완료 조건 + **선행조건 랜딩 후 남는 게이트**를
  전부 명시. 선행조건이 랜딩되어도 자동 승격되지 않는다(감사 blocker 3: `#413`/`#409`는
  선행조건을 대지만 여전히 `CONFLICTING/DIRTY`). 재평가 트리거를 함께 적는다.
  이 4요소를 못 채우면 `ROADMAP`이 아니라 `DEFER`다.
- **`DEFER`:** 지금 하지 않는 것이 옳다는 **적극적 근거** — 비용/수요 불확실, 계약 미문서화,
  상위 설계 미정. "그냥 나중에"는 근거가 아니다.
- **`CLOSE_MENTION`:** 다음 중 하나의 사실 근거 필수 — 머지된 수정 SHA / 중복 원본 URL /
  범위 외 정책 인용 / 문서화된 연락 부재 이력. 근거가 없으면 `AWAIT_AUTHOR`나
  `NEEDS_INFO`이며, 절대 클로즈하지 않는다(기여자 작업 보존 원칙).

## 증거 행 스키마 (항목 유형별 — 감사 blocker 4)

GitHub 이슈에는 head SHA·reviewDecision·check가 존재하지 않으므로 단일 스키마를
강요하면 값을 날조하게 된다. 유형별로 분리한다.

**PR 행 (필수 7):** author · head SHA · mergeable/mergeStateStatus ·
reviewDecision · check pass/fail/pending 수 · 변경 파일 수 · 증거(`file:line` 또는
CI job·테스트명). `MERGE`는 추가로 (a) exact-head CI 전건 green **과**
(b) 독립 코드리뷰 결론 **둘 다** 요구한다(감사 blocker 6: `또는`은 불충분).

**Issue 행 (필수 5):** 유형(bug/enhancement) · 라벨 · 연결된 PR/커밋(없으면 `없음`) ·
원인 근거(`file:line` 또는 이슈 인용) · 처분별 추가 증거(`ROADMAP`은 선행조건 4요소,
`DEFER`는 적극적 근거+재평가 트리거, `CLOSE_MENTION`은 사실 근거 4종 중 하나,
`NEEDS_INFO`는 요청할 아티팩트 목록).

`N/A`는 해당 유형에 그 필드가 구조적으로 없을 때만 허용한다.
모든 행은 라벨된 고정 필드명을 사용한다(C3의 누락 검사가 성립하려면 필수).

## Loop-spec

- Loop archetype: spec-satisfaction (verifier = 문서 존재 + 배치 근거의 GitHub/소스 재검증)
- Trigger: 사용자 요청 — Wibias 완료선언 확인 + 6분류 devlog
- Goal: 실행 가능한 처분 결정 문서 1건
- Non-goals: PR 머지/클로즈 실행, 이슈 코멘트 작성, 코드 수정
- Verifier: 배치된 각 항목의 근거를 `gh` 실제 상태 + 소스 `file:line`으로 재확인
- Write scope: `devlog/_plan/260725_wibias_pr_issue_disposition/**` (NEW) 전용
- Out-of-scope 경계: `src/`, `gui/`, `tests/`, `.github/` 무변경
- Stop condition: 위 매니페스트 45개 항목(PR 23 + Issue 22) 전부가 축 1에 배치되고
  각 근거가 재검증되면 종료. 매니페스트와의 집합 일치를 확인한다.
- Memory artifact: 본 유닛 `000`/`010`
- Expected terminal outcome: DONE (문서 산출) — 실행은 사용자 승인 대기
- Escalation: Wibias PR 판정이 증거상 갈리면 판정 보류 + 사용자 판단 요청

### 위임 (bidirectional)

- 하향: Sol/Terra 서브에이전트 병렬 레인 — `Sagan`(PR 전수 분류), `Descartes`(Issue 전수
  분류 + 버그 주장 소스 검증), `Russell`(Wibias 4건 심층 코드리뷰), `Feynman`(계획 A-gate
  감사), `Ohm`(기여자 응대 문안), `Turing`(#402↔#429 관계), `Pascal`(23건 파일 충돌 행렬),
  `Rawls`(#422/#420 diff-level 수정 명세), `Helmholtz`(#430 검증).
  전부 read-only, write scope 없음.
- 상향: 동일 packet을 서로 다른 2 에이전트가 실패하면 main이 회수해 직접 판정.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| 1 | `010_disposition.md` | 45개 항목 처분 배치 + Wibias 5건 판정 + 실행 순서 | — |

단일 work-phase 유닛(문서 산출 전용)이므로 `cxc-loop` LOOP-DOCS-FIRST-01의 별도
roadmap 사이클은 면제 대상이다.

## Accept criteria

A-gate 감사(blocker 6)에 따라 전부 독립 검증 가능한 형태로 재작성했다.

- **C1:** Wibias 완료선언 5건 각각이 PR 행 스키마 7필드를 전부 채운다. 판정 근거는
  정확한 실패 위치(`tests/subagent-model-fallback.test.ts:96:28` 수준) 또는 독립
  코드리뷰 결론을 포함한다. `MERGE` 처분을 받은 항목은 exact-head CI 전건 green
  **과** 독립 코드리뷰 결론을 **둘 다** 갖는다(`또는` 불가). 검증: 행별 7필드 +
  `MERGE` 행의 두 조건 동시 충족.
- **C2:** 인벤토리 매니페스트의 45개 번호 집합과 문서에 배치된 번호 집합이 **집합 일치**
  하고, 축 1 처분이 항목당 정확히 1개다. 두 처분이 동시에 성립하는 항목은 우선순위
  전순서로 해소되었음이 해당 행에 기록된다. 검증: 번호 diff + 중복 카운트.
- **C3:** `ROADMAP` 항목마다 선행조건 식별자·소유자·관측 가능한 완료 조건·잔존 게이트
  4요소가 있고, `DEFER` 항목마다 인용된 적극적 근거와 재평가 트리거가 있다.
  각 요소는 **라벨된 고정 필드명**(`선행조건:` `소유자:` `완료조건:` `잔존게이트:`
  `defer근거:` `재평가:`)으로 기재한다. 검증: 라벨 grep으로 누락 검출.
- **C4:** `CLOSE_MENTION` 항목마다 (a) 사실 근거 4종 중 하나와 (b) 1~2문장 코멘트 문안이
  있다. 검증: 항목별 두 필드 존재. 근거 없는 클로즈 제안은 C4 위반.
- **C5:** `gh pr view <n> --json files` 기반 **파일 교집합 행렬**이 산출되고, 비어있지 않은
  모든 교차쌍에 직렬 머지/리베이스 순서가 배정된다. 최소한 `#427`↔`#428`
  (`gui/src/pages/Dashboard.tsx` + 로케일 6종)과 `#402`↔`#429`(Cursor 어댑터)가
  명시되어야 한다. 검증: 교차쌍 목록 대조.
- **C6:** 선언된 유닛 경로 외 무변경. 검증 명령:
  `git diff --name-only 3fac781f -- src gui tests .github docs-site` (빈 출력) +
  `git status --porcelain --untracked-files=all` (devlog 유닛 경로만).

## 진입 시점 하드 상태 (증거)

```
origin/dev  dbed8c15..3fac781f  (fast-forward, 4 files: issue-quality CI)
dev CI      최신 머지 커밋까지 success (run 30135102878 / 30135102870)
인벤토리    위 매니페스트 참조 (PR 23 / Issue 22, snapshot 2026-07-25T01:05:24Z)
```

Wibias 완료선언 5건의 정성적 요지 (수치 증거는 `010`의 PR 행 스키마가 SSOT):

| PR | 선언과 실제 |
|----|------------|
| #423 | **이미 MERGED** (2026-07-24T23:57:05Z) — 선언 시점에 이미 완료 → `ALREADY_MERGED` |
| #402 | mergeable, CI 대부분 green이나 exact-head 잔여 job 미완 + 사람 리뷰 0건 |
| #408 | mergeable, CI green이나 UAC 권한상승 경계 → 보안 리뷰 필수 |
| #392 | mergeable, CI green, CHANGES_REQUESTED + 응답커밋 있음 → 재리뷰 필요 |
| #391 | **선언 불일치** — 3 플랫폼 CI FAIL + CHANGES_REQUESTED 미해소 |

> A-gate 3회차 지적 반영: 이전 판의 고정 CI 카운트 표(13/13, 12/12, 9/9)는 캡처 시각과
> run URL이 없어 검증 불가능한 stale 주장이었으므로 삭제했다. 모든 수치 증거는 `010`에
> 단일 캡처 시각과 head SHA를 붙여 기록한다(증거 행 스키마).

`#391` 실패 실체 (run `30119868825`, ubuntu/macos/windows 동일):

```
3 tests failed:
(fail) subagent model fallback chain > selectAvailableSubagentModel skips cached routed failures
(fail) subagent model fallback chain > selectAvailableSubagentModel skips stale fallback entries that cannot route
(fail) subagent model fallback chain > selectAvailableSubagentModel allows raw slash model ids without provider namespaces

tests/subagent-model-fallback.test.ts:96:28
  expect(selected.model).toBe("kimi/k3");
  → expected "kimi/k3", received "gpt-5.6-sol"
```

## Open assumptions

- A1: Wibias의 "완료" 선언은 #423 머지 + 나머지 4건 리뷰응답 푸시를 가리킨 것으로 해석한다.
  #391의 red CI를 인지하지 못한 것으로 보이며, 이는 판정에 반영하되 비난 없이 기술한다.
- A2: 최종 머지/클로즈 실행 권한은 사용자에게 있다. 본 유닛은 결정까지만 산출한다.
