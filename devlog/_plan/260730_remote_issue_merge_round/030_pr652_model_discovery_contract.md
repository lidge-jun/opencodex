# 030 — wp3: PR #652 랜딩 (bounded model discovery contract)

## 목표

PR #652를 `dev`에 머지하고 엄브렐라 이슈 #572는 **열어둔다**. 코드 패치 없는
검증·랜딩 work-phase다.

## 현재 상태 (실측)

```
PR #652  head a7ae3970  base dev  non-draft
mergeStateStatus CLEAN   reviewDecision APPROVED
author olddonkey  commits 5  +1332/-124  23파일
branch codex/572-model-discovery-contract
```

체크 (`check-runs` on `a7ae3970`) — 9개 전부 `success`:
enforce-target, label, macos-latest, ubuntu-latest, windows-latest,
npm-global ×3, react-doctor.

열린 PR 24건 중 **유일하게 CLEAN + APPROVED + 전체 green**이다.

## 내용 요약

엄브렐라 #572의 phase 1. 레지스트리 소유 live model discovery 계약:

- 엔드포인트 URL/path/query 정책과 선언적 eligibility 필터
- 파싱·캐싱 전 응답 바운딩: 프로세스 전역 상한 **4 MiB / 2,000 rows**
  (레지스트리 엔트리는 낮출 수 있고 **올릴 수 없다**)
- `redirect: "error"` — 자격증명이 리다이렉트를 따라 다른 목적지로 가지 못한다
- fetch 전 `providerDestinationResolvedError` 목적지 정책 검사
- fixed OAuth 프리셋의 OAuth 호스트 피닝
- 동명 custom provider 충돌 보존 — 새로 승격된 provider id가 기존 동명 custom
  provider와 저장된 키를 조용히 가로채지 못하게 방어
- 실패 시 stale/static 폴백과 관측 가능한 discovery status 보존

`#653` Baseten 배치의 **선행 기반**이다. 그래서 이 라운드에서 #653보다 먼저 랜딩한다.

## 리뷰 지적 처리 상태

| 출처 | 지적 | 상태 |
|------|------|------|
| Codex | `src/codex/catalog/provider-fetch.ts`, `src/providers/model-discovery.ts:156`, `src/server/management/provider-routes.ts` 3건 | 작성자가 `4e8e7d5`에서 항목별 응답·처리 |
| CodeRabbit | `src/oauth/index.ts:763-777` 네임스페이스 검증/설정 쓰기 원자성 (Major) | outside-diff 지적. 기존 `saveConfig` 원자성 범위 문제 |
| CodeRabbit | `src/server/auth-cors.ts:321-353` `safeConfigDTO`에서 `provider.note` 누락 (Minor) | **이 PR의 회귀 아님** |

`provider.note` 확인 결과: `dev`의 현재 `src/server/auth-cors.ts`도 고정 allowlist만
복사하며 레지스트리 노트만 반영한다. 기존 결함이므로 이 PR의 머지 차단 사유가 아니고,
별도 이슈로 분리하는 것이 맞다.

`src/oauth/index.ts` 원자성 지적은 cross-process lock 도입을 요구하는 heavy lift이며,
이 PR이 새로 만든 문제가 아니라 기존 check-then-write 패턴에 대한 지적이다. 별건.

## 보안 리뷰 (MAINTAINERS.md 요구)

OAuth·자격증명 경로를 건드리므로 명시적 보안 리뷰 대상이다. `Wibias`가 tip
`169e6374`에 대해 리뷰를 남겼고 확인 항목은:

- 자격증명이 리다이렉트를 따라가지 않음 (catalog + probe 모두 `redirect: "error"`)
- probe와 catalog 모두 fetch 전 `providerDestinationResolvedError` 실행
- 레지스트리 `modelDiscovery` / preset 신뢰 정책이 영속 config로 복사되지 않음

판정: `APPROVED`. 우리 쪽에서 추가로 확인할 것은 **head가 리뷰 당시와 다른지**다.
Wibias의 승인은 `169e6374`에 기록됐고 현재 head는 `a7ae3970`이므로 **승인 시점 ≠ 현재
tip**이 맞다(감사 확인). MAINTAINERS.md 기준으로 머지 전에 답이 필요하다.

단, 초판이 적은 "`169e6374..a7ae3970` diff만 검토"는 규모를 오해한 지시였다. 감사가
실측한 결과 그 범위는 **38커밋 / 약 150파일**이고 `src/lib/pinned-http.ts`(+151),
`src/server/management-auth.ts`(+216), `src/lib/config-ownership.ts`(+327),
`src/server/auth-cors.ts`(+90/-19) 등을 포함하며 머지 커밋
`a7ae3970 "merge(dev): integrate provider outbound hardening"`도 들어 있다.
대부분은 **`dev`가 브랜치로 머지되어 들어온 것**이지 PR 저작 변경이 아니다.

올바른 측정 방법 (블로커 6 반영):

```bash
# PR 저작 커밋만 분리 — merge-base 기준
base=$(gh api repos/lidge-jun/opencodex/pulls/652 --jq '.base.sha')
git fetch origin dev
git log --oneline --no-merges $(git merge-base "$base" a7ae3970)..a7ae3970 -- src/

# 또는 승인 시점 대비 PR 저작분의 변화만
git range-diff 169e6374...a7ae3970

# 보안 표면만 좁혀서 확인
git diff 169e6374..a7ae3970 -- src/oauth src/providers/model-discovery.ts \
  src/server/management src/lib/pinned-http.ts | head -200
```

판단 기준: Wibias가 확인한 3개 불변식(자격증명이 리다이렉트를 따라가지 않음, fetch 전
destination policy, 레지스트리 신뢰 정책 비복사)이 현재 tip에서도 유지되는지만 확인하면
승인을 재사용할 수 있다. 150파일 전수 재리뷰는 필요하지 않다 — 측정 방법의 문제였다.

## 실행 계획

1. head SHA와 체크를 다시 실측 (스냅샷이 하루 지났을 수 있음)
   ```bash
   gh pr view 652 --json headRefOid,mergeStateStatus,reviewDecision,mergedAt
   gh api "repos/lidge-jun/opencodex/commits/<head>/check-runs?per_page=40" \
     --jq '.check_runs[]|[.name,.conclusion]|@tsv' | sort
   ```
2. 위 "올바른 측정 방법"으로 PR 저작분을 분리하고, 보안 3불변식이 현재 tip에서
   유지되는지 확인한다. `dev` 머지로 들어온 변경은 이미 `dev`에서 검증된 것으로 취급한다.
3. squash 머지
   ```bash
   gh pr merge 652 --squash --delete-branch=false
   ```
4. #572가 열려 있는지 확인 — PR 본문이 "umbrella issue must remain open"을 명시
   ```bash
   gh issue view 572 --json state    # OPEN 이어야 한다
   ```
5. 머지 후 로컬 `dev`를 fast-forward하고 `bun x tsc --noEmit`으로 통합 상태 확인

## 수용 기준

- `gh pr view 652` → `mergedAt` non-null
- `gh issue view 572` → `state: OPEN`
- 머지 후 로컬 `dev`에서 `tsc` exit 0
- `provider.note` / `oauth` 원자성 건이 별도 후속으로 기록됨 (D 요약)
- 보안 3불변식이 현재 tip에서 유지됨을 확인한 증거 (명령 출력)

## 범위 경계

- IN: #652 검증·머지, #572 열림 확인, 후속 항목 기록
- OUT: `provider.note` 수정, `src/oauth/index.ts` 원자성 리팩터, #653 Baseten 머지,
  다른 provider 배치 승격. 전부 후속 work-phase 후보이며 이 사이클에서 다루지 않는다.
