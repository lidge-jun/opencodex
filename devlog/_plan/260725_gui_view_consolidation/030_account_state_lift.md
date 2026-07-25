# 030 — Codex 계정 상태 리프팅과 Overview 조작 통합

## 목표

Provider workspace의 Overview와 Accounts가 Codex 계정 목록을 각각 소유하지 않게 한다. `Providers.tsx`가 `useCodexAccountPool(apiBase)`를 **한 번만** 호출하고, 두 탭은 그 한 컨트롤러를 표시한다. Overview는 좌측 본문의 기존 AUTHENTICATION 요약을 실제 계정 행과 조작으로 교체하고, Accounts 탭은 유지한다(D2). 계정 목록·활성 계정·로딩·전환 중 상태만 공유하고, 확인창·추가/재인증 모달·토스트·reset-credit 팝오버는 각 표시 표면에 남긴다(Q6). 기준 결정은 `000_plan.md:137-167,297-311`이다.

이 단계는 GUI 상태 소유권과 표시 조합만 바꾼다. `/api/codex-auth/*` 계약, `src/codex/routing.ts`의 thread affinity, 즉시/다음 세션 의미는 바꾸지 않는다. Codex는 기존처럼 활성 계정 변경 후 진행 중 스레드가 아니라 **다음 세션**에 적용되며(`000_plan.md:169-187`), 행의 `다음 세션` 배지가 그 차이를 표현한다(D1).

### 변경 지도

| 경로 | 작업 | diff 수준 결과 |
| --- | --- | --- |
| `gui/src/hooks/useCodexAccountPool.ts` | **NEW** | Codex 계정 데이터 컨트롤러와 요청 액션을 정의한다. |
| `gui/src/components/CodexAccountPool.tsx` | **MODIFY** | 데이터 상태/요청을 제거하고 컨트롤러 prop을 소비한다. 모달·토스트·quota/reset-credit 표시는 유지한다. 현재 소유권은 `CodexAccountPool.tsx:34-212`에 있다. |
| `gui/src/pages/CodexAuth.tsx` | **MODIFY** | 독립 페이지용 훅 인스턴스를 한 번 만들고 `CodexAccountPool`에 전달한다. 현재 thin wrapper는 `CodexAuth.tsx:11-56`이다. |
| `gui/src/pages/Providers.tsx` | **MODIFY** | `useProviderAccountPools` 옆에서 Codex 훅을 한 번 만들고 `ProviderDetails`에 전달한다. OAuth 훅 호출은 `Providers.tsx:182-193`, 상세 prop 조합은 `Providers.tsx:585-627`이다. |
| `gui/src/components/provider-workspace/ProviderDetails.tsx` | **MODIFY** | 동일한 auth panel props를 Overview와 Accounts에 전달한다. 현재 Overview는 `ProviderDetails.tsx:200-227`, Accounts는 `ProviderDetails.tsx:246-260`이다. |
| `gui/src/components/provider-workspace/ProviderOverview.tsx` | **MODIFY** | `authPanel` prop을 받아 AUTHENTICATION 요약 자리에 렌더한다. 우측 sidebar는 변경하지 않는다(`ProviderOverview.tsx:132-172`). |
| `gui/src/components/provider-workspace/ProviderAuthPanel.tsx` | **MODIFY** | `codexPool` prop을 받아 Codex 표시에도 공유 컨트롤러를 사용하고, OAuth/Codex 행을 동일한 `pwi-auth-row` 슬롯 계약으로 맞춘다. 현재 Codex는 내부 마운트다(`ProviderAuthPanel.tsx:40-48`). |
| `gui/src/styles/provider-workspace-settings.css` | **MODIFY** | 계정 행 액션 슬롯과 빈 슬롯 규칙을 추가한다. 기존 행의 축소 규칙은 `provider-workspace-settings.css:34-60`이다. |
| `tests/provider-workspace-auth.test.ts` | **MODIFY** | 소스 문자열 기반 **정적** 회귀만 담당한다(기존 검사는 `:83-180`). 공유 상태의 실제 동작 증명은 이 파일로 부족하다 — 아래 '동작 수준 테스트'를 별도로 만든다. |
| `gui/tests/codex-account-pool-controller.test.tsx` | **NEW** | 동작 수준 테스트. 하나의 컨트롤러에 Overview/Accounts 두 경로를 붙이고 mutation·실패 보존·순서 뒤바뀐 응답·요청 수를 단언한다. |
| `gui/tests/codex-auto-switch-controller.test.tsx` | **MODIFY** | `CodexAccountPool`의 필수 controller prop에 맞추되 auto-switch read/write 회귀를 보존한다. 현재 직접 마운트는 `codex-auto-switch-controller.test.tsx:160`이다. |

새 endpoint, 새 자격증명 형식, 새 라우팅 계층은 추가하지 않는다. 새 훅은 `CodexAccountPool.tsx:57-201`의 기존 요청을 옮기는 것뿐이다.

## 현재 상태 — 두 상태 소유자

| 항목 | OAuth/API-key 계정 | Codex 계정 | 문제 |
| --- | --- | --- | --- |
| 소유자 | 부모 `Providers.tsx`가 호출하는 `useProviderAccountPools` (`Providers.tsx:182-193`) | `CodexAccountPool` 컴포넌트 로컬 (`CodexAccountPool.tsx:40-55`) | `ProviderAuthPanel`을 Overview와 Accounts에 각각 붙이면 Codex만 두 로컬 사본이 생긴다. |
| 목록 | `accountSets[provider].accounts` (`useProviderAccountPools.ts:31-33,54-57`) | `accounts` (`CodexAccountPool.tsx:40,61-67`) | 한 표면의 add/remove/alias 결과가 다른 표면에 즉시 보인다는 D5를 Codex가 만족하지 못한다. |
| 활성/전환 중 | `accountSets[provider].activeAccountId`, `switchingAccount` (`useProviderAccountPools.ts:31-33,76-97`) | `activeId`, `switchingId` (`CodexAccountPool.tsx:41,54,140-169`) | 탭 전환 시 진행 상태와 선택 결과가 리셋될 수 있다. |
| 로딩 경쟁 방지 | provider별 `accountRequestGenerationRef` (`useProviderAccountPools.ts:38,49-61`) | 단일 `loadGenerationRef` (`CodexAccountPool.tsx:55,57-90`) | Codex ref도 데이터 소유자와 함께 올라가야 stale 응답 차단이 유지된다. |
| 표시 상태 | 부모 `notify` 및 panel 로컬 상태 (`useProviderAccountPools.ts:21,27-30`) | `confirm`, `showAdd`, `toast`, reset 팝오버 등 (`CodexAccountPool.tsx:42-52`) | 표시 상태는 공유할 필요가 없다. 탭별로 닫히거나 다시 열려도 계정 데이터의 정합성에는 영향이 없다. |

OAuth 쪽은 이미 “부모 훅이 데이터와 mutation을 소유하고, panel은 props로 소비”하는 형태다. 새 Codex 훅은 이 모양을 따른다. 상태/세대 ref의 근거는 다음과 같다.

```tsx
// gui/src/hooks/useProviderAccountPools.ts:25-40
codexActiveNeedsReauth: boolean;
}) {
  const {
    apiBase, t, config, aliveRef, notify,
    fetchConfig, fetchOauth, fetchProviderQuotas, codexActiveNeedsReauth,
  } = deps;
  const [accountSets, setAccountSets] = useState<Record<string, {
    activeAccountId: string | null;
    accounts: OAuthAccount[];
  }>>({});
  const [accountLoadStates, setAccountLoadStates] = useState<Record<string, AccountLoadState>>({});
  const [switchingAccount, setSwitchingAccount] = useState<{ provider: string; accountId: string } | null>(null);
  // ...
  const accountRequestGenerationRef = useRef<Record<string, number>>({});
  const switchingAccountRef = useRef<{ provider: string; accountId: string } | null>(null);
```

mutation도 전환 잠금 → PUT → reload → 잠금 해제 순서다.

```tsx
// gui/src/hooks/useProviderAccountPools.ts:76-97
const switchAccount = async (provider: string, account: OAuthAccount) => {
  if (account.active || account.needsReauth || switchingAccountRef.current) return;
  const target = { provider, accountId: account.id };
  switchingAccountRef.current = target;
  setSwitchingAccount(target);
  // PUT /api/oauth/accounts/active
  // fetchAccountSets([provider])
  // ...
  finally {
    if (switchingAccountRef.current?.provider === target.provider
      && switchingAccountRef.current.accountId === target.accountId) {
      switchingAccountRef.current = null;
      if (aliveRef.current) setSwitchingAccount(null);
    }
  }
};
```

Codex도 `switchingId`와 별도의 ref를 함께 두어 double-submit을 동기적으로 막는다. state만 검사하는 현재 `CodexAccountPool.tsx:140-142`보다 OAuth의 ref 잠금(`useProviderAccountPools.ts:76-80`)을 그대로 따르는 편이 안전하다.

## 훅 추출 설계

### 공개 계약

`CodexAccountEntry`는 더 이상 표시 컴포넌트가 소유하지 않게 한다. 타입과 controller를 새 훅에서 export하고, `CodexAccountPool`, `Providers`, `ProviderDetails`, `ProviderAuthPanel`이 같은 타입을 import한다. 훅은 번역 함수, toast, `window.prompt`, `window.confirm`, modal open state를 받지 않는다. 실패 메시지를 직접 띄우지 않고 결과만 반환한다.

```ts
// NEW gui/src/hooks/useCodexAccountPool.ts
import type { AccountQuota } from "../codex-quota-utils";

export type CodexAccountLoadState = "loading" | "ready" | "error";

export interface CodexAccountEntry {
  id: string;
  alias?: string;
  email: string;
  plan?: string;
  isMain: boolean;
  hasCredential: boolean;
  quota: AccountQuota | null;
  needsReauth?: boolean;
}

export type CodexAccountActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; reason: "busy" | "request" | "reload" };

export interface CodexAccountLoadObserver {
  beginActiveRead(): number;
  acceptActiveRead(value: unknown, startedRevision: number): void;
  rejectActiveRead(): void;
}

export interface CodexAccountPoolController {
  accounts: CodexAccountEntry[];
  activeId: string | null;
  loadState: CodexAccountLoadState;
  switchingId: string | null;
  activeNeedsReauth: boolean;

  /** observer 인자는 없다 — 통지는 subscribeLoadObserver 한 경로뿐이다. */
  load(refreshQuota?: boolean): Promise<boolean>;
  switchAccount(id: string): Promise<CodexAccountActionResult<{ activeId: string | null }>>;
  saveAlias(id: string, alias: string): Promise<CodexAccountActionResult>;
  removeAccount(id: string): Promise<CodexAccountActionResult>;
  syncAfterAccountAdded(): Promise<CodexAccountActionResult>;

  /** 배경 폴링 일시정지. 호출마다 새 토큰을 반환하며, 그 토큰을 해제해야 재개된다. */
  pauseRefresh(): PauseToken;
  /** 같은 이유로 두 표면이 동시에 정지시켜도 마지막 해제에서만 재개된다. */
  resumeRefresh(token: PauseToken): void;

  /** 훅이 소유한 배경 load 결과를 표시 계층이 구독한다(아래 observer 절). */
  subscribeLoadObserver(observer: CodexAccountLoadObserver): () => void;
}

/** 불투명 토큰 — 문자열 reason 을 키로 쓰지 않는다. */
export type PauseToken = { readonly __brand: "codex-pool-pause" };

export function useCodexAccountPool(apiBase: string): CodexAccountPoolController;
```

`activeNeedsReauth`는 새 독립 state가 아니라 `activeId`와 `accounts`의 파생값이다. 현재 계산식 `CodexAccountPool.tsx:110-116`을 훅 안으로 옮긴다. `activeId`가 `null` 또는 `"__main__"`이면 main row, 그 외에는 해당 pool row의 `needsReauth`를 본다. 이 값을 `useProviderAccountPools`의 기존 `codexActiveNeedsReauth` 입력(`useProviderAccountPools.ts:25-30,203-211`)으로 연결하면 rail/models 경고도 같은 원본에서 파생된다.

### 함수 이동과 분해

| 현재 함수 | 이동 후 | 경계 |
| --- | --- | --- |
| `load(refreshQuota)` (`CodexAccountPool.tsx:57-91`) | 훅의 `load`로 그대로 이동 | accounts/active 병렬 GET, generation 검사, `loadState` 갱신은 DATA다. auto-switch threshold의 `beginServerRead/acceptServerRead/rejectServerRead` 연결은 `CodexAccountPool`의 표시 controller에 남긴다. observer는 `subscribeLoadObserver`로 등록된 것만 쓰며 `load` 인자로 전달하지 않는다. 훅은 배경/명시 구분 없이 모든 load에서 등록된 구독자에게 request 시작 전에 `beginActiveRead()`, active 성공 직후 `acceptActiveRead(...)`, 실패 시 `rejectActiveRead()`를 호출한다. threshold UI state는 훅 반환값에 추가하지 않는다. |
| `setActive(id)` (`CodexAccountPool.tsx:140-169`) | `switchAccount(id)` | PUT, `activeId`, `switchingId`, reload만 훅으로 이동한다. `confirm` 닫기와 성공/실패 toast 문구는 caller가 결과를 보고 처리한다. `accountModeState`는 문구에만 필요하므로 훅 인자가 아니다. |
| `editAlias(account)` (`CodexAccountPool.tsx:171-187`) | `saveAlias(id, alias)` | `window.prompt`와 toast는 표시 계층에 남고, trimmed alias PUT + reload만 이동한다. main에는 호출하지 않는다. |
| `remove(id)` (`CodexAccountPool.tsx:189-201`) | `removeAccount(id)` | label 계산, `window.confirm`, toast는 표시 계층에 남고 DELETE + reload만 이동한다. main에는 호출하지 않는다. |
| `handleAccountAdded()` (`CodexAccountPool.tsx:132-138`) | `syncAfterAccountAdded()` + 표시 callback | 실제 OAuth add/reauth flow는 `AddCodexAccountModal`이 소유한다(`AddCodexAccountModal.tsx:107-218`). 성공 후 공유 목록을 reload하는 부분만 훅 action이고, modal close와 toast는 표시 계층이다. |
| `refreshQuotas()` (`CodexAccountPool.tsx:203-212`) | `load(true)`는 훅, `refreshingQuota`/toast는 표시 | quota refresh button의 pending/feedback은 presentation이다. |
| `openReauth`, `closeAddModal` (`CodexAccountPool.tsx:122-130`) | 이동 없음 | `reauthId`와 `showAdd`만 바꾸는 modal 제어다. |
| `openResetPopup`, `handleRedeem` (`CodexAccountPool.tsx:214-260`) | 이동 없음 | reset-credit popup의 로딩/확인/feedback은 Q6이 명시한 presentation 범위다. 성공 뒤에만 공유 `load(true)`를 호출한다. |

auto-switch는 현재 `load`의 active 응답에 함께 들어오는 `autoSwitchThreshold`를 소비한다(`CodexAccountPool.tsx:72-84`). 이를 빼먹으면 `CodexAutoSwitchSetting` 초기화가 깨진다. `useCodexAutoSwitch` 자체는 새 계정 훅으로 옮기지 않는다 — 표시 계층에 남는다.

**전달 방식은 구독 하나뿐이다.** `CodexAccountPool`이 마운트 시
`subscribeLoadObserver({ beginActiveRead: beginServerRead, acceptActiveRead: acceptServerRead, rejectActiveRead: rejectServerRead })`를 호출하고, 언마운트 시 반환된 해제 함수를 부른다. `load`에 observer를 인자로 넘기는 경로는 **없다**.

> 초안은 `load(refreshQuota, observer)` 주입을 지시했는데 폐기한다. 폴링이 훅으로
> 올라간 뒤에는 배경 load 에 인자를 넘길 호출자가 없고, 두 경로를 함께 두면 명시적
> load 한 번에 같은 observer가 두 번 통지된다. 경로는 하나여야 한다.

### 인스턴스 소유권

현재 OAuth 훅 호출 위치 바로 다음이 Codex 훅의 소유 위치다.

```tsx
// gui/src/pages/Providers.tsx:182-193 — BEFORE
const pools = useProviderAccountPools({
  apiBase, t: t as unknown as Parameters<typeof useProviderAccountPools>[0]["t"],
  config, oauthStatus, aliveRef,
  notify: (msg, ok) => { setStatus(msg); setStatusOk(!!ok); },
  fetchConfig, fetchOauth, fetchProviderQuotas, codexActiveNeedsReauth,
});
```

```tsx
// AFTER — Providers component에서 각 훅을 정확히 한 번 호출
const codexPool = useCodexAccountPool(apiBase);
const pools = useProviderAccountPools({
  // 기존 deps 유지
  codexActiveNeedsReauth: codexPool.activeNeedsReauth,
});

// ProviderDetails로 동일 객체 전달
<ProviderDetails
  // 기존 props
  codexPool={codexPool}
/>
```

`CodexAccountPool` 내부에서 fallback 훅을 호출하는 선택적 prop은 금지한다. React hook을 조건부로 부를 수 없고, fallback을 항상 만들면 숨은 두 번째 state owner가 생긴다. 대신 `CodexAuth.tsx:11-56`도 `const codexPool = useCodexAccountPool(apiBase)`를 명시적으로 만들고 필수 prop으로 전달한다. Codex Auth 페이지의 인스턴스는 Provider workspace의 Overview/Accounts 두 표면과 동시에 마운트되는 owner가 아니므로 D5의 두 탭 공유 범위와 충돌하지 않는다.

## 상태 분류표

`CodexAccountPool.tsx:34-60`의 hook 선언을 빠짐없이 분류한다. Q6의 목록/활성/요청 진행 상태만 DATA로 올리고, 표시 수명과 결합된 상태는 남긴다.

| 현재 선언 | 분류 | 처리와 근거 |
| --- | --- | --- |
| `autoSwitch = useCodexAutoSwitch(...)` (`:34-38`) | PRESENTATION controller | `CodexAutoSwitchSetting`의 draft/saving/feedback을 소유한다. 계정 목록 공유와 무관하고, Q6 반환 shape에 넣지 않는다. 단 `load`의 threshold read bridge는 보존한다(`:39,57-91`). |
| `beginServerRead`, `acceptServerRead`, `rejectServerRead` (`:39`) | PRESENTATION callbacks | auto-switch controller의 read reconciliation이다. `subscribeLoadObserver`로 등록하되 훅 state로 옮기지 않는다. |
| `accounts` (`:40`) | **DATA** | 훅으로 이동. Overview/Accounts가 같은 배열을 읽는다. |
| `activeId` (`:41`) | **DATA** | 훅으로 이동. Codex `다음 세션`/active 배지의 단일 원본이다. |
| `confirm` (`:42`) | PRESENTATION | 현재 표면의 전환 확인 modal 대상이다. confirm 승인 시 공유 `switchAccount`를 호출한다. |
| `showAdd` (`:43`) | PRESENTATION | 현재 표면의 add/reauth modal open 여부다. |
| `reauthId` (`:44`) | PRESENTATION | modal에 전달할 일시적 대상이다. 계정 목록 자체가 아니다. |
| `toast` (`:45`) | PRESENTATION | 표면별 성공/실패 피드백이다. 훅 action result를 번역한다. |
| `toastError` (`:46`) | PRESENTATION | 위 toast의 tone이다. |
| `refreshingQuota` (`:47`) | PRESENTATION | refresh button pending 상태다. 공유 데이터 요청은 `load(true)`가 맡는다. |
| `resetPopup` (`:48`) | PRESENTATION | 열린 reset-credit popover의 대상 row다. |
| `resetConfirm` (`:49`) | PRESENTATION | irreversible consume 2단계 확인 UI다. |
| `redeeming` (`:50`) | PRESENTATION | consume 버튼 pending 상태다. 계정 공용 mutation이 아니다. |
| `creditDetails` (`:51`) | PRESENTATION | 열린 popup에만 필요한 상세 목록이다. Q6이 명시적으로 남기라고 한 `creditDetails*`다. |
| `creditDetailsLoading` (`:52`) | PRESENTATION | 위 popup의 loading 상태다. |
| `loadState` (`:53`) | **DATA** | 훅으로 이동. 두 탭 모두 같은 loading/ready/error와 retry 결과를 본다. |
| `switchingId` (`:54`) | **DATA** | 훅으로 이동. 탭 이동 중에도 중복 전환을 막고 동일한 switching 배지를 표시한다. |
| `loadGenerationRef` (`:55`) | **DATA ref** | 훅으로 이동. 늦게 도착한 accounts/active 응답이 최신 state를 덮지 못하게 한다(`:57-90`). |
| `load = useCallback(...)` (`:57-60`, 전체 `:57-91`) | **DATA callback** | 훅으로 이동. `apiBase`와 generation/ref/state setter를 데이터 소유자가 갖는다. auto-switch observer는 인자 주입이 아니라 `subscribeLoadObserver` 구독으로 통지한다. |

`useCallback` 중 `openReauth`/`closeAddModal`/`handleAccountAdded`는 `CodexAccountPool.tsx:122-138`에 있고, 모두 표시 계층에 남는다. 단 `handleAccountAdded` 안의 `load()` 한 줄만 `syncAfterAccountAdded()`로 바뀐다. 이 분해가 “add action은 데이터 훅, modal/toast는 presentation”이라는 Q6을 만족한다.

## Overview 통합

### Before — 텍스트 요약만 있는 AUTHENTICATION

현재 교체 대상은 정확히 `ProviderOverview.tsx:85-127`이다.

```tsx
<section className="pws-section" aria-label={t("pws.authSummary")}>
  <h3 className="pws-section-title">{t("pws.authSummary")}</h3>
  {needsAttention ? (
    <div className="pws-auth-summary pws-auth-summary--warn" role="status">
      <IconAlert ... />
      <div className="pws-auth-summary-body">
        <span>... needs attention ...</span>
        {onReauthenticate && <button ...>{t("pws.reauthenticate")}</button>}
        {reauthBusy && onCancelLogin && <button ...>{t("common.cancel")}</button>}
      </div>
    </div>
  ) : (
    <div className="pws-auth-summary">
      <span className="pws-auth-dot" />
      <span>
        {item.authMode === "forward"
          ? t("pws.passthrough")
          : item.authMode === "oauth"
            ? (oauthEmail ? t("pws.loggedInAs", { email: oauthEmail }) : t("pws.notLoggedIn"))
            : item.hasApiKey ? t("pws.apiKeyConfigured") : authModeLabel(item, t)}
      </span>
    </div>
  )}
</section>
```

이 블록은 상태를 설명할 뿐, 정상 상태에서는 조작이 없다(`ProviderOverview.tsx:115-127`). needs-attention일 때만 재인증이 열리고(`:87-114`), Codex forward는 Accounts 탭으로 보내는 우회다(`ProviderDetails.tsx:211-223`).

### After — 같은 panel을 두 탭에 조합

`ProviderDetails`가 auth props를 한 곳에서 조립한다. Accounts 탭을 삭제하지 않고(D2), 현재 `ProviderDetails.tsx:247-259`의 panel을 Overview에도 전달한다.

```tsx
// ProviderDetails.tsx — 새 prop
codexPool: CodexAccountPoolController;

const authPanel = authSurface ? (
  <ProviderAuthPanel
    item={item}
    apiBase={apiBase}
    oauth={oauth}
    accounts={accounts}
    keys={keys}
    accountLoadState={accountLoadState}
    switchingAccountId={switchingAccountId}
    busy={busyProvider === item.name}
    loginHint={loginHint}
    authHandlers={authHandlers}
    codexPool={codexPool}
  />
) : null;

{tab === "overview" && (
  <ProviderOverview
    item={item}
    usageTotals={usageTotals}
    quotaReport={quotaReport}
    oauthEmail={oauthEmail}
    authPanel={authPanel}
    // settings/usage props 유지
  />
)}
{tab === "accounts" && authPanel}
```

`ProviderOverview`의 새 prop은 `authPanel?: ReactNode` 하나다. 인증 세부 prop 10여 개를 Overview가 다시 중계하지 않고, 조합 책임을 이미 가진 `ProviderDetails`가 현재 Accounts panel shape(`ProviderDetails.tsx:247-259`)를 한 번만 정의한다. Overview는 `ProviderOverview.tsx:85-129`를 다음으로 바꾼다.

```tsx
// ProviderOverview.tsx — AFTER
{authPanel && (
  <section className="pws-section" aria-label={t("pws.authSummary")}>
    {authPanel}
  </section>
)}
```

`ProviderAuthPanel` 자체가 이미 section/title을 렌더하므로(`ProviderAuthPanel.tsx:40-48,67-70`), 실제 구현에서는 중첩 `<section>`/중복 제목이 생기지 않게 둘 중 하나만 section owner가 되어야 한다. 권장 diff는 Overview가 wrapper 없이 `{authPanel}`만 놓고, `ProviderAuthPanel`의 기존 section을 그대로 재사용하는 것이다. 이 경우 AUTHENTICATION 자리만 바뀌고 우측 `<aside>`는 `ProviderOverview.tsx:132-172` 그대로 남는다(Q8).

## 공유 계정 행 레이아웃

OAuth의 현재 행은 `ProviderAuthPanel.tsx:140-196`이다. 재사용할 DOM 모양은 다음과 같다.

```tsx
<div className="pwi-auth-list" role="list">
  <div className={`pwi-auth-row${account.active ? " pwi-auth-row--active" : ""}`} role="listitem">
    <button className="pwi-auth-row-main" onClick={/* switch */}>  {/* 1. 전환 */}
      <span className="pwi-auth-dot ..." />
      <span className="pwi-auth-row-copy">label + secondary</span>
      {/* reauth / active / switching badges */}
    </button>
    {account.needsReauth && (
      <button className="btn btn-ghost btn-sm" onClick={/* reauth */}>...</button> // 2. 재인증
    )}
    <button className="btn btn-ghost btn-sm" onClick={/* alias */}>...</button>   // 3. alias
    <button className="btn btn-ghost btn-sm pwi-auth-row-remove" onClick={/* remove */}>...</button> // 4. 삭제
  </div>
</div>
<button className="btn btn-ghost btn-sm" onClick={/* add account */}>...</button> // 5. 추가
```

실제 switch guard와 disabled 조건은 `ProviderAuthPanel.tsx:148-181`, add 버튼은 `:192-196`을 그대로 보존한다. Codex도 card 기반 행(`CodexAccountPool.tsx:304-390`)을 이 `pwi-auth-list`/`pwi-auth-row` 모양으로 바꾼다. 의미 매핑은 다음과 같다.

| 공통 위치 | OAuth | Codex |
| --- | --- | --- |
| row main click | 즉시 `onSwitchAccount` (`ProviderAuthPanel.tsx:149-153`) | confirm modal을 먼저 열고 승인 시 공유 `switchAccount`; `다음 세션` 배지를 항상 의미 표지로 둔다(`CodexAccountPool.tsx:311-320,358-367`). |
| 상태/배지 | reauth, active, switching (`ProviderAuthPanel.tsx:154-161`) | needsReauth, `다음 세션`, switching. direct mode의 기존 `poolPrepared` 문구는 유지한다(`CodexAccountPool.tsx:277,311-315,358-361`). |
| reauth slot | 필요할 때 버튼 (`ProviderAuthPanel.tsx:163-172`) | 필요할 때 `openReauth(id)` (`CodexAccountPool.tsx:338-343,369-372`). |
| alias slot | 모든 OAuth row (`ProviderAuthPanel.tsx:173-176`) | pool row만 (`CodexAccountPool.tsx:374-376`). |
| remove slot | 모든 OAuth row (`ProviderAuthPanel.tsx:177-183`) | pool row만 (`CodexAccountPool.tsx:377-384`). |
| list footer | add account (`ProviderAuthPanel.tsx:192-196`) | `setShowAdd(true)` (`CodexAccountPool.tsx:330-335`). |

### MAIN 계정의 누락 action: 빈 슬롯을 선택한다

Codex MAIN은 lock/app-login 행이며 alias/remove가 없다(`CodexAccountPool.tsx:304-327`). pool row만 alias/remove를 노출한다(`CodexAccountPool.tsx:349-389`). 여기에는 **disabled button을 그리지 않고, 같은 폭의 비대화형 빈 슬롯을 둔다.**

```tsx
<span className="pwi-auth-action-slot pwi-auth-action-slot--alias" aria-hidden="true" />
<span className="pwi-auth-action-slot pwi-auth-action-slot--remove" aria-hidden="true" />
```

근거:

- disabled alias/remove 버튼은 “조건을 만족하면 MAIN도 수정/삭제할 수 있다”는 잘못된 affordance를 만든다. 실제 backend/UI 계약에는 그 action이 없다(`CodexAccountPool.tsx:304-327`).
- 빈 슬롯은 tab order와 screen-reader action 목록에 가짜 기능을 추가하지 않으면서, pool/OAuth 행의 alias/remove 버튼 위치를 유지한다(D1).
- 단순히 요소를 생략하면 오른쪽 action들이 당겨져 행마다 위치가 달라진다. 따라서 `.pwi-auth-row-actions`를 `switch/main | reauth | alias | remove`의 명시적 slot으로 두고, 없는 action은 `aria-hidden` placeholder가 차지해야 한다. 기존 flex row(`provider-workspace-settings.css:39-50`)를 action-slot grid로 보강한다.

Codex MAIN의 재인증은 현재 별도 main-row 버튼이 아니라 needs-reauth 설명만 있다(`CodexAccountPool.tsx:304-327`). MAIN reauth slot도 빈 슬롯으로 두고 기존 동작을 보존한다. `/api/codex-auth/login`의 reauth는 `configuredPoolAccount`가 아닌 id를 404로 거부하므로(`src/codex/auth-api.ts:625-642`), synthetic `"__main__"`을 `AddCodexAccountModal`에 넘기면 동작하지 않는다. WP3에서 새 MAIN reauth endpoint나 id 규칙을 만들지 않는다.

## 레이아웃 검증

Overview grid는 `1fr 280px`, gap 24px다(`provider-workspace-shell.css:526-531`). detail 자체의 최대 폭은 960px다(`provider-workspace-shell.css:654-661`). 따라서 최대 폭에서 좌측 main column은 다음과 같다.

```text
960px - 280px(sidebar) - 24px(gap) = 656px
```

656px에서는 공통 행이 들어간다. row main은 `flex:1; min-width:0`이고(`provider-workspace-settings.css:46-50`), label/secondary는 overflow를 줄이거나 말줄임할 수 있다(`provider-workspace-settings.css:34-35,54`). alias/remove/re-auth action slot은 고정 폭, 계정 copy만 남은 폭을 쓰게 한다. 따라서 긴 email/account id가 행 전체를 넓히지 않는다.

다만 정적 계산만으로 모든 폭을 통과했다고 주장하면 안 된다. container query는 shell 폭 920px 이하에서 Overview를 단일 열로 바꾼다(`provider-workspace-shell.css:547-551`), 반면 root rail은 920px 이하에서 240px로 줄고(`provider-workspace-shell.css:403-408`) 680px 이하에서야 한 열이 된다(`:410-428`). 즉 shell이 921px인 경계에서는 대략 `921 - 280 - 16 = 625px` detail, 그 안의 좌측은 `625 - 280 - 24 = 321px`까지 좁아질 수 있다. 이 폭에서도 `min-width:0` 때문에 DOM overflow는 막을 수 있지만 action이 copy를 과도하게 압축할 수 있으므로 921px를 필수 browser proof 폭으로 잡는다.

Q8에 따라 우측 sidebar의 폭/내용/순서는 변경하지 않는다. `ProviderOverview.tsx:132-172`와 `.pws-overview-sidebar` (`provider-workspace-shell.css:540-545`)는 no-diff여야 한다. CSS 변경은 공통 account row/action slot에만 한정한다.

## 보안 자기검토 체크리스트

이 단계는 login/logout/reauth/credential-delete 표면을 재배치하므로 `AGENTS.md`의 security review 경계에 해당한다. 구현 diff와 browser proof에서 다음을 전부 확인한다.

- [ ] **자격증명 로깅 없음:** API key, OAuth code, token, request/response body, raw credential을 `console.*`, toast, aria-label, title에 추가하지 않는다. 현재 계정 행은 email/alias/id만 표시한다(`ProviderAuthPanel.tsx:145-180`, `CodexAccountPool.tsx:349-386`).
- [ ] **새 endpoint 없음:** 기존 GET `/api/codex-auth/accounts`, GET/PUT `/api/codex-auth/active`, PUT alias, DELETE accounts, 기존 login modal endpoint만 호출한다(`CodexAccountPool.tsx:57-90,140-201`, `AddCodexAccountModal.tsx:107-218`).
- [ ] **권한 확대 없음:** GUI에 새 server permission, workflow permission, CORS, credential export, filesystem 접근을 추가하지 않는다. 훅 이동은 fetch 호출 위치만 바꾼다.
- [ ] **삭제 확인 유지:** remove는 표시 계층의 `window.confirm`을 반드시 통과한 뒤 훅의 DELETE를 호출한다. 현재 확인은 `CodexAccountPool.tsx:189-193`, OAuth 확인은 `useProviderAccountPools.ts:169-174`다.
- [ ] **전환 확인 유지:** Codex row click은 즉시 PUT하지 않고 기존 confirm modal(`CodexAccountPool.tsx:410-436`)을 거친다. OAuth의 즉시 전환과 의미가 다르므로 Codex `다음 세션` 배지를 함께 보인다.
- [ ] **재인증 대상 보존:** pool account id를 `AddCodexAccountModal`의 `reauthAccountId`로 그대로 전달하고(`CodexAccountPool.tsx:122-130,496-502`), 표시 레이어에서 다른 계정 id로 치환하지 않는다.
- [ ] **중복 mutation 차단:** `switchingId`와 ref guard로 동시 PUT을 막고, 전환 중 alias/remove/add도 disabled 처리한다. OAuth의 검증된 guard는 `useProviderAccountPools.ts:76-97`이다.
- [ ] **stale 응답 차단:** `loadGenerationRef`를 훅으로 함께 옮기고 accounts/active 둘 다 같은 generation을 검사한다(`CodexAccountPool.tsx:55-90`).
- [ ] **표시 문자열 마스킹 회귀 없음:** 새 공통 행은 기존 label helper/현재 Codex email 표시 수준보다 더 민감한 값을 드러내지 않는다. token·credential 원문은 표시하지 않는다.

## 검증


## 로드/폴링 생명주기 소유권 (A-gate 보완, 확정)

리뷰에서 지적된 누락이다. 추출 표가 상태는 나눴지만 **이펙트의 소유자를 지정하지
않았다.** 지정하지 않으면 두 표면이 각자 폴링하거나(중복 요청) 아무도 초기 로드를
하지 않는다.

현재 이펙트 (`CodexAccountPool.tsx:92-108`):

```text
useEffect(() => {
  timeout(0)  -> load()                 // 초기 로드
  if (showAdd) return cleanup           // add/reauth 모달 열려있으면 폴링 정지
  interval(30_000) -> load()            // 배경 갱신
}, [load, showAdd]);
```

**문제:** 이 이펙트는 DATA(`load`)와 PRESENTATION(`showAdd`)에 동시에 의존한다.
Q6의 분류선을 그대로 적용하면 이펙트가 두 계층에 걸친다.

### 확정

1. **이펙트는 훅(컨트롤러)이 소유한다.** `useCodexAccountPool`이 초기 로드와
   30초 인터벌을 단독으로 돌린다. `Providers.tsx`가 훅을 한 번만 호출하므로
   폴링도 앱 전체에서 한 번만 돈다.
2. **`showAdd` 의존은 토큰 기반 pause 리스로 바꾼다.** `pauseRefresh()`는
   호출할 때마다 **새 불투명 토큰**을 반환하고, `resumeRefresh(token)`은 그
   토큰만 해제한다. 훅은 살아있는 토큰 집합이 비었을 때만 폴링을 재개한다.

   > 초안은 "이유 문자열을 세트로 관리"라고 적었는데 **틀렸다.** 두 표면이 같은
   > 이유(`"add-modal"`)로 동시에 정지시키면 첫 번째 `resumeRefresh`가 두 번째
   > 호출자의 정지까지 풀어버린다. 문자열 키가 아니라 호출 단위 토큰이어야 한다.

3. **auto-switch observer는 구독 방식으로 받는다.** 현재 `load(refreshQuota, observer)`는
   호출자가 observer 를 넘기는 구조인데, 폴링이 훅으로 올라가면 **배경 load 에는
   넘길 호출자가 없다.** 따라서 `subscribeLoadObserver(observer)`를 두고, auto-switch
   임계값을 소유한 표시 계층이 마운트 시 구독한다. 훅은 자기 소유의 배경 load 든
   표시 계층이 유발한 명시적 load 든 동일하게 구독자 전원에게 통지한다.
4. **표면 컴포넌트는 이펙트를 갖지 않는다.** Overview와 Accounts는 훅이 준
   값을 읽기만 한다. 이것이 "두 표면이 마운트/언마운트돼도 요청 수가 변하지
   않는다"는 검증 기준의 근거다.

정식 형태는 위 `CodexAccountPoolController` 인터페이스 하나뿐이다. 요약하면
데이터(`accounts`/`activeId`/`loadState`/`switchingId`/`activeNeedsReauth`),
액션(`load`/`switchAccount`/`saveAlias`/`removeAccount`/`syncAfterAccountAdded`),
생명주기(`pauseRefresh`/`resumeRefresh`/`subscribeLoadObserver`)의 세 묶음이다.

### 이 결정이 만드는 검증 기준

- Overview와 Accounts를 번갈아 5회 전환해도 `/api/codex-auth/accounts` 요청 수가
  증가하지 않는다 (탭 전환은 fetch를 유발하지 않는다).
- Overview에서 add 모달을 열면 30초 폴링이 멈추고, 닫으면 재개된다.
- **두 표면이 동시에 정지시킨 뒤 하나만 해제하면 폴링은 여전히 멈춰 있다**
  (토큰 리스 회귀 — 문자열 키였다면 실패한다).
- 배경 폴링이 유발한 load 도 구독한 auto-switch observer 에게 통지된다.
- **명시적 load 1회당 구독 observer 의 각 callback 은 정확히 1번 호출된다**
  (인자 주입 경로가 남아 있으면 2번 호출되어 실패한다).
- 두 표면이 동시에 마운트된 상황이 생기더라도 인터벌은 하나다.

### 정적/테스트 게이트

구현 직후 작은 순서로 실행하고, 마지막에 전체 gate를 실행한다.

```bash
git diff --check
bun test tests/provider-workspace-auth.test.ts
(cd gui && bun test tests/codex-auto-switch-controller.test.tsx)
bun run typecheck
bun run lint:gui
bun run build:gui
bun run privacy:scan
bun run test                      # 루트 스위트 (./tests/)
(cd gui && bun test tests)        # GUI 스위트 — 루트 test 는 gui/tests 를 돌리지 않는다
```

> 루트에서 GUI 파일을 인자로 주면 **필터**로 해석되어 조용히 건너뛴다
> (`scripts/test.ts:38-41`). 위처럼 반드시 분리해서 실행한다.

추가 회귀는 다음을 증명해야 한다.

1. `Providers.tsx`에 `useCodexAccountPool(` 호출이 한 번뿐이고, 그 반환 객체가 `ProviderDetails`를 통해 Overview/Accounts 양쪽에 전달된다. 현재 독립 마운트인 `ProviderAuthPanel.tsx:40-48`이 새 훅을 직접 호출하면 실패시킨다.
2. Overview에서 `switchAccount`, `saveAlias`, `removeAccount`, `syncAfterAccountAdded` 성공 후 같은 controller의 `accounts/activeId`가 바뀌고, Accounts 탭 전환 뒤 추가 fetch를 기다리지 않아도 같은 결과가 보인다.
3. 실패한 switch/alias/remove는 기존 last-good 목록과 active id를 보존하고 presentation toast만 error로 바뀐다.
4. 늦은 첫 `load()` 응답이 빠른 두 번째 응답을 덮지 않는다(`CodexAccountPool.tsx:55-90`의 generation 회귀).
5. Codex confirm modal, add/reauth modal, alias prompt, remove confirm, toast, reset-credit popup은 controller state에 들어가지 않는다(Q6).
6. auto-switch threshold의 read/write/cancel/retry 테스트가 그대로 통과한다. `CodexAccountPool.tsx:57-91`에서 observer bridge를 빠뜨리면 이 gate가 잡아야 한다.
7. MAIN row에는 alias/remove button이 없고 focusable element도 없지만, placeholder slot 때문에 pool/OAuth row와 action 열 위치는 같다.

### 브라우저 증거

빌드한 `gui/dist`를 실제 proxy에서 띄우고 openai(Codex), OAuth provider, API-key provider 각 하나를 확인한다.

1. `#providers`에서 openai를 선택하고 Overview 기본 탭을 연다. AUTHENTICATION 텍스트 요약 대신 account list와 전환/재인증/alias/remove/add가 좌측 main column에 보이고, 우측 STATISTICS/NOTES는 이동하지 않는 스크린샷을 남긴다(`ProviderOverview.tsx:45-46,132-172`).
2. Overview에서 pool account alias를 변경한 뒤 Accounts 탭으로 이동한다. network reload나 재마운트 대기 없이 같은 alias가 즉시 보이는지 확인한다. 반대 방향(Accounts → Overview)도 한 번 확인한다.
3. Codex 계정 전환 row를 누르면 confirm이 먼저 뜨고, 승인 뒤 `다음 세션` badge와 switching 상태가 두 탭에서 같은 active id를 가리키는지 확인한다. 진행 중 기존 세션이 바뀐다고 주장하지 않는다.
4. add 완료와 remove 확인/취소/승인을 각각 실행한다. 취소 시 DELETE가 없어야 하고, 승인 시 한 번만 DELETE가 나가며 두 탭 목록이 같이 갱신돼야 한다.
5. OAuth provider에서도 Overview와 Accounts의 switch/reauth/alias/remove/add 다섯 동작이 같은 행 위치로 보이는지 확인한다(`ProviderAuthPanel.tsx:148-196`).
6. viewport/shell 폭을 wide desktop, 921px, 920px, 680px, 320px로 확인한다. 긴 한국어 alias와 긴 email/id를 넣어 horizontal page overflow, action 겹침, 잘린 focus ring이 없는지 본다. 특히 921px은 위 계산의 최소 2-column left 폭 경계다.
7. keyboard로 row main → reauth → alias → remove → add 순서를 이동한다. MAIN의 빈 alias/remove slot은 focus를 받지 않아야 한다. active/disabled row와 confirm modal의 focus 동작도 확인한다.
8. DevTools console에 오류가 없고 Network request body/console에 credential이 출력되지 않았음을 기록한다. `privacy:scan` 결과와 함께 보안 자기검토 증거로 남긴다.

## 위험

| 위험 | 실패 형태 | 방지/검증 |
| --- | --- | --- |
| 숨은 두 번째 Codex owner | Overview 조작 후 Accounts가 stale, 두 개의 polling/PUT 상태 | 훅은 `Providers.tsx`에서 한 번만 호출하고 필수 controller prop으로 내린다. `ProviderAuthPanel` 직접 훅 호출 금지. |
| DATA/PRESENTATION 경계 역전 | confirm/toast가 탭 사이에서 공유되어 다른 표면 modal이 열림 | Q6 상태 분류표대로 네 개 data state와 요청 action만 이동한다. |
| auto-switch 초기화 회귀 | threshold가 loading/error에 고정 | active 응답의 observer bridge 유지 + `codex-auto-switch-controller.test.tsx` 실행. 근거는 `CodexAccountPool.tsx:57-91`. |
| MAIN에 가짜 destructive action | 사용자가 MAIN alias/remove가 가능한 것으로 오해 | disabled button이 아닌 aria-hidden 빈 slot. focus/스크린리더 action 없음. |
| 좁은 2-column 경계 압축 | 921px 부근에서 label이 사라지거나 action이 겹침 | `min-width:0`/ellipsis 유지, action slot 고정, 921/920px browser 비교. CSS 근거는 `provider-workspace-shell.css:526-551`, `provider-workspace-settings.css:34-60`. |
| 전환 중 중복 요청 | 빠른 클릭으로 PUT 두 번, active badge 역전 | OAuth와 같은 ref guard + `switchingId`, generation 보호(`useProviderAccountPools.ts:76-97`, `CodexAccountPool.tsx:55-90`). |
| 삭제 확인 우회 | Overview에서는 즉시 DELETE, Accounts에서는 confirm | confirm은 공유 row presentation handler의 단일 진입점으로 유지하고, 훅은 확인 완료 후에만 호출한다. |
| 민감정보 노출 확대 | 공통 row/토스트에 token 또는 credential body 출력 | 기존 alias/email/id 표시만 허용하고 `privacy:scan`, console/network 자기검토를 수행한다. |
| Codex Auth 페이지 회귀 | controller 필수화 뒤 standalone 페이지가 로드되지 않음 | `CodexAuth.tsx:11-56`에서 별도 owner를 명시하고 focused auto-switch test + 실제 `#codex-auth` smoke를 실행한다. |
