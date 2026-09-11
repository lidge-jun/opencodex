# 260904 우선순위 65+ 종결 — 리서치

base `origin/dev` = `2421e44ce` (package 2.43.0), 작업 브랜치 `codex/priority65-closeout`,
워크트리 `/Users/jun/.codex/worktrees/f96c/opencodex`.

## 선정 근거

메인테이너가 이슈/PR 코멘트에 남긴 `## 리뷰 · 우선순위 NN / 80` 점수를 GraphQL로
전수 수집해 65점 이상만 추렸다. 이슈 8건, PR 13건이 나왔고, 5개 read-only 조사
레인이 각 항목을 현재 dev 코드에 대조해 판정했다.

수집 명령(재현 가능):

```
gh api graphql --paginate -f query='...issues(states: OPEN)...comments(first: 40)...' \
  --jq '... capture("우선순위 (?<s>[0-9]+) / 80").s | tonumber ...' | sort -rn
```

## 판정 결과

| ID | 점수 | 판정 | 근거 |
|----|------|------|------|
| #3375-D | 72 | CLEAR_FIX | 원장 완비, 프로덕션 호출자 0개 |
| #3259 | 72 | 경계만 CLEAR | 스키마 loose 폴백이 타입 계약을 깸 |
| #3464 | 71 | CLEAR_BUT_LARGE | `buildPlist`에 launcher 분기 없음 |
| PR #3251 | 71 | 게이트만 | 코드 정확, 스크린샷 누락 |
| PR #3461 | 70 | CLEAR_FIX | 좁은 매처, 기존 단정 보존 |
| PR #3348 | 71 | BLOCKED | 410/413 hop blocker 잔존 |
| PR #3329 | 71 | NEEDS_DESIGN | 쿨다운 우선순위 무단 역전 |
| PR #3389 | 68 | NEEDS_DESIGN | zero-output 전제가 실험으로 반증 |
| PR #3327 | 68 | 게이트만 | 테스트 전용, 스크린샷 게이트 오탐 |
| PR #3332 | 67 | carry 필요 | OUTPUT을 INPUT 필드에 매핑 |
| PR #3061 | 72 | REJECT | #3351이 상위 구현을 이미 랜딩 |
| #3245 | 66 | BLOCKED | 실패 지점이 첫 POST 이전 |
| #3425 | 70 | NEEDS_DESIGN | 이전 REJECT 유효, 새 용의자도 반증됨 |

## 이번 유닛이 다루는 것

판정이 CLEAR이거나, 게이트 하나만 남았거나, CRUD/UX 규칙으로 결정 가능한 것만
가져간다. 설계 결정이 선행하는 항목(#3329, #3389, #3348, #3425, #3376, #3377,
#3447 Antigravity 절반)은 이 유닛의 범위 밖이고, 각각 근거를 이슈/PR에 남긴다.

## work-phase 맵

골플랜 `.codexclaw/goalplans/65-stacked-pr-close-co-authored-by-exact-head-ci/goalplan.json`의
work-phase와 이 유닛의 문서가 아래처럼 대응한다.

| wp | 대상 | 문서 |
|----|------|------|
| wp1 | Phase-0 docs-only 로드맵 | 이 유닛 전체 (이 사이클의 산출물) |
| wp2 | #3259 responses 경계 | `010_wp2_responses_boundary.md` |
| wp3 | #3332 carry | `020_wp3_combo_metadata_carry.md` |
| wp4 | #3461 스쿼시 머지 | `030_wp4_combo_context_cap.md` |
| wp5 | #3375-D reset-credit identity | `040_wp5_reset_credit_identity.md` |
| wp6 | #3251 / #3327 게이트 해제 | `050_wp6_gate_unblock.md` |
| wp7 | #3379 롤백 저널 삭제 CRUD | `060_wp7_rollback_journal_crud.md` |
| wp8 | 처분 기록 + 최종 회귀 증명 | `070_wp8_dispositions_and_regression.md` |

wp1은 자기 자신이 산출물이므로 decade 문서를 따로 갖지 않는다. 나머지 일곱 개는
각각 하나의 decade 문서를 소비하는 한 번의 PABCD 사이클이다.

## 구속 조건

- 로컬 전체 스위트 금지. `bun run test`와 인자 없는 `bun test` 모두 이 유닛에서
  실행하지 않는다. focused `bun test tests/<name>.test.ts`와 라이브 GitHub CI가
  검증자다.
- push는 `--no-verify`.
- 타 기여자 작업을 carry/재구현/스쿼시할 때 `Co-authored-by` 트레일러가 스쿼시
  뒤에도 남아야 한다. 산문 크레딧은 등가물이 아니다 (AGENTS.md
  `missing_coauthor_credit`).
- `dev`는 이 세션 중에도 움직일 수 있다. 머지 직전마다 `git fetch origin dev`로
  head를 다시 읽고 ancestry를 재확인한다.

## 검증자 사전 확인 (PLAN-VERIFIER-REAL-01)

| 커맨드 | exit | 변경 대상을 읽는가 |
|--------|------|--------------------|
| `bun run typecheck` | 0 | 예 — `tsconfig.json`이 `src/`, `tests/` 전체를 include |
| `bun test tests/<name>.test.ts` | 파일별 | 예 — 대상 파일을 직접 인자로 받음 |
| `gh pr checks <n>` | 상태별 | 예 — PR head SHA의 체크 롤업 |
