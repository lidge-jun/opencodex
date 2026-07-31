# 050 — WP5: #169→#171 리베이스 충돌 해소 가이드

## 목표 산출물

#169가 main에 머지된 상태를 가정하고 #171을 리베이스/머지할 때 발생하는
content conflict 3파일의 구체적 해소안. 기여자(Wibias) 또는 maintainer가
그대로 따라 할 수 있는 가이드 문서.

## 절차 (쓰기는 /tmp 스크래치뿐)

> **NOTE (A-gate fold #7):** 원래 `FETCH_HEAD@{0}` 구문은 reflog selector라
> multi-fetch 후 유효하지 않음. SHA를 명시적으로 보존하는 절차로 교체.

```
git worktree add /tmp/ocx-merge-sim origin/main --detach
cd /tmp/ocx-merge-sim
git fetch origin pull/169/head
pr169=$(git rev-parse FETCH_HEAD)
git fetch origin pull/171/head
pr171=$(git rev-parse FETCH_HEAD)
git merge --no-ff "$pr169"              # 169를 main 위에 머지 (충돌 없어야 함)
git merge --no-commit --no-ff "$pr171"  # 충돌 3파일 재현
```

## 충돌 3파일 해소 지침 (양쪽 의도 보존 원칙)

1. `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx`:
   169 = Rate Limits/Recently Used 나란히 + overview 폴리시, 171 = needs-setup
   amber + reauth CTA + attention 배너. 해소: 169의 레이아웃 구조를 유지한
   채 171의 상태 배지/CTA 조각을 해당 컴포넌트에 삽입. i18n 키는 양쪽 추가분
   모두 유지.
2. `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`:
   169 = 뷰 지속성(localStorage/hash) + 레일 복구, 171 = reauth 상태 표기
   + 배너 와이어링. 해소: 169의 지속성 로직 베이스 + 171의 reauth props
   전달 체인 병합.
3. `gui/src/pages/Providers.tsx`: 169 = workspace 패리티 복구분,
   171 = reauth 모달 상태 추가. 해소: 상태 훅 양쪽 모두 유지, 모달 렌더
   분기에서 reauthAccountId 유무로 AddCodexAccountModal 모드 선택.

실제 conflict hunk를 열어 위 원칙을 hunk별 수용안(ours/theirs/수동 병합)으로
구체화하는 것이 이 사이클의 B 작업이다. 해소 후:

```
cd gui && bun x tsc --noEmit    # 병합 결과 타입 정합
bun test tests/provider-workspace-state.test.ts tests/provider-workspace-auth.test.ts
```

## 가이드 문서 형식

`devlog/_plan/260720_pr_queue_merge_review/051_conflict_resolution.md`에
파일별로: 충돌 hunk 요약, 수용안, 검증 명령. 완료 후
`git worktree remove --force /tmp/ocx-merge-sim`로 스크래치 정리(티어다운
증거를 C에 기록).

## C-ACTIVATION-GROUNDING-01 시나리오 (A-gate fold #9)

WP5는 코드 변경이 아닌 머지 시뮬레이션이므로 activation = 해소된 worktree에서
`cd gui && bun x tsc --noEmit` + `bun test tests/provider-workspace-state.test.ts
tests/provider-workspace-auth.test.ts` 실행. 이 테스트는 레이아웃/hash/reauth
CTA **결합** 동작까지는 커버하지 않으므로(source-string wiring 수준), 3파일의
실제 결합 품질은 "해소 가이드에 대한 maintainer의 수동 검증" 또는 후속
browser QA로 위임됨을 verdict에 명시한다.

## 판정 규칙

- 3파일 해소안 + tsc/테스트 그린 → criteria met.
- 해소가 단순 병합으로 불가(설계 충돌) → 가이드에 "재작성 필요" 판정과
  어느 쪽 PR을 고쳐야 하는지 명시.

---

## Verdict (WP5 결과) — 해소 가이드 완성

sol worker Carver(gpt-5.6-sol priority): 18 hunks 해소, 충돌 마커 0,
unmerged 0, `git diff --check` exit 0, `tsc --noEmit` exit 0.

### 머지 시뮬레이션 요약

```
origin/main = 3f04819
pr169 merged first → exit 0 (충돌 없음, GitHub MERGEABLE 일치)
pr171 merge → exit 1, 3 conflicted files, 18 hunks:
  - ProviderOverviewDashboard.tsx: 4 hunks
  - ProviderWorkspaceShell.tsx: 2 hunks
  - Providers.tsx: 12 hunks
```

### 해소 원칙

양쪽 의도 보존: #169의 workspace 패리티(JSON-editor, layout, model-refresh)와
#171의 reauth 상태(amber attention UI, account-targeted reauth, hardened OAuth
polling)를 모두 유지.

### 검증

해소 후 `tsc --noEmit` exit 0, conflict marker 0, unmerged 0.
상세 hunk별 해소안: `.codexclaw/evidence/2026-07-20-wp5-pr169-pr171-merge-simulation.md`.

### 한계

tsc 타입 정합만 검증됨. 레이아웃/hash persistence/reauth CTA 결합 동작의
런타임 품질은 머지 후 browser QA 또는 수동 검증 필요.
