# 030 — WP3: PR 처분

근거: `002_pr_triage_matrix.md`

## WP3 실행 시점 상태 재조회 (2026-07-27, WP2 종료 후)

WP0에서 매트릭스를 쓴 뒤 두 건이 움직였다. 판정을 실행 전에 다시 확인한 결과다.

| PR | WP0 판정 | 실제 결과 | 일치 |
|----|----------|-----------|------|
| 529 | MERGE-READY | 2026-07-27T07:59Z 머지됨 | 예 |
| 536 | NEEDS-RETARGET | 07:53Z 종결 → **재개 후 `dev`로 리타깃** (08:52Z) | 예 (판정대로 리타깃됨) |

> **#536 후속 (WP4 시점 재확인).** 한 번 닫혔다가 다시 열렸고 base가 `dev`로 바뀌었다.
> 워크플로 복원 경로가 정상 동작해 `[WRONG BRANCH]` 제목 접두사가 제거되고 상태 코멘트가
> `active:false`로 갱신됐다. 현재 `OPEN base=dev UNSTABLE`. WP0의 NEEDS-RETARGET 판정이
> 결과적으로 맞았다.

열린 PR은 17건 → **15건**. 추가 변동:

- **#528** `UNKNOWN` → `MERGEABLE/CLEAN`, base=`dev`. 의존하던 #424가 아직 열려 있으나
  머지 가능 상태가 됐다. 다만 본문이 "#424를 먼저 머지하라"고 명시하므로 순서 판정은 유지한다.
- **#461**, **#429**가 `DIRTY`(충돌)로 전환됐다. `dev`가 그동안 여러 번 움직인 결과다.
  작성자 리베이스가 필요하다.
- **#533** head가 `314eb53a` → `ed7ca3f6`로 갱신됐다. 작성자가 계속 작업 중이라는 뜻이다.

## 권한 경계 (먼저 확정)

이번 루프에서 사용자가 승인한 것은 **`dev` 푸시(#539 수정)** 한 건이다. 따라서:

| 행위 | 이번 루프에서 | 이유 |
|------|---------------|------|
| PR 판정 + 문서화 | **한다** | 사용자가 "트리아지하고 닫는 계획"을 요청 |
| 자기 소유 임시 PR 종결 | **한다** | 외부 기여자에게 영향 없음 |
| 타 기여자 PR 종결 | 하지 않는다 | draft+CHANGES_REQUESTED는 작업 중이라는 뜻 |
| PR 머지 | 하지 않는다 | 승인 범위 밖. 별도 승인 필요 |
| fork CI 승인 | 하지 않는다 | fork 코드를 CI 러너에서 실행시키는 보안 결정 |

## 실행 항목 1: #455 종결

대상: `[WRONG BRANCH] chore: temporary verification export trigger`

종결 근거:

- 소유자가 `lidge-jun`(자기 소유) — 외부 기여를 가로채지 않는다
- 제목과 본문이 스스로 일회성 임시 검증용임을 명시
- `mergeStateStatus=DIRTY` (충돌) + `+69609/-275` — 머지 경로가 없다
- 해당 검증 목적이 종료됨 (아래 확인 결과)

**종결 사유에서 제외할 것 (WP3 감사).** `[WRONG BRANCH]` 제목을 근거로 쓰면 안 된다.
`d761e880 ci: let pull requests target dev2-go, not just dev`가 `ALLOWED_BASES`를
`["dev", "dev2-go"]`로 넓혔으므로 `dev2-go` 타깃은 더 이상 위반이 아니다. 그 제목은
커밋 이전에 붙은 잔재다. 잘못된 사유로 닫으면 기록이 오도된다.

### 실행 전 확인 결과 (완료)

`dev2-go`가 이 export를 아직 필요로 하는지 확인했다. 결론: 필요 없다.

```
$ git log -1 --format='%ci %s' origin/dev2-go
2026-07-27 09:37:06 +0900 docs(plan): record WP4 release-gate verification receipt

최근 커밋: 65442a1f fix(release): align embedded GUI with the published tarball
          9aeaaeca fix(release): gate dry-run, Go CI, and embedded GUI
```

`dev2-go`는 활발히 진행 중이고 **릴리스 게이트 검증 영수증까지 기록**했다. 즉 PR #455가
존재 이유로 삼은 "로컬 샌드박스 검증용 Go 툴체인/vendored 모듈 export"는 이미 목적을
달성했다. PR 본문 자체가 "취득 직후 닫고 임시 ref를 리셋하겠다"고 명시한다.

현재 상태(2026-07-27 재조회): `CONFLICTING/DIRTY`, head `88a83f28`, 마지막 갱신
2026-07-27T00:41Z. `+69609/-275`.

코멘트 문안:

> Closing: this was a one-shot export trigger to verify the `dev2-go` release-asset
> path, and that verification is done — `dev2-go` has since recorded its release-gate
> receipt (`aadba2c2`). The branch is conflicted against its base and carries a 69k-line
> diff that was never meant to merge.
>
> (The `[WRONG BRANCH]` prefix predates `d761e880`, which added `dev2-go` to the allowed
> bases — it is stale, not the reason for closing.)
>
> Re-trigger from a fresh branch if the export ever needs another run.

**후속 단계.** `tmp/dev2-go-source-export` 브랜치도 삭제한다. 남겨 두면 임시 워크플로가
브랜치에 실려 있어 이후 PR이 툴체인 export를 다시 트리거할 수 있다. 단, 브랜치 삭제는
PR 종결과 별개의 원격 상태 변경이므로 별도로 확인하고 실행한다.

## 실행 항목 2: #526 → #527 스택 순서 판정

판정만 하고 머지하지 않는다.

```
#526  base=dev   head=1ba588ef   CLEAN, CI 통과, +86/-14
  └─ #527  base=codex/catalog-written-signal   head=a64aa585   enforce-target FAIL
```

### 자동 리타깃 전제는 거짓이다 (A단계 감사 정정)

초안은 "#526을 머지하면 GitHub가 #527의 base를 `dev`로 자동 재지정한다"고 적었다.
**틀렸다.** GitHub는 head 브랜치가 머지되고 **삭제될 때만** 그 브랜치를 base로 삼은
PR을 재지정한다. 이 저장소는 그렇게 설정되어 있지 않다:

```
gh api repos/lidge-jun/opencodex --jq '.delete_branch_on_merge'
  → false
```

따라서 #526을 머지해도 #527은 `codex/catalog-written-signal`을 base로 유지하고 검사
상태도 그대로다. 초안대로 코멘트를 달았다면 작성자에게 "아무것도 하지 마라"고 지시하면서
PR은 계속 막혀 있는 결과가 됐다.

정정된 권고 순서:

1. `#526`을 `dev`에 머지한다(메인테이너 결정, 이번 루프 범위 밖).
2. `#527`의 base를 `dev`로 **수동 리타깃**한다 — 또는 머지 후 head 브랜치를 삭제해
   자동 재지정을 유발한다.
3. 리타깃하면 `enforce-target`은 **통과한다**(WP3 감사에서 정정). 워크플로는 base가
   허용 목록에 있으면 draft 전환 자체를 시도하지 않고, 실패하던 GraphQL 뮤테이션은
   그때만 호출되기 때문이다. 실측 선례: #536이 `dev`로 리타깃된 뒤
   `feat/glm-provider` 실행(30250881926, 30250880040)이 success다.

초안은 3번을 "리타깃해도 여전히 실패한다"고 적었으나 틀렸다. 권한 결함은 **ready 상태 +
허용되지 않은 base** 조합에서만 드러난다. 이미 draft인 PR이나 리타깃된 PR은 영향받지 않는다.

## 실행 항목 3: 버그성 PR의 결함 실재 여부 검증

### 최근 변화가 무효화한 항목 (WP3 감사)

`e7d144fc`(2026-07-27T07:56Z, PR 없이 `dev` 직접 푸시)가 열린 작업 하나를 무효화했다.

- **이슈 #538** (per-model `reasoning_summary_delivery` 정규화)이 이미 **CLOSED**다.
  `e7d144fc`가 `src/config.ts`에 `reasoningSummaryDeliveryRecordConfigError`를,
  `src/types.ts`에 `stream_options.reasoning_summary_delivery` 모델별 값을 추가하며
  구현했다. `001` 매트릭스의 ROADMAP 판정은 실행 시점에 이미 낡았다.

열린 PR 중 이 커밋으로 무효화된 것은 없다. `e7d144fc`가 건드린 `src/claude/desktop-3p.ts`와
`src/server/management/agent-settings-routes.ts`는 열린 PR이 아니라 **WP1의 로컬 커밋
`48b985d0`과 충돌**한다(사용자 결정 대기).

또한 신규 PR **#544**(`fix(gui): give every OAuth login surface the same copy affordance`,
base `dev`)가 열렸다. 병행 세션 작업물이며 이번 트리아지 범위 밖이다.

"버그 수정 PR"이라고 주장하는 것들이 실제 결함을 고치는지 코드로 확인한다. 판정만 기록.

| PR | 주장하는 결함 | 검증 방법 |
|----|---------------|-----------|
| 526 | sync가 no-op인지 실제 쓰기인지 구분 불가 | `syncCatalogModels()` 현재 반환 타입 확인 |
| 533 | npm 캐시 EACCES 시 프록시가 정지된 채 방치 | 실장애 재현 기록 존재. 보안 리뷰 대상이라 판정만 |
| 429 | Cursor가 사용자 프롬프트에 셸 alias 힌트 주입 | 주입 코드 경로 존재 확인 |
| 447 | Kiro 멀티계정 브라우저 로그인 미지원 | 인증 경계 — 판정만 |
| 491 | OAuth 로그인이 저장된 API 키 삭제 | 인증 경계 — 판정만 |

보안 경계(인증/토큰/OAuth/의존성 설치)에 걸리는 것은 `MAINTAINERS.md`상 명시적 보안
리뷰 대상이다. 이번 루프는 "결함이 실재하는가"까지만 판정하고 머지 판단은 하지 않는다.

## 수용 기준

- 17건 전부가 분류되고 각 판정에 근거가 있다
- 실제 처분한 PR은 종결 근거 코멘트를 동반한다
- 처분하지 않은 PR은 왜 하지 않았는지가 기록된다
- 권한 경계를 넘은 행위가 0건이다
