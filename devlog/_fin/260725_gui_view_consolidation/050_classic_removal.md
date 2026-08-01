# 050 — Classic 경로 철거 (WP5)

> 상위: [`000_plan.md`](./000_plan.md) · 기준 `origin/dev` @ `3f2098d0`
> **선행 조건: WP1~WP4가 모두 끝난 뒤에 착수한다.** Classic이 살아있는 동안 각
> 변경을 두 뷰에서 비교 검증할 수 있고, 먼저 지우면 비교 기준이 사라진다.

## 목적

`ViewMode` 개념과 Classic 렌더 경로를 저장소에서 완전히 제거한다. 완료 판정은
`rg -n "viewMode|ViewMode|classicToggle" gui/src`가 0건인 것이다.

## 제거 대상 전체 목록

Mind 스캔으로 확인한 소비자다. 계획서 초안은 `hash-routing.ts`를 누락했었다.

### 모듈 (삭제)

```text
gui/src/view-mode.ts            전체 삭제 (109줄)
  - ViewMode 타입, GLOBAL_VIEW_KEY, LEGACY_GLOBAL_VIEW_KEY
  - LEGACY_PAGE_VIEW_KEYS (10개)
  - migrateLegacyViewMode / readViewMode / writeViewMode / ensureMigratedViewMode
  - toggleViewMode / providersHashForViewMode / viewModeFromProvidersHash
  - providersHashForGlobalViewChange
```

### 라우팅 3파일 (수정)

| 파일 | 제거할 것 | 근거 |
| --- | --- | --- |
| `app-routing.ts` | `ViewMode` import(`:4`), `providersHashForPreferredMode()`(`:52-54`), `AppHashChangeAction.viewMode`(`:63`)와 `.persistViewMode`(`:65`), `resolveAppHashChange`의 preferred 인자와 분기(`:75-117`) | 위 rg 결과 |
| `hash-routing.ts` | `ProvidersHashResolve.viewMode`(`:34`), `resolveProvidersHashChange()` 전체(`:41-60`) | 이 함수는 Classic/Workspace 해석 전용이다 |
| `use-app-route-state.ts` | `viewMode` state(`:25-36`), `viewModeRef`(`:38`), `commitViewMode`(`:40-47`), `toggleGlobalWorkspace`(`:59-63`), `providersHashForViewMode` 호출(`:69`, `:93`), 반환값의 `viewMode`(`:104`) | 위 rg 결과 |

`normalizeHashPath` / `replaceHash` / `navigateHash`(`hash-routing.ts:1-29`)는
ViewMode와 무관한 범용 헬퍼다. **남긴다.**

### App + 페이지 4개 (수정)

```text
App.tsx:72        useAppRouteState() 구조분해에서 viewMode, toggleGlobalWorkspace 제거
App.tsx:235-240   사이드바 하단 Classic/Workspace 토글 버튼 블록 삭제
App.tsx:277,279,280,282   Dashboard/Providers/Models/Subagents 의 viewMode prop 제거

pages/Dashboard.tsx:9,190,1380   import, prop, workspace 분기
pages/Providers.tsx:21,49,555    동일
pages/Models.tsx:6,80,1171       동일
pages/Subagents.tsx:7,10,83      동일 (WP1에서 이미 상당 부분 정리됨)
```

각 페이지에서 Classic 분기를 지우고 Workspace 렌더를 유일 경로로 승격한다.
**단 Subagents는 반대다** — WP1에서 Classic이 승격되었으므로 여기서는 `viewMode`
prop과 `readViewMode()` 호출만 제거한다.

### i18n 6개 로케일 (수정)

```text
app.viewMode
pws.classicToggle
pws.workspaceToggle
```

로케일당 3키 × 6 = 18키. WP1의 `sub.workspace.*` 10키와 합쳐 로케일당 13키,
총 78키가 이 유닛에서 제거된다.

> **제거하면 안 되는 키:** `pws.accountsLoading`, `pws.retryAccounts`는
> `CodexAccountPool.tsx:293,298`, `CodexAutoSwitchSetting.tsx:136`,
> `useProviderAccountPools.ts:87`에서도 쓰인다. 공유 키다.

### 테스트 5개 (삭제/재작성)

| 파일 | 처리 | 근거 |
| --- | --- | --- |
| `gui/tests/view-mode.test.ts` | **삭제** | 9개 테스트 전부 `view-mode preference` / `providers hash sync helpers` 검증 |
| `gui/tests/view-mode-remount.test.tsx` | **삭제** | `toggling viewMode does not remount...` — 토글 자체가 사라짐 |
| `gui/tests/providers-hash-history.test.tsx` | **선별 재작성** | 실측 **21개** 케이스(`:50-414`). 아래 표로 케이스별 처리를 확정한다 |
| `gui/tests/subagents-workspace.test.ts` | WP1에서 처리 | — |
| `tests/provider-workspace-rail.test.ts:75-88` | **수정** | `preserves only the exact workspace subroute on page synchronization`가 `providers/workspace`를 단언한다. 계획서 초안이 누락했던 5번째 파일이다 |

`tests/startup-health-ui.test.ts`는 health 상태와 poll epoch만 검증한다. **무관하다.**

### `providers-hash-history.test.tsx` 케이스별 처리 (확정)

WP2가 이 파일에 Dashboard 해시 테스트를 **추가**한다(`020_nav_and_dashboard_tabs.md`).
따라서 WP5가 "재작성"이라는 이름으로 통째로 갈아엎으면 WP2가 방금 넣은 계약이 함께
사라진다. 케이스 단위로 지정한다.

**유지 (ViewMode와 무관한 계약):**

- `normalizeHashPath` / `replaceHash` / `navigateHash` 순수 헬퍼 테스트
- WP2가 추가한 Dashboard 해시 케이스 (등록된 하위 해시, 미등록 접미사 passive replace)
- 뒤로가기/앞으로가기 히스토리 동작
- 스토리지 접근 실패(사생활 보호 모드) 시 degrade 동작

**변환 (workspace → 단일 해시 계약):**

- `#providers/workspace` 입력 → `#providers`로 passive replace 되는지. 이것은
  **삭제가 아니라 반대 방향으로 다시 쓴다.** Q1 확정 사항의 회귀 방어다.

**삭제 (개념 자체가 사라짐):**

- `preferred === "workspace"`일 때 `#providers` → `#providers/workspace` 재작성
- 토글로 인한 해시 변경
- `persistViewMode` 관련 단언
- 저장된 선호값에 따른 분기 전부

착수 시 `rg -n "^\s*(it|test)\(" gui/tests/providers-hash-history.test.tsx`로 현재
개수를 다시 세고, 위 분류에 넣은 뒤 남은 것이 없는지 확인한다.

## 해시 처리 (Q1 확정)

`#providers/workspace` 북마크는 **passive replace**로 `#providers`가 된다.

```text
replaceHash("providers")   // history 항목을 남기지 않는다
```

`navigateHash`를 쓰면 뒤로가기가 사라진 해시에 갇힌다. `hash-routing.ts:11-18`의
`replaceHash`가 이미 그 의미론을 구현하고 있으므로 그대로 쓴다.

## 레거시 스토리지 정리 (Q2 확정)

`LEGACY_PAGE_VIEW_KEYS` 10개 + `GLOBAL_VIEW_KEY` + `LEGACY_GLOBAL_VIEW_KEY` =
총 12개 키를 **1회 삭제**한다.

```text
// use-app-route-state.ts 초기화 시점, ensureMigratedViewMode() 자리를 대체
const STALE_VIEW_KEYS = ["ocx-global-view", "ocx-view", "ocx-providers-view",
  "ocx-subagents-view", "ocx-storage-view", "ocx-codexauth-view", "ocx-apikeys-view",
  "ocx-claudecode-view", "ocx-usage-view", "ocx-logs-view", "ocx-models-view",
  "ocx-dashboard-view"];
try { for (const k of STALE_VIEW_KEYS) localStorage.removeItem(k); } catch { /* ignore */ }
```

이 정리 함수 자체도 다음 릴리스에서 제거한다는 주석을 남긴다. 방치하면 영구
부채가 된다.

## 순서

```text
1. i18n 18키 제거 (6로케일)        <- 먼저 하면 타입 에러가 남은 참조를 전부 잡아준다
2. App.tsx 토글 + prop 제거
3. 페이지 4개 분기 제거
4. use-app-route-state.ts 정리 + 레거시 키 삭제 코드
5. app-routing.ts / hash-routing.ts 정리
6. view-mode.ts 삭제
7. 테스트 5개 처리
```

1번을 먼저 하는 이유: `TKey` 타입이 좁아지면서 `t("pws.classicToggle")` 같은 남은
호출이 컴파일 에러로 드러난다. 수동 grep보다 확실하다.

## 검증

```bash
rg -n "viewMode|ViewMode|classicToggle|workspaceToggle" gui/src    # 0건이어야 한다
rg -n "providers/workspace" gui/src                                 # 0건
bun run typecheck
bun run lint:gui
bun run test                      # 루트 스위트 (./tests/) — provider-workspace-rail 포함
(cd gui && bun test tests)        # GUI 스위트 — 필수. 루트 test 는 gui/tests 를 돌리지 않는다
bun run privacy:scan
bun run build:gui
git diff --check
```

> WP5는 GUI 테스트 3개를 삭제/재작성하므로 **GUI 스위트 실행이 특히 중요하다.**
> `scripts/test.ts:38-41`의 기본 인자는 `./tests/`뿐이라 루트 `bun run test`만
> 돌리면 변경한 파일이 한 번도 실행되지 않는다.
>
> `providers/workspace` 문자열은 `tests/`에서는 0건이 아닐 수 있다 —
> `tests/provider-workspace-rail.test.ts:75-88`을 Q1 계약(passive replace)으로
> 고쳐 쓰면 그 문자열이 남는다. `gui/src`에서만 0건을 요구한다.

브라우저:

1. 사이드바 하단에 Classic/Workspace 토글이 없는지 확인
2. `#providers/workspace`로 직접 이동 → `#providers`로 조용히 바뀌는지, 뒤로가기가
   정상인지 확인
3. 4개 페이지가 전부 Workspace 레이아웃(Subagents만 Classic)으로 뜨는지 확인
4. localStorage에 `ocx-*-view` 키가 남아있지 않은지 DevTools로 확인

## 위험

- **`rg` 완료 기준의 오탐.** `viewMode`라는 식별자가 ViewMode와 무관한 곳에 쓰일
  가능성. 현재 rg 결과는 전부 Classic/Workspace 관련이지만, WP1~WP4에서 새 코드가
  들어오므로 착수 시점에 다시 확인한다.
- **`providers-hash-history.test.tsx` 선별 범위.** 케이스 분류는 위 표에서 확정했다.
  남은 위험은 WP2가 이 파일에 Dashboard 케이스를 추가한 뒤 WP5가 착수한다는 순서
  의존성이다. 착수 시 실제 케이스 수를 다시 세고, 유지 대상으로 분류한 항목이
  실수로 삭제되지 않았는지 확인한다.
- **docs-site 불일치.** WP6에서 처리하지만, WP5가 먼저 랜딩하면 잠시 문서가 거짓이
  된다. 두 WP를 같은 날 끝낸다.
