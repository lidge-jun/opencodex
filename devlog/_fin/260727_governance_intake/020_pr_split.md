# 020 — 대상 PR 두 개로 분할 (diff-level)

WP3 · 근거: `000_survey.md`, PR #518 파일/커밋 실측

## 분할 대상 선정

ready PR 목록은 계속 바뀐다 — 이 문서를 쓰는 동안 #522가 머지되고 #525가
새로 열렸으며, #518의 상태도 `UNSTABLE`에서 `CLEAN`으로 바뀌었다. 그래서
후보는 실행 직전에 재조회한다:

    gh pr list --repo lidge-jun/opencodex --state open \
      --json number,isDraft,mergeStateStatus \
      --jq '.[] | select(.isDraft==false)'

**선정 기준은 상태가 아니라 구조다:** 한 PR 안에 독립적으로 검증 가능한
두 관심사가 들어 있고, 그중 하나가 위험도가 확연히 높을 때 쪼갠다. #518이
여기 해당한다(프로세스 종료 vs 순수 신호 전달). 단일 기능 PR은 쪼개면
리뷰 비용만 늘어난다.

살아있는 PR의 절대 수치는 문서에 박지 않는다 — 2차 감사 시점 `+1193/10커밋`이
3차 감사 시점에 `+1245/11커밋`으로 바뀌었다. 분할 직전에 재조회한다:

    gh api repos/lidge-jun/opencodex/pulls/518 --jq '{additions,deletions,changed_files,commits}'

**대상은 #518**로 확정한다. 두 관심사가 섞여 있고 그중 하나가 다른
프로세스에 SIGTERM을 보낸다.

## #518이 왜 두 개인가

PR 제목은 "warn or restart stale app-server after sync"인데, 실제 diff는
서로 독립적으로 검증 가능한 두 덩어리다.

### 덩어리 A — 프로세스 탐지/종료 (위험한 쪽)

    src/codex/app-server-processes.ts   +488  (신규)
    src/cli/index.ts                    +13/-2
    src/cli/help.ts                     +19/-4
    tests/codex-app-server-processes.test.ts  +349 (신규)
    docs-site/.../reference/cli.md      +10/-3
    docs-site/.../guides/codex-integration.md +5

`--restart-codex` 플래그로 **다른 프로세스에 SIGTERM을 보낸다**. PR 커밋
이력을 보면 이 부분에만 리뷰 지적이 네 번 붙었다:

    95a9bf91 harden app-server identity checks from CodeRabbit
    56104a5a use Invoke-CimMethod for Windows process owner lookup
    06316183 detect quoted app-server paths and gate sync-cache restarts
    8d2292bf honor value-taking globals before app-server match

프로세스 매칭이 틀리면 남의 프로세스를 죽인다. UID 스코프, 인용부호 경로,
값을 받는 글로벌 플래그 처리가 전부 이 위험을 막는 코드다.

### 덩어리 B — catalogWritten 신호 (안전한 쪽)

    src/codex/catalog/sync.ts           +10/-5
    src/codex/refresh.ts                +7/-3
    src/codex/sync.ts                   +5
    src/server/management/config-routes.ts +4/-4
    gui/src/pages/dashboard-overview-sections.tsx +2/-1
    gui/src/i18n/*.ts                   6파일 각 +1/-1
    tests/codex-models-cache-invalidate.test.ts +203 (신규)
    tests/codex-refresh.test.ts         +57/-4
    tests/codex-sync-api.test.ts        +5
    tests/injection-model-api.test.ts   +2/-2

`syncCatalogModels`가 `catalogWritten: boolean`을 반환하고,
`invalidateCodexModelsCache()`가 `void` → `boolean`으로 바뀐다.
GUI는 그 신호로 stale 힌트를 띄운다. 프로세스를 건드리지 않는다.

## 분할 방식

B가 A의 전제다 — A의 재시작 게이트가 `catalogWritten`을 읽는다
(커밋 `052015e6 gate app-server restart on catalogWritten`). 따라서
**B를 먼저, A를 그 위에** 쌓는다.

    PR-1 (B):  dev  ← codex/catalog-written-signal
    PR-2 (A):  PR-1 ← codex/app-server-restart

PR-2의 base를 PR-1로 두면 리뷰어가 A의 diff만 보게 된다. PR-1이 머지되면
PR-2는 자동으로 dev를 base로 재타겟된다.

### 분리 절차

먼저 **원본 head SHA를 고정하고, 이후 모든 입력을 그 SHA에서만 뽑는다.**
SHA를 읽은 뒤 파일 목록과 브랜치를 각각 따로 조회하면, 그 사이 force-push가
나면 manifest와 작업 브랜치가 서로 다른 head를 가리킨다. 사후 재확인은
잘못 만든 뒤에야 알려줄 뿐이다.

    SRC=$(gh pr view 518 --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)

    # SHA 자체를 가져온다 — pull/518/head는 움직이지만 $SRC는 움직이지 않는다.
    # 실측 확인: GitHub은 임의 커밋 SHA fetch를 허용한다
    #   (`* branch <sha> -> FETCH_HEAD`).
    git fetch origin "$SRC"
    git switch -c pr518-frozen FETCH_HEAD

    # manifest도 API가 아니라 고정된 커밋에서 뽑는다.
    git diff --name-only origin/dev..."$SRC" | sort > /tmp/pr518-manifest.txt
    git switch -c codex/catalog-written-signal origin/dev
    # B에 해당하는 경로만 고정 SHA에서 가져온다 (커밋 단위로 안 갈라짐)
    git checkout "$SRC" -- src/codex/catalog/sync.ts src/codex/refresh.ts \
      src/codex/sync.ts src/server/management/config-routes.ts \
      gui/src/pages/dashboard-overview-sections.tsx gui/src/i18n \
      tests/codex-models-cache-invalidate.test.ts tests/codex-refresh.test.ts \
      tests/codex-sync-api.test.ts tests/injection-model-api.test.ts

### 혼재 확인 결과 (실측)

경로 단위 체크아웃이 통하는지 `gh pr diff 518`로 hunk를 직접 확인했다.

| 파일 | 판정 |
| --- | --- |
| `src/codex/refresh.ts` | **순수 B.** `catalogWritten` 필드와 `cacheSynced = deps.invalidateCodexModelsCache()` 뿐. 프로세스 코드 없음 |
| `src/codex/catalog/sync.ts` | 순수 B |
| `src/codex/sync.ts` | 순수 B |
| `src/cli/help.ts` | **순수 A.** `--restart-codex` 플래그 문서화만 |
| `src/cli/index.ts` | **혼재.** 아래 참조 |

`src/cli/index.ts`의 두 hunk(`case "sync"`, `case "sync-cache"`)는 B가 만든
신호를 읽어 A를 호출하는 구조라 한 덩어리로 붙어 있다:

    if (syncResult.catalogWritten || syncResult.cacheSynced) {
      const { afterCatalogWriteHandleAppServers } = await import("../codex/app-server-processes");
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
    }

즉 이 파일은 **경로 단위로 나눌 수 없다.** B에는 `catalogWritten`을
읽는 부분이 필요 없고(신호를 만들기만 함), A가 그 신호를 소비한다.

따라서 `src/cli/index.ts`와 `src/cli/help.ts`는 **전부 PR-2(A)로 보낸다.**
PR-1(B)은 `src/cli/index.ts`를 건드리지 않는다.

`CodexSyncResult`에 필수 필드 `catalogWritten: boolean`을 추가하는 것은
엄밀히 말해 그 인터페이스를 **생성하거나 구현하는** 코드에는 breaking이다.
정확한 근거는 "하위 호환"이 아니라 저장소 안에서 그 객체를 실제로 구성하는
곳이 `src/codex/sync.ts` 하나뿐이고 나머지 호출자는 속성을 읽기만 한다는
사실이다. 다만 이는 **가설이며, B 브랜치가 아직 없으므로 증명되지 않았다.**
수용 기준 1의 단독 typecheck가 그 증명이다.

수정된 체크아웃 목록 (B):

    git checkout "$SRC" -- src/codex/catalog/sync.ts src/codex/refresh.ts \
      src/codex/sync.ts src/server/management/config-routes.ts \
      gui/src/pages/dashboard-overview-sections.tsx gui/src/i18n \
      tests/codex-models-cache-invalidate.test.ts tests/codex-refresh.test.ts \
      tests/codex-sync-api.test.ts tests/injection-model-api.test.ts

A는 나머지 전부: `src/codex/app-server-processes.ts`, `src/cli/index.ts`,
`src/cli/help.ts`, `tests/codex-app-server-processes.test.ts`,
docs-site 2개 파일.

## 수용 기준

1. `codex/catalog-written-signal`(B) 브랜치에서 `bun run typecheck` exit 0.
   이것이 "B 단독으로 컴파일된다"는 증명이다.
2. B 브랜치에서 `bun test tests/codex-models-cache-invalidate.test.ts
   tests/codex-refresh.test.ts tests/codex-sync-api.test.ts
   tests/injection-model-api.test.ts` 전부 통과.
3. B 브랜치 diff에 `src/codex/app-server-processes.ts`, `src/cli/index.ts`,
   `src/cli/help.ts`가 **없다**
   (`git diff --name-only origin/dev...codex/catalog-written-signal`).
4. `codex/app-server-restart`(A) 브랜치에서 typecheck exit 0 +
   `bun test tests/codex-app-server-processes.test.ts` 통과.
5. 두 브랜치 diff의 파일 합집합이 고정된 `$SRC` 시점의
   `/tmp/pr518-manifest.txt`와 정확히 일치.
6. 분할 완료 시점에 `gh pr view 518 --json headRefOid`가 여전히 `$SRC`다.
   달라졌더라도 분할 자체는 `$SRC`에서 만들었으므로 무효가 아니다 —
   다만 원본이 앞서갔다는 뜻이므로, 새 head의 manifest를 다시 떠서 차이를
   확인하고 필요하면 그 델타만 얹는다.

## 소유권 문제 (중요)

#518은 **Wibias 소유**다. 우리가 그 브랜치를 강제로 바꾸는 것은
범위 밖이다. 두 가지 길이 있다:

1. **권장** — 분할 브랜치 두 개를 만들어 새 PR로 올리고, #518에
   "이렇게 쪼갰다"는 코멘트를 남긴 뒤 작성자가 닫도록 요청한다.
2. 작성자에게 분할을 요청만 하고 우리는 손대지 않는다.

WP4에서 Wibias가 메인테이너가 되면 1번이 훨씬 자연스러워진다. 순서상
**WP4(메인테이너 추가)를 WP3(분할)보다 먼저** 하는 것이 맞다.

→ 이 발견에 따라 goalplan의 work-phase 순서를 wp4 → wp3으로 바꾼다.
