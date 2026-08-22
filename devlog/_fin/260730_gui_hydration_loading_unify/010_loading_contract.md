# 010 — WP2 로딩 계약, `useKeyedClientResource` 어댑터, 공용 프리미티브

작성 2026-07-30. 유닛: `260730_gui_hydration_loading_unify`.

이 문서는 `gui/src/client-resource.ts`의 캐시·구독·취소 동작을 바꾸지 않는다. 그 파일의
`ResourceSnapshot<T>`는 정확히 `{ data, error, loading }`이고, 훅 반환값에만 `refresh()`가
붙는다([client-resource.ts:3](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:3),
[client-resource.ts:207](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:207)).
WP2는 그 결과를 화면용 상태로 판정하고, WP3가 같은 판정을 소비하게 만든다.

> **A 감사(2026-07-30) 정정 — 이 문서의 전제가 틀렸다.**
>
> 초안은 "리소스 계층을 건드리지 않는다"를 원칙으로 삼았다. 그 원칙대로 만들면
> **사용자가 말한 느린 로딩에 스피너가 뜨지 않는다.** `runFetch`는 캐시 데이터가 있으면
> `loading`을 올리지 않고([client-resource.ts:119](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:119)),
> 요청 시작 시점에 `emit`조차 하지 않는다. 폴링 틱도 인플라이트 중이면 건너뛴다
> ([client-resource.ts:99](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:99)).
> 따라서 `loading-with-stale-data`는 `forceLoading` 경로에서만 발화하는 사실상 죽은 상태였다.
>
> 사용자 정정된 목표는 "기능은 되는데 너무 느리게 로딩되니 스피너를 도입하자"다. 실측
> `/api/codex-auth/accounts?refresh=1` = 908ms, 서버 콜드 경로는 `8s × ceil(계정수/4)`.
> 그 구간을 보이게 만드는 것이 WP2의 존재 이유다.
>
> 그래서 §0을 추가해 리소스 계층에 **요청 인플라이트 신호를 최소 침습으로 도입**하고,
> §1의 상태 모델에 `disabled`를 더하고, 실패 판별을 `error !== undefined`에서 분리한다.
> 아래 §0이 §1~§6보다 먼저 구현된다.

## 0. 리소스 계층 최소 확장 (A 감사 블로커 1·2·3·4 대응)

세 가지를 `gui/src/client-resource.ts`에 더한다. 캐시·구독·취소·폴링 동작은 그대로 둔다.

### 0.1 `refreshing` — 콘텐츠를 지우지 않는 인플라이트 신호

`loading`은 "콘텐츠를 로더로 대체해도 되는 상태"라는 기존 의미를 유지한다. 새 `refreshing`은
"요청이 떠 있다"만 뜻한다. 둘을 나누지 않으면 조용한 폴링에서 화면이 비워진다.

```diff
 export type ResourceSnapshot<T> = {
   data: T | undefined;
   error: unknown;
   loading: boolean;
+  /** A request is in flight. Unlike `loading`, this never means "replace the content". */
+  refreshing: boolean;
+  /** Set once a fetch has resolved successfully for this key. Survives later failures. */
+  hasSucceeded: boolean;
+  /** False when the latest settled attempt failed. Distinguishes stale-but-shown from healthy. */
+  lastAttemptOk: boolean;
 };
```

`runFetch` 진입부에서 `refreshing`을 세우고 emit한다. 기존 `loading` 승격 조건은 건드리지 않는다.

```diff
   const gen = ++store.generation;

-  // Falsy cached values stay visible during polls; forceLoading is for identity changes (deps).
-  if (store.snapshot.data === undefined || options?.forceLoading) {
-    store.snapshot = { ...store.snapshot, loading: true };
-    emit(store);
-  }
+  // Falsy cached values stay visible during polls; forceLoading is for identity changes (deps).
+  // `refreshing` always rises so a slow revalidation is observable without blanking content.
+  const shouldShowLoading = store.snapshot.data === undefined || options?.forceLoading === true;
+  store.snapshot = {
+    ...store.snapshot,
+    loading: shouldShowLoading ? true : store.snapshot.loading,
+    refreshing: true,
+  };
+  emit(store);

   try {
     const data = await fetcher(controller.signal);
     if (gen !== store.generation || controller.signal.aborted) return;
-    store.snapshot = { data, error: undefined, loading: false };
+    store.snapshot = {
+      data,
+      error: undefined,
+      loading: false,
+      refreshing: false,
+      hasSucceeded: true,
+      lastAttemptOk: true,
+    };
   } catch (error) {
     if (gen !== store.generation || controller.signal.aborted) return;
-    store.snapshot = { ...store.snapshot, error, loading: false };
+    // Normalize so a loader that rejects with `undefined` still reads as a failure.
+    store.snapshot = {
+      ...store.snapshot,
+      error: error === undefined ? new Error("resource load failed") : error,
+      loading: false,
+      refreshing: false,
+      lastAttemptOk: false,
+    };
   } finally {
```

`finally`는 이미 `emit(store)`를 호출하므로 취소 경로에서도 `refreshing`이 내려간다. 다만
`gen !== store.generation`으로 조기 반환한 경우 이 스토어는 이미 새 요청이 소유하므로
그 요청의 `refreshing: true`가 유지되는 것이 옳다.

`abortInflightOwnedBy`는 스냅샷을 쓰지 않으므로 `refreshing`을 직접 내려 준다.

```diff
 function abortInflightOwnedBy<T>(store: Store<T>, owner: () => void): boolean {
   if (store.inflightOwner !== owner) return false;
   store.inflight?.abort();
   store.inflight = null;
   store.inflightOwner = null;
   store.generation++;
+  if (store.snapshot.refreshing) {
+    store.snapshot = { ...store.snapshot, refreshing: false };
+    emit(store);
+  }
   return true;
 }
```

초기 스냅샷과 `EMPTY_SNAPSHOT`, `setClientResourceData`도 새 필드를 채운다.

```diff
-const EMPTY_SNAPSHOT: ResourceSnapshot<never> = { data: undefined, error: undefined, loading: false };
+const EMPTY_SNAPSHOT: ResourceSnapshot<never> = {
+  data: undefined, error: undefined, loading: false,
+  refreshing: false, hasSucceeded: false, lastAttemptOk: false,
+};
```

```diff
 export function setClientResourceData<T>(key: string, data: T) {
   ...
-  store.snapshot = { data, error: undefined, loading: false };
+  store.snapshot = {
+    data, error: undefined, loading: false,
+    refreshing: false, hasSucceeded: true, lastAttemptOk: true,
+  };
```

### 0.2 왜 어댑터의 `attemptsRef`를 버리는가

감사 블로커 5: `attemptsRef`는 `useLayoutEffect`에서 쓰고 렌더에서 읽는 두 번째 상태원이라
`useSyncExternalStore`의 일관성 보장을 벗어난다. 성공→실패가 한 배치에 묶이면 `data + error`를
보면서 `hasEverSucceeded: false`로 읽어 `failed-cold`로 잘못 분류할 수 있다.

`hasSucceeded` / `lastAttemptOk`를 스토어 스냅샷에 넣으면 이 문제가 사라진다. 성공·실패와 같은
시점에 원자적으로 갱신되고, 모든 구독자가 같은 값을 본다. 어댑터는 순수 판정 함수가 된다.

### 0.3 기존 호출부 영향

`ResourceSnapshot`에 필드를 추가하는 것은 구조적 확장이라 기존 소비자는 컴파일이 깨지지 않는다.
`{ data, error, loading }`을 구조분해하는 코드는 그대로 동작한다. 스냅샷 객체를 리터럴로
**생성**하는 곳만 새 필드가 필요하고, 그건 `client-resource.ts` 내부와 테스트 픽스처뿐이다.
구현 시 `rg -n "loading: false" gui/src gui/tests`로 전수 확인한다.

`useKeyedClientResource`는 첫 구독에서 동기적으로 `runFetch()`를 시작한다
([client-resource.ts:179](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:179)).
따라서 마운트 페치를 `setTimeout(..., 0)`로 늦추는 방식은 이 문서의 이관 대상에서 금지한다.
실제 0ms 타이머 구현은 cleanup에서 타이머를 취소하므로 마운트 직후 언마운트하면 요청 자체가
사라진다([ProviderWorkspaceShell.tsx:134](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:134)).

## 1. 계약 정의 (contract)

### 상태 타입

§0의 스토어 확장을 전제로 한다. 상태는 일곱 개다. A 감사에서 `disabled`가 빠져 있어
`enabled: false` 표면이 영구 스켈레톤을 그리는 결함이 지적됐다(블로커 3). 대시보드의
wave-2 리소스처럼 의도적으로 꺼진 표면이 실재한다
([use-dashboard-data.ts:232](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:232)).

`undefined`는 기존 리소스 계층에서 아직 성공 데이터가 없다는 센티널이다. 그러므로 loader는
성공값으로 `undefined`를 반환하면 안 된다. 값 없는 성공을 표현해야 하면 `null` 또는 명시적인
DTO를 쓴다. `isEmpty`는 페이지가 자기 DTO의 빈 결과를 정하게 한다.

```ts
export type DataSurfaceState<T> =
  | {
      kind: "cold";
      data: undefined;
      error: undefined;
      loading: boolean;
      hasEverSucceeded: false;
      lastAttemptSucceeded: false;
    }
  | {
      kind: "loading-with-stale-data";
      data: T;
      error: unknown | undefined;
      loading: true;
      hasEverSucceeded: true;
      lastAttemptSucceeded: boolean;
    }
  | {
      kind: "ready-empty";
      data: T;
      error: undefined;
      loading: false;
      hasEverSucceeded: true;
      lastAttemptSucceeded: true;
    }
  | {
      kind: "ready-populated";
      data: T;
      error: undefined;
      loading: false;
      hasEverSucceeded: true;
      lastAttemptSucceeded: true;
    }
  | {
      kind: "failed-cold";
      data: undefined;
      error: unknown;
      loading: false;
      hasEverSucceeded: false;
      lastAttemptSucceeded: false;
    }
  | {
      kind: "failed-with-stale";
      data: T;
      error: unknown;
      loading: false;
      hasEverSucceeded: true;
      lastAttemptSucceeded: false;
    };
```

| `kind` | 진입 조건 | 화면 처리 |
|---|---|---|
| `cold` | 성공 이력·데이터·오류가 없고 첫 구독이 진행 중이거나 막 시작한 순간 | 실제 페이지 밀도를 닮은 `DataSurfaceSkeleton`을 보여 준다. `loading`이 아직 `false`인 첫 렌더도 같은 처리다. 구독 직후 훅이 `loading`을 올리므로 별도 타이머를 두지 않는다. |
| `loading-with-stale-data` | 성공 데이터가 남아 있고 새 시도가 진행 중 | 기존 행·카드·값을 유지하고 해당 영역에 `aria-busy`와 작은 `DataSurfaceStatus`만 더한다. 기존 리소스도 데이터가 있을 때 조용한 poll에서 화면을 지우지 않는다([client-resource.ts:119](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:119)). |
| `ready-empty` | 마지막 시도가 성공했고 `isEmpty(data)`가 참 | 페이지 고유 `*.empty` 상태를 보여 준다. 로더나 실패 배너를 섞지 않는다. |
| `ready-populated` | 마지막 시도가 성공했고 `isEmpty(data)`가 거짓 | 정상 콘텐츠만 그린다. |
| `failed-cold` | 성공한 적 없고 마지막 시도가 실패 | 콘텐츠 자리에 페이지 고유 `*.loadFail`과 재시도를 보여 준다. 빈 상태를 대신 쓰지 않는다. |
| `failed-with-stale` | 과거 성공 데이터는 있으나 마지막 시도가 실패 | stale 콘텐츠는 보존하되, 콘텐츠 위 또는 바로 앞에 오류 `Notice`와 재시도를 반드시 보인다. 이는 `ready-*`가 아니다. 빈 성공(`[]`)도 성공 이력이므로 다음 실패가 이 상태로 와야 한다. |

`hasEverSucceeded`와 `lastAttemptSucceeded`는 같은 불리언으로 축약하지 않는다. 전자는
stale 데이터를 표시해도 되는지, 후자는 마지막 통신 결과가 정상인지 결정한다. 현재 계정 풀은
빈 성공에서도 `hasLoadedRef`를 세워 이후 오류 상태를 감출 수 있다
([useCodexAccountPool.ts:109](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:109),
[useCodexAccountPool.ts:148](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:148)).
이 계약에서는 `[] → 실패`가 `failed-with-stale`이므로, 빈 결과를 조용한 정상 상태로 굳히지
않는다.

### 1.1 정정된 상태 모델 (A 감사 반영 — 위 블록을 대체한다)

> ⛔ **이 절(§1.1·§1.2)도 §10.1로 대체됨.** 일곱 상태와 이 절의 판정 순서는 A 감사 R2에서
> 다시 거부됐다(콜드 재시도가 정지 화면이 되는 문제). **실제 구현은 §10.1의 여덟 상태**를 쓴다.
> 아래는 `disabled` 도입과 스토어 기반 판정으로 옮긴 중간 단계 기록이다.

위 여섯-상태 타입과 표는 §0 이전 설계다. 실제 구현은 아래 일곱 상태를 쓴다. 차이는
`disabled` 추가, 판정 근거를 스토어 스냅샷 필드로 이동, `refreshing`을 stale 재검증의
진짜 트리거로 삼는 것이다.

```ts
export type DataSurfaceKind =
  | "disabled"
  | "cold"
  | "loading-with-stale-data"
  | "ready-empty"
  | "ready-populated"
  | "failed-cold"
  | "failed-with-stale";

export type DataSurfaceState<T> = {
  kind: DataSurfaceKind;
  /** Present for every kind that shows content: ready-*, loading-with-stale-data, failed-with-stale. */
  data: T | undefined;
  error: unknown;
  /** True only when the content area should be replaced by a skeleton. */
  showSkeleton: boolean;
  /** True while a request is in flight; drives the inline status line and aria-busy. */
  refreshing: boolean;
  /** True when the latest settled attempt failed, so the error banner must stay visible. */
  showError: boolean;
};
```

판정을 유니온 대신 플랫 레코드로 두는 이유는 WP3의 15개 표면이 `kind`로 분기하면서도
`showSkeleton` / `refreshing` / `showError`를 그대로 JSX 조건에 꽂아 쓰기 때문이다. 유니온
판별을 강제하면 표면마다 일곱 갈래 switch를 쓰게 되고, 실제로 필요한 건 세 개의 불리언과
빈/정상 구분이다.

| `kind` | 진입 조건 | `showSkeleton` | `refreshing` | `showError` | 화면 처리 |
|---|---|---|---|---|---|
| `disabled` | `enabled === false` | false | false | false | 아무것도 그리지 않거나 호출부의 게이트 문구. 스켈레톤 금지 |
| `cold` | 성공 이력 없고 데이터 없음, 오류 없음 | true | 스냅샷 값 | false | 페이지 밀도를 닮은 스켈레톤 |
| `loading-with-stale-data` | 데이터 있고 요청 인플라이트 | false | true | 직전 실패 시 true | 기존 콘텐츠 유지 + 인라인 상태줄 + `aria-busy` |
| `ready-empty` | 마지막 시도 성공, `isEmpty(data)` 참 | false | false | false | 페이지 고유 빈 상태 |
| `ready-populated` | 마지막 시도 성공, `isEmpty(data)` 거짓 | false | false | false | 정상 콘텐츠 |
| `failed-cold` | 성공 이력 없고 마지막 시도 실패 | false | false | true | 콘텐츠 자리에 실패 + 재시도 |
| `failed-with-stale` | 성공 이력 있고 마지막 시도 실패 | false | false | true | stale 콘텐츠 유지 + 상단 오류 배너 + 재시도 |

`loading-with-stale-data`가 실제로 발화하는 것이 이 사이클의 핵심 활성화 증거다. 조용한
폴링에서 `refreshing`만 오르고 `loading`은 그대로이므로, 908ms짜리 재검증에서 콘텐츠가
유지된 채 상태줄이 뜬다. 이것이 사용자가 요청한 스피너다.

### 1.2 정정된 판정 함수

```ts
function classify<T>(
  snapshot: ResourceSnapshot<T>,
  isEmpty: (data: T) => boolean,
  enabled: boolean,
): DataSurfaceState<T> {
  if (!enabled) {
    return { kind: "disabled", data: undefined, error: undefined, showSkeleton: false, refreshing: false, showError: false };
  }

  const failed = !snapshot.lastAttemptOk && snapshot.error !== undefined;
  const hasData = snapshot.data !== undefined;

  if (hasData && snapshot.refreshing) {
    return {
      kind: "loading-with-stale-data",
      data: snapshot.data, error: snapshot.error,
      showSkeleton: false, refreshing: true, showError: failed,
    };
  }

  if (failed) {
    return hasData
      ? { kind: "failed-with-stale", data: snapshot.data, error: snapshot.error, showSkeleton: false, refreshing: false, showError: true }
      : { kind: "failed-cold", data: undefined, error: snapshot.error, showSkeleton: false, refreshing: false, showError: true };
  }

  if (!hasData) {
    return { kind: "cold", data: undefined, error: undefined, showSkeleton: true, refreshing: snapshot.refreshing, showError: false };
  }

  return {
    kind: isEmpty(snapshot.data as T) ? "ready-empty" : "ready-populated",
    data: snapshot.data, error: undefined,
    showSkeleton: false, refreshing: false, showError: false,
  };
}
```

`failed` 판별이 `lastAttemptOk`와 `error`를 함께 보므로, 실패 후 성공이 오면 `lastAttemptOk`가
참으로 돌아가 오류 배너가 사라진다. 로더가 `undefined`를 throw해도 §0.1의 정규화가 있으므로
`error !== undefined`가 성립한다(감사 블로커 4).

## 2. 어댑터 (adapter)

> ## ⛔ SUPERSEDED — 구현하지 말 것
>
> 이 절(§2)의 코드는 A 감사 R1에서 거부된 초안이다. `attemptsRef`를 렌더에서 읽는 설계는
> 폐기됐다(감사 블로커 5). 실제 구현은 **§10 확정 구현**을 쓴다. 이 절은 설계 변경 이력을
> 남기기 위해서만 보존한다.

새 파일은 **`/Users/jun/Developer/new/700_projects/opencodex/gui/src/data-surface.ts`**다.
이름은 `useDataSurface`로 정한다. 이것은 새 cache/store/resource가 아니라 기존 keyed resource의
스냅샷을 화면 상태로 번역한다는 뜻이며, source의 `useKeyedClientResource()`를 한 번만 호출한다.
기존 훅은 deps 변경에서 stale 데이터를 보존한 채 `forceLoading` 재검증을 시작하므로
([client-resource.ts:266](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:266)),
어댑터가 별도 fetch·effect·timer를 만들 이유가 없다.

```ts
import { useLayoutEffect, useRef } from "react";
import {
  type ResourceSnapshot,
  useKeyedClientResource,
} from "./client-resource";

export type DataSurfaceState<T> =
  | {
      kind: "cold";
      data: undefined;
      error: undefined;
      loading: boolean;
      hasEverSucceeded: false;
      lastAttemptSucceeded: false;
    }
  | {
      kind: "loading-with-stale-data";
      data: T;
      error: unknown | undefined;
      loading: true;
      hasEverSucceeded: true;
      lastAttemptSucceeded: boolean;
    }
  | {
      kind: "ready-empty";
      data: T;
      error: undefined;
      loading: false;
      hasEverSucceeded: true;
      lastAttemptSucceeded: true;
    }
  | {
      kind: "ready-populated";
      data: T;
      error: undefined;
      loading: false;
      hasEverSucceeded: true;
      lastAttemptSucceeded: true;
    }
  | {
      kind: "failed-cold";
      data: undefined;
      error: unknown;
      loading: false;
      hasEverSucceeded: false;
      lastAttemptSucceeded: false;
    }
  | {
      kind: "failed-with-stale";
      data: T;
      error: unknown;
      loading: false;
      hasEverSucceeded: true;
      lastAttemptSucceeded: false;
    };

export type DataSurfaceResource<T> = ResourceSnapshot<T> & {
  refresh: (opts?: { forceLoading?: boolean }) => void;
  state: DataSurfaceState<T>;
};

export type DataSurfaceOptions<T> = {
  /** The page owns its domain-specific definition of an empty successful DTO. */
  isEmpty: (data: T) => boolean;
  pollMs?: number;
  enabled?: boolean;
};

type AttemptMemory = {
  hasEverSucceeded: boolean;
  lastAttemptSucceeded: boolean;
};

function classifyDataSurface<T>(
  snapshot: ResourceSnapshot<T>,
  isEmpty: (data: T) => boolean,
  attempts: AttemptMemory,
): DataSurfaceState<T> {
  const hasStaleData = attempts.hasEverSucceeded && snapshot.data !== undefined;

  if (snapshot.loading && snapshot.data !== undefined) {
    return {
      kind: "loading-with-stale-data",
      data: snapshot.data,
      error: snapshot.error,
      loading: true,
      hasEverSucceeded: true,
      lastAttemptSucceeded: attempts.lastAttemptSucceeded,
    };
  }

  if (snapshot.error !== undefined) {
    if (hasStaleData) {
      return {
        kind: "failed-with-stale",
        data: snapshot.data!,
        error: snapshot.error,
        loading: false,
        hasEverSucceeded: true,
        lastAttemptSucceeded: false,
      };
    }
    return {
      kind: "failed-cold",
      data: undefined,
      error: snapshot.error,
      loading: false,
      hasEverSucceeded: false,
      lastAttemptSucceeded: false,
    };
  }

  if (snapshot.data === undefined) {
    return {
      kind: "cold",
      data: undefined,
      error: undefined,
      loading: snapshot.loading,
      hasEverSucceeded: false,
      lastAttemptSucceeded: false,
    };
  }

  return isEmpty(snapshot.data)
    ? {
        kind: "ready-empty",
        data: snapshot.data,
        error: undefined,
        loading: false,
        hasEverSucceeded: true,
        lastAttemptSucceeded: true,
      }
    : {
        kind: "ready-populated",
        data: snapshot.data,
        error: undefined,
        loading: false,
        hasEverSucceeded: true,
        lastAttemptSucceeded: true,
      };
}

/**
 * Keeps request ownership in client-resource while giving pages one exhaustive render
 * switch. Attempt history lives here because an empty successful DTO must preserve its
 * success history without making a later failed refresh look ready.
 */
export function useDataSurface<T>(
  key: string,
  deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options: DataSurfaceOptions<T>,
): DataSurfaceResource<T> {
  const { isEmpty, ...resourceOptions } = options;
  const resource = useKeyedClientResource(key, deps, load, resourceOptions);
  const attemptsRef = useRef<AttemptMemory>({
    // Stored data is only written by a resolved fetch or explicit cache publication.
    hasEverSucceeded: resource.data !== undefined,
    lastAttemptSucceeded: resource.data !== undefined
      && resource.error === undefined
      && !resource.loading,
  });

  useLayoutEffect(() => {
    if (resource.loading) return;
    if (resource.error !== undefined) {
      attemptsRef.current.lastAttemptSucceeded = false;
      return;
    }
    if (resource.data !== undefined) {
      attemptsRef.current.hasEverSucceeded = true;
      attemptsRef.current.lastAttemptSucceeded = true;
    }
  }, [resource.data, resource.error, resource.loading]);

  return {
    ...resource,
    state: classifyDataSurface(resource, isEmpty, attemptsRef.current),
  };
}
```

`resource.data !== undefined`으로 초기 `hasEverSucceeded`를 seed하는 이유는 keyed store가 모듈
캐시를 공유하기 때문이다. `setClientResourceData()`도 같은 snapshot으로 good data를 publish한다
([client-resource.ts:292](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:292)).
성공 직후의 layout effect는 StrictMode에서 두 번 실행되어도 같은 두 값을 다시 쓰는 idempotent
연산이다. 앱 루트는 StrictMode를 켠 상태다([main.tsx:7](/Users/jun/Developer/new/700_projects/opencodex/gui/src/main.tsx:7)).

## 3. 프리미티브 컴포넌트 (primitives)

> ## ⛔ SUPERSEDED — 구현하지 말 것
>
> `DataSurfaceStatus`에 `live` prop이 없어 라이브 리전 이중 알림을 유발한다(감사 블로커 6).
> 실제 구현은 **§10.2**를 쓴다.

새 파일은 **`/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/data-surface.tsx`**다.
기존 `gui/src/ui.tsx`는 `Switch`, `Notice`, `Select`, `EmptyState`처럼 범용 조작 위젯을 모은
파일이다([ui.tsx:8](/Users/jun/Developer/new/700_projects/opencodex/gui/src/ui.tsx:8),
[ui.tsx:233](/Users/jun/Developer/new/700_projects/opencodex/gui/src/ui.tsx:233)). WP2의 컴포넌트는
데이터 상태 표현만 다루므로 `components/`에 별도 파일로 둔다.

**카드/row 프리미티브는 export하지 않는다.** `.setting-row`와 `.setting-label`의 실제 규칙은
이미 존재하고([styles.css:1831](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1831)),
WP6가 카드 패딩·스위치 중심선·구조를 함께 결정해야 한다. WP2가 loading 목적의 얕은 카드
래퍼를 만들면 그 결정을 선점하고 WP6의 검증 범위를 흐린다. 따라서 WP6는 이 결정으로 **WP1
뒤 병렬 착수 가능**이며, WP3만 WP2의 어댑터·프리미티브에 순차 의존한다
([000_plan.md:35](/Users/jun/Developer/new/700_projects/opencodex/devlog/_fin/260730_gui_hydration_loading_unify/000_plan.md:35),
[000_plan.md:38](/Users/jun/Developer/new/700_projects/opencodex/devlog/_fin/260730_gui_hydration_loading_unify/000_plan.md:38)).

```tsx
import type { CSSProperties, ReactNode } from "react";

type DataSurfaceSkeletonBlockProps = {
  className?: string;
  style?: CSSProperties;
};

/**
 * Lets a page mirror its ready geometry without exposing fake values to assistive
 * technology. The parent owns the one announced loading sentence.
 */
export function DataSurfaceSkeletonBlock({
  className,
  style,
}: DataSurfaceSkeletonBlockProps) {
  return (
    <span
      aria-hidden="true"
      className={className ? `data-surface-skeleton__block ${className}` : "data-surface-skeleton__block"}
      style={style}
    />
  );
}

type DataSurfaceSkeletonProps = {
  label: string;
  rows?: number;
  className?: string;
};

/**
 * Keeps the cold surface non-empty from its first commit; callers add local layout
 * classes when a list, card, or table needs a more exact silhouette.
 */
export function DataSurfaceSkeleton({
  label,
  rows = 3,
  className,
}: DataSurfaceSkeletonProps) {
  const count = Math.max(1, Math.floor(rows));
  return (
    <div
      className={className ? `data-surface-skeleton ${className}` : "data-surface-skeleton"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <div className="data-surface-skeleton__row" key={index} aria-hidden="true">
          <DataSurfaceSkeletonBlock />
        </div>
      ))}
    </div>
  );
}

type DataSurfaceStatusProps = {
  children: ReactNode;
  busy?: boolean;
  className?: string;
};

/**
 * Announces a revalidation without replacing visible stale content, so a short poll
 * remains audible but does not turn a populated page into an empty loading screen.
 */
export function DataSurfaceStatus({
  children,
  busy = true,
  className,
}: DataSurfaceStatusProps) {
  return (
    <div
      className={className ? `data-surface-status ${className}` : "data-surface-status"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={busy || undefined}
    >
      {busy && <span className="spin" aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}
```

`DataSurfaceSkeleton`의 내부 텍스트는 기존 `.sr-only` 규칙으로만 읽히고
([styles.css:2030](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:2030)),
shimmer block은 `aria-hidden`이다. 따라서 한 로딩 전환마다 상태 문장 하나만 polite로 읽힌다.
실패는 이 프리미티브가 아니라 기존 `Notice tone="err"`와 retry button으로 표시한다. `Notice`도
이미 status role을 사용한다([ui.tsx:17](/Users/jun/Developer/new/700_projects/opencodex/gui/src/ui.tsx:17)).

## 4. CSS

수정 파일은 **`/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css`**다. `.spin`과
`@keyframes spin` 바로 뒤(현재 917–918행)에 아래 블록을 삽입한다. 기존
`codex-auth-skeleton-shimmer`는 1003행 계열에서 이미 사용되고
([styles.css:1009](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1009)), keyframes는
1279행에 이미 정의되어 있다([styles.css:1279](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1279)).
새 animation이나 token은 만들지 않는다. 간격·높이·색·radius는 기존 token만 쓴다
([styles.css:57](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:57),
[styles.css:108](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:108)).

기존 rule의 수정은 없다. 아래는 anchor 전후와 삽입 내용이다.

```css
/* before — existing */
.spin { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: var(--radius-round); display: inline-block; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* add immediately after the existing keyframes */
.data-surface-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-md);
  color: var(--muted);
  font-size: var(--text-control);
  line-height: var(--leading-body);
}

.data-surface-skeleton {
  display: grid;
  gap: var(--space-2);
}

.data-surface-skeleton__row {
  min-height: var(--control-lg);
}

.data-surface-skeleton__block {
  display: block;
  min-height: var(--control-lg);
  width: 100%;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--raised) 0%, var(--surface) 50%, var(--raised) 100%);
  background-size: 200% 100%;
  animation: codex-auth-skeleton-shimmer 1.2s ease-in-out infinite;
}

/* after — existing */
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
```

기존 reduced-motion rule가 새 block에도 그대로 적용되므로 별도 media query를 추가하지 않는다
([styles.css:920](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:920)).

## 5. i18n

새 key는 필요 없다. 프리미티브는 `label`/`children`을 받으므로 페이지가 이미 소유한
`common.loading`, `pws.accountsLoading`, `*.loadFail`, `*.empty` key를 전달한다. 영어 source key는
`common.loading`과 `common.retry`를 이미 가진다([en.ts:13](/Users/jun/Developer/new/700_projects/opencodex/gui/src/i18n/en.ts:13));
한국어에도 대응 key가 있다([ko.ts:13](/Users/jun/Developer/new/700_projects/opencodex/gui/src/i18n/ko.ts:13)).
현재 locale은 en, de, ko, zh, ru, ja 여섯 개다
([shared.ts:9](/Users/jun/Developer/new/700_projects/opencodex/gui/src/i18n/shared.ts:9)). 따라서 six-locale
추가 표도 없다.

WP3 호출 규칙은 다음처럼 단순하다.

```tsx
<DataSurfaceSkeleton label={t("models.loading")} rows={4} />
<DataSurfaceStatus>{t("common.loading")}</DataSurfaceStatus>
<Notice tone="err">{t("models.loadFail")}</Notice>
```

새 상태 문구가 실제로 필요해질 때만 en.ts에 key를 먼저 추가하고, de/ko/zh/ru/ja에 같은 key를
동시에 넣는다. `Record<TKey, string>` locale 선언이 누락을 compile-time에 잡는다
([ko.ts:1](/Users/jun/Developer/new/700_projects/opencodex/gui/src/i18n/ko.ts:1),
[shared.ts:12](/Users/jun/Developer/new/700_projects/opencodex/gui/src/i18n/shared.ts:12)).

## 6. 테스트

> ## ⛔ SUPERSEDED — 구현하지 말 것
>
> 이 절의 테스트는 제거된 필드(`hasEverSucceeded`, `lastAttemptSucceeded`)를 단언하고
> `forceLoading` 경로만 다룬다(감사 블로커 7). 실제 테스트 요구사항은 **§9.4 표**이고
> 하네스 골격만 이 절에서 재사용한다.

새 파일은 **`/Users/jun/Developer/new/700_projects/opencodex/gui/tests/data-surface.test.tsx`**다.
happy-dom globals를 저장·복구하고 `act()` 안에서 mount/unmount하는 기존 GUI 테스트 형식을 따른다
([codex-account-pool-behaviour.test.tsx:30](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-account-pool-behaviour.test.tsx:30),
[codex-account-pool-behaviour.test.tsx:97](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-account-pool-behaviour.test.tsx:97)).
기존 resource 테스트도 `waitFor()`로 external-store 비동기 결과를 관찰한다
([client-resource-poll.test.tsx:29](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/client-resource-poll.test.tsx:29)).

```tsx
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { type DataSurfaceResource, useDataSurface } from "../src/data-surface";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../src/components/data-surface";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("classifies cold, populated, stale revalidation, and stale failure separately", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const gates: Deferred<string[]>[] = [];
  let seen: DataSurfaceResource<string[]> | null = null;
  let setRevision!: (revision: number) => void;

  function Probe({ revision }: { revision: number }) {
    seen = useDataSurface(
      "data-surface-state-a",
      [revision],
      async () => {
        const gate = deferred<string[]>();
        gates.push(gate);
        return gate.promise;
      },
      { isEmpty: data => data.length === 0 },
    );
    return <div data-kind={seen.state.kind} />;
  }

  function Harness() {
    const [revision, setRevisionState] = useState(0);
    setRevision = setRevisionState;
    return <Probe revision={revision} />;
  }

  await act(async () => {
    root = createRoot(host);
    root.render(<Harness />);
  });
  await waitFor(() => gates.length === 1 && seen?.state.kind === "cold");
  expect(seen?.state).toMatchObject({
    kind: "cold",
    hasEverSucceeded: false,
    lastAttemptSucceeded: false,
  });

  await act(async () => {
    gates[0]!.resolve(["row"]);
    await Promise.resolve();
  });
  await waitFor(() => seen?.state.kind === "ready-populated");
  expect(seen?.state).toMatchObject({
    hasEverSucceeded: true,
    lastAttemptSucceeded: true,
  });

  await act(async () => { setRevision(1); });
  await waitFor(() => gates.length === 2 && seen?.state.kind === "loading-with-stale-data");
  expect(seen?.state).toMatchObject({ data: ["row"], loading: true });

  await act(async () => {
    gates[1]!.reject(new Error("refresh failed"));
    await Promise.resolve();
  });
  await waitFor(() => seen?.state.kind === "failed-with-stale");
  expect(seen?.state).toMatchObject({
    data: ["row"],
    hasEverSucceeded: true,
    lastAttemptSucceeded: false,
  });
});

test("an empty success followed by failure is failed-with-stale, not ready-empty", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const gates: Deferred<string[]>[] = [];
  let seen: DataSurfaceResource<string[]> | null = null;
  let setRevision!: (revision: number) => void;

  function Probe({ revision }: { revision: number }) {
    seen = useDataSurface(
      "data-surface-empty-then-fail",
      [revision],
      async () => {
        const gate = deferred<string[]>();
        gates.push(gate);
        return gate.promise;
      },
      { isEmpty: data => data.length === 0 },
    );
    return null;
  }

  function Harness() {
    const [revision, setRevisionState] = useState(0);
    setRevision = setRevisionState;
    return <Probe revision={revision} />;
  }

  await act(async () => {
    root = createRoot(host);
    root.render(<Harness />);
  });
  await waitFor(() => gates.length === 1);
  await act(async () => {
    gates[0]!.resolve([]);
    await Promise.resolve();
  });
  await waitFor(() => seen?.state.kind === "ready-empty");

  await act(async () => { setRevision(1); });
  await waitFor(() => gates.length === 2 && seen?.state.kind === "loading-with-stale-data");
  await act(async () => {
    gates[1]!.reject(new Error("second request failed"));
    await Promise.resolve();
  });
  await waitFor(() => seen?.state.kind === "failed-with-stale");
  expect(seen?.state).toMatchObject({
    data: [],
    hasEverSucceeded: true,
    lastAttemptSucceeded: false,
  });
});

test("a first-request failure is failed-cold", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const gate = deferred<string[]>();
  let seen: DataSurfaceResource<string[]> | null = null;

  function Probe() {
    seen = useDataSurface(
      "data-surface-failed-cold",
      [],
      async () => gate.promise,
      { isEmpty: data => data.length === 0 },
    );
    return null;
  }

  await act(async () => {
    root = createRoot(host);
    root.render(<Probe />);
  });
  await waitFor(() => seen?.state.kind === "cold");
  await act(async () => {
    gate.reject(new Error("first request failed"));
    await Promise.resolve();
  });
  await waitFor(() => seen?.state.kind === "failed-cold");
  expect(seen?.state).toMatchObject({
    hasEverSucceeded: false,
    lastAttemptSucceeded: false,
  });
});

test("a mount followed immediately by unmount still starts the keyed request", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  let calls = 0;

  function Probe() {
    useDataSurface(
      "data-surface-immediate-unmount",
      [],
      async () => {
        calls += 1;
        return new Promise<string[]>(() => {});
      },
      { isEmpty: data => data.length === 0 },
    );
    return null;
  }

  await act(async () => {
    root = createRoot(host);
    root.render(<Probe />);
  });
  expect(calls).toBe(1);

  await act(async () => {
    root!.unmount();
    root = null;
  });
});

test("shared loading primitives announce one polite busy status", () => {
  const html = renderToStaticMarkup(
    <>
      <DataSurfaceSkeleton label="Loading models" rows={2} />
      <DataSurfaceStatus>Refreshing models</DataSurfaceStatus>
    </>,
  );

  expect(html).toContain('class="data-surface-skeleton"');
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('class="spin"');
});
```

이 파일은 여섯 상태를 모두 관찰한다. 첫 테스트가 `cold`, `ready-populated`,
`loading-with-stale-data`, `failed-with-stale`를, 두 번째가 `ready-empty`와 빈 성공 뒤 실패를,
세 번째가 `failed-cold`를 고정한다. 마지막 mount/unmount test는 `setTimeout(..., 0)`을 다시
도입했을 때 같은 turn 안에 `calls === 1`을 만족하지 못하게 만든다.

## 7. 마이그레이션 계약

> ## ⛔ 부분 SUPERSEDED
>
> 여섯 상태 기준으로 쓰였다. 실제 분기는 **§10.1의 여덟 상태**와 `showSkeleton`/`refreshing`/
> `showError` 세 불리언을 쓴다. 아래 절차의 취지(마운트 즉시 구독, 0ms 타이머 폐기)는 유효하다.

WP3가 계획의 15개 표면 중 하나를 옮길 때 아래를 순서대로 적용한다. 한 페이지에 여러 독립 DTO가
있으면 DTO마다 이 체크리스트를 적용하되, 페이지의 준비 여부를 한 DTO의 성공으로 대신 판단하지
않는다([000_plan.md:54](/Users/jun/Developer/new/700_projects/opencodex/devlog/_fin/260730_gui_hydration_loading_unify/000_plan.md:54)).

- 기존 fetch entry point와 현재 cache key를 찾고, `useDataSurface(key, deps, load, { isEmpty, pollMs, enabled })`로 교체한다. 새 `useState` cache, 새 `useEffect` fetch, 새 module map을 만들지 않는다.
- `load(signal)`은 기존 endpoint와 `AbortSignal`을 그대로 전달하고, 실패 응답은 throw한다. 성공값으로 `undefined`를 반환하지 않는다.
- `setTimeout(() => void load(), 0)` 및 cleanup의 `clearTimeout`을 제거한다. mount 직후 구독이 request를 시작하는 것을 사용한다. 0ms 타이머가 있는 provider workspace 예시는 134–161행이다([ProviderWorkspaceShell.tsx:134](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:134)).
- 렌더는 `switch (surface.state.kind)`의 여섯 case를 모두 가진다. `cold`는 `DataSurfaceSkeleton`; `loading-with-stale-data`는 기존 data + `DataSurfaceStatus` + `aria-busy`; `ready-empty`는 기존 empty; `ready-populated`은 콘텐츠; `failed-cold`는 오류 + retry; `failed-with-stale`은 stale 콘텐츠 + 오류 + retry다.
- `failed-with-stale`에서 `data.length === 0`이라는 이유로 `ready-empty`를 먼저 return하지 않는다. error branch가 empty branch보다 우선해야 한다.
- 재시도 버튼은 `surface.refresh({ forceLoading: true })`를 호출한다. 배경 poll은 기존 `pollMs`만 지정하고 stale 콘텐츠를 유지한다. 요청 수 축소·poll interval 변경·inflight dedupe는 WP4 범위다.
- cold skeleton의 `rows`와 wrapper class는 해당 ready 레이아웃의 행·카드 수에 맞춘다. 공통 block만을 이유로 실제 영역과 다른 높이의 placeholder를 만들지 않는다.
- 기존 locale key를 `label`과 상태 문구에 전달한다. 새 문구가 꼭 필요할 때만 여섯 locale을 같은 commit에 추가한다.
- 해당 페이지 test에 첫 cold mount, empty success, populated success, stale revalidation, cold failure, stale failure를 추가하거나 위 공용 contract test가 실제 page branch를 소비함을 증명한다. WP3 C 단계에서는 첫 로드 screenshot과 `role=status`/`aria-busy` DOM 증거를 남긴다.

## 8. 활성화 시나리오 표

> ## ⛔ SUPERSEDED — 검증 체크리스트로 쓰지 말 것
>
> 구 상태 이름과 제거된 `lastAttemptSucceeded`를 참조하고, 스켈레톤과 상태줄을 동시에 라이브로
> 그리라고 지시한다(§9.2·§10.1.1에서 폐기된 접근성 동작). 실제 활성화 요구사항은 **§9.4 표**,
> 라이브 리전 규칙은 **§10.1.1**이 정본이다.

| 이 문서가 도입하는 분기 | C에서의 발화 | 관측 증거 |
|---|---|---|
| `cold` | 새 resource key로 mount하고 첫 Promise를 hold | `DataSurfaceSkeleton`의 `role=status`, `aria-live=polite`, `aria-busy=true`; 아직 data 없음 |
| `ready-populated` | 첫 Promise를 비지 않은 DTO로 resolve | `kind=ready-populated`, 실제 행/카드 렌더 |
| `ready-empty` | 첫 Promise를 페이지의 empty DTO로 resolve | `kind=ready-empty`, `*.empty`만 표시되고 spin 없음 |
| `loading-with-stale-data` | 성공 DTO 뒤 deps를 바꾸고 두 번째 Promise를 hold | 기존 data가 DOM에 남고 `DataSurfaceStatus` 및 `aria-busy=true`가 보임 |
| `failed-cold` | 첫 Promise를 reject | `kind=failed-cold`, `*.loadFail`과 retry, empty state 없음 |
| `failed-with-stale` | 성공 DTO 뒤 다음 Promise를 reject | 기존 data와 error `Notice`가 함께 보이고 `lastAttemptSucceeded=false` |
| 빈 성공 뒤 실패 | 첫 Promise를 `[]`, 다음 Promise를 reject | `ready-empty` 뒤 `failed-with-stale`; 오류가 빈 상태를 덮지 않음 |
| 즉시 unmount | mount commit 직후 timer flush 없이 unmount | loader의 동기 call counter가 1 이상; 0ms timer가 없다는 증거 |
| loading status primitive | skeleton과 status를 static render | 두 노드 모두 `role=status`/`aria-live=polite`, busy일 때만 `aria-busy=true`, spin은 `aria-hidden` |
| WP6 병렬성 | WP6 kickoff에서 WP2 export 목록 확인 | card/row export 없음, WP6가 WP1 이후 독립 작업으로 시작; WP3만 `data-surface` import |

## 9. 범위 경계

### 9.1 정정된 범위 (A 감사 반영)

감사 블로커 1: 계정 목록은 `useKeyedClientResource`가 아니라 `useCodexAccountPool`이 소유하므로,
어댑터·프리미티브만 추가해도 사용자가 본 908ms 대기에는 아무 변화가 없다. 따라서 WP2 범위에
**계정 풀 훅의 상태 노출**을 포함한다. 이것이 사용자 불만의 직접 대상이다.

IN (WP2):

- `gui/src/client-resource.ts` — §0의 `refreshing` / `hasSucceeded` / `lastAttemptOk` 추가.
- `gui/src/data-surface.ts` — `useDataSurface` (§1.2 판정, 순수 함수).
- `gui/src/components/data-surface.tsx` — 스켈레톤·상태줄 프리미티브.
- `gui/src/hooks/useCodexAccountPool.ts` — `initialLoading`(첫 시도가 아직 미확정, 성공·실패
  무관하게 첫 시도가 settle되면 false — §10.4가 정본)과 `refreshing`(요청
  인플라이트)을 컨트롤러에 노출한다. 기존 `loadState`는 호환을 위해 남기고, 새 필드를 더한다.
  현재 `load()`는 `refreshQuota`일 때 `loading` 전이를 건너뛰므로 강제 새로고침 중에는 어떤
  상태도 올라가지 않는다([useCodexAccountPool.ts:140](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:140)).
  `refreshing`은 강제·일반 두 경로 모두에서 오른다.
- `gui/src/components/codex-account-pool-main-card.tsx` 및 계정 풀 표시부 — `refreshing`일 때
  기존 행을 유지한 채 상태줄을 그린다. 이것이 908ms 구간의 스피너다.
- CSS, 테스트.

OUT (WP2):

- 15개 표면 이관은 WP3. WP2는 계정 풀 한 곳만 새 신호의 첫 소비자로 만들어 계약이 실제로
  동작함을 증명한다.
- 요청 수 감축은 WP4. 설정 카드 재구성은 WP6.
- 서버 측 팬아웃 완화는 WP5. WP2는 지연을 **보이게** 만들 뿐 줄이지 않는다.

### 9.2 접근성 — 라이브 리전 하나 원칙 (감사 블로커 6)

`DataSurfaceSkeleton`과 `DataSurfaceStatus`가 둘 다 라이브 리전이면 스켈레톤→상태줄 전환에서
두 번 읽힌다. 규칙을 정한다.

- 한 로딩 전환에는 **라이브 리전 하나**만 존재한다.
- `DataSurfaceSkeleton`은 `role="status"`와 sr-only 라벨을 유지한다. 콜드 구간의 단일 알림원이다.
- `DataSurfaceStatus`는 `live` prop(기본 `true`)을 받는다. 부모가 이미 알리고 있거나 같은
  전환에서 스켈레톤과 공존할 수 있는 자리에서는 `live={false}`로 넘겨 `role`/`aria-live`를
  떼고 시각·`aria-busy` 전용으로 쓴다.
- 계약 테스트는 "status가 하나 있다"가 아니라 **라이브 리전 개수를 센다**. 콜드에서 1,
  stale 재검증에서 1, 전환 중 2가 되지 않음을 단언한다.

기존 계정 풀 스켈레톤도 라이브 리전 하나 + sr-only 라벨 구성이므로 같은 규칙이다
([codex-account-pool-main-card.tsx:212](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/codex-account-pool-main-card.tsx:212)).

### 9.3 검증 명령 (감사 블로커 7)

> ⛔ 이 절의 명령 블록은 **§10.7이 정본**이다. 여기 목록은 GUI 빌드가 빠져 있었다.

루트 `bun run typecheck`는 `src`만 본다. GUI 타입·테스트는 별도이며 `bun run test`는 루트
`tests/`이므로 GUI 변경만으로는 신호가 없다. 따라서 WP2는 GUI 스위트와 GUI 빌드를 명시적으로
돌린다. 실행할 명령은 §10.7을 그대로 쓴다.

### 9.4 필수 추가 테스트 (감사 블로커 7)

초안 테스트는 `forceLoading` 경로만 다뤄서 정작 고친 경로를 검증하지 않는다. 아래를 반드시 넣는다.

| 시나리오 | 발화 방법 | 단언 |
|---|---|---|
| 조용한 폴링 중 stale 재검증 | 데이터 있는 상태에서 해제되지 않은 promise를 반환하는 폴 트리거 | `kind === "loading-with-stale-data"`, `refreshing === true`, 기존 데이터 유지, `showSkeleton === false` |
| `enabled: false` | 꺼진 상태로 마운트 | `kind === "disabled"`, `showSkeleton === false`, 요청 0건 |
| `enabled` false→true 활성화 | prop 전환 | 요청 1건 발생, `cold`로 진입 |
| `undefined` reject | `Promise.reject(undefined)` | `failed-cold`, `showError === true` |
| 실패 후 성공 회복 | 실패 → 성공 | `showError === false`, `lastAttemptOk === true` |
| 빈 성공 후 실패 | `[]` → 실패 | `failed-with-stale`, 빈 데이터 유지, `showError === true` |
| 공유 캐시 마운트 | A 성공 후 B가 같은 key로 마운트 | B의 첫 렌더가 `ready-*`, 스켈레톤 없음 |
| 마운트 직후 언마운트 | 마운트하고 즉시 언마운트 | 요청이 실제로 발생함 (0ms 타이머 폐기 증명) |
| 라이브 리전 개수 | 콜드 → stale 재검증 전환 | 각 시점에 라이브 리전 정확히 1개 |
| 콜드 재시도 중 | 첫 요청 실패 후 해제되지 않는 promise로 재시도 | `kind === "retrying-cold"`, `showSkeleton === true`, 라이브 리전 1개 |
| 계정 풀 겹친 요청 | 일반 load 인플라이트 중 `?refresh=1` 발사, 일반 load만 먼저 해제 | `refreshing`이 여전히 true, 스피너 유지 |
| stale 실패 후 재시도 라이브 리전 | 성공 → 실패 → 재시도(미해제) | 라이브 리전 정확히 1개(오류 배너가 소유), 상태줄은 `live={false}` |
| 계정 풀 콜드 마운트 DOM | `CodexAccountPool`을 마운트하고 초기 `/accounts`를 미해제로 보류 | 스켈레톤/라이브 리전 정확히 1개, 인라인 상태줄 없음. 해제 후 정상 행 렌더 |
| 계정 부분 성공 | `/accounts` 성공 + `/active` 실패 | `loadState === "ready"`, 계정 행 유지·표시(점진 페인트 보존) |

## 10. 확정 구현 (A 감사 R2 반영 — §2·§3·§6을 대체한다)

§0~§1.2와 이 절이 실제 구현 명세다. 앞의 §2/§3/§6은 폐기됐다.

### 10.1 `gui/src/data-surface.ts`

`retrying-cold`를 여덟 번째 상태로 추가한다. 감사 블로커 2: 콜드 실패 후 재시도 중에는
`error`가 남아 있고 `refreshing`이 올라간 상태인데, `failed`를 먼저 평가하면 스켈레톤도
스피너도 없는 정지 화면이 된다. 인플라이트 판정을 실패 판정보다 앞에 둔다.

```ts
import { type ResourceSnapshot, useKeyedClientResource } from "./client-resource";

export type DataSurfaceKind =
  | "disabled"
  | "cold"
  | "retrying-cold"
  | "loading-with-stale-data"
  | "ready-empty"
  | "ready-populated"
  | "failed-cold"
  | "failed-with-stale";

export type DataSurfaceState<T> = {
  kind: DataSurfaceKind;
  data: T | undefined;
  error: unknown;
  showSkeleton: boolean;
  refreshing: boolean;
  showError: boolean;
};

export type DataSurfaceResource<T> = ResourceSnapshot<T> & {
  refresh: (opts?: { forceLoading?: boolean }) => void;
  state: DataSurfaceState<T>;
};

export type DataSurfaceOptions<T> = {
  /** The page owns its domain-specific definition of an empty successful DTO. */
  isEmpty: (data: T) => boolean;
  pollMs?: number;
  enabled?: boolean;
};

/**
 * Pure classification. Ordering matters: an in-flight request outranks a settled failure so a
 * slow retry keeps showing progress instead of freezing on the previous error.
 */
export function classifyDataSurface<T>(
  snapshot: ResourceSnapshot<T>,
  isEmpty: (data: T) => boolean,
  enabled: boolean,
): DataSurfaceState<T> {
  if (!enabled) {
    return { kind: "disabled", data: undefined, error: undefined, showSkeleton: false, refreshing: false, showError: false };
  }

  const hasData = snapshot.data !== undefined;
  const failed = !snapshot.lastAttemptOk && snapshot.error !== undefined;

  if (snapshot.refreshing) {
    if (hasData) {
      return {
        kind: "loading-with-stale-data",
        data: snapshot.data, error: snapshot.error,
        showSkeleton: false, refreshing: true, showError: failed,
      };
    }
    // No content to keep. A first attempt and a retry both need the skeleton; only the retry
    // carries a prior error, which the caller may surface beside the skeleton.
    return {
      kind: failed ? "retrying-cold" : "cold",
      data: undefined, error: failed ? snapshot.error : undefined,
      showSkeleton: true, refreshing: true, showError: false,
    };
  }

  if (failed) {
    return hasData
      ? { kind: "failed-with-stale", data: snapshot.data, error: snapshot.error, showSkeleton: false, refreshing: false, showError: true }
      : { kind: "failed-cold", data: undefined, error: snapshot.error, showSkeleton: false, refreshing: false, showError: true };
  }

  if (!hasData) {
    return { kind: "cold", data: undefined, error: undefined, showSkeleton: true, refreshing: false, showError: false };
  }

  return {
    kind: isEmpty(snapshot.data as T) ? "ready-empty" : "ready-populated",
    data: snapshot.data, error: undefined,
    showSkeleton: false, refreshing: false, showError: false,
  };
}

/**
 * Keeps request ownership in client-resource while giving pages one render decision. All state
 * comes from the external store snapshot, so every subscriber classifies identically.
 */
export function useDataSurface<T>(
  key: string,
  deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options: DataSurfaceOptions<T>,
): DataSurfaceResource<T> {
  const { isEmpty, ...resourceOptions } = options;
  const resource = useKeyedClientResource(key, deps, load, resourceOptions);
  return {
    ...resource,
    state: classifyDataSurface(resource, isEmpty, options.enabled !== false),
  };
}
```

`showError`가 `retrying-cold`에서 false인 이유: 스켈레톤이 이미 라이브 리전 하나를 차지하므로
오류 배너를 같이 띄우면 §9.2 규칙을 깬다. 이전 오류는 `state.error`로 전달되고, 표면이
비-라이브 보조 문구로 쓸지 결정한다.

#### 10.1.1 `loading-with-stale-data` + `showError` 조합의 라이브 리전 소유권

감사 R3 지적: stale 실패 후 재시도하면 `showError: true`와 `refreshing: true`가 함께 참이다.
기존 `Notice`도 `role="status"`이므로([ui.tsx:17](/Users/jun/Developer/new/700_projects/opencodex/gui/src/ui.tsx:17))
오류 배너와 상태줄을 둘 다 라이브로 그리면 두 번 읽힌다.

규칙: **오류 배너가 있으면 그것이 라이브 리전을 소유한다.** 상태줄은 비-라이브로 내린다.

```tsx
{state.showError && <Notice tone="err">{t("<page>.loadFail")}</Notice>}
{state.refreshing && (
  <DataSurfaceStatus live={!state.showError}>{t("common.loading")}</DataSurfaceStatus>
)}
```

오류가 사라지면 상태줄이 다시 라이브가 된다. 어느 시점에도 라이브 리전은 하나다.
`failed-stale → 재시도` 전환에 대한 리전 개수 테스트를 §9.4에 추가한다.

### 10.2 `gui/src/components/data-surface.tsx`

```tsx
import type { CSSProperties, ReactNode } from "react";

/**
 * Lets a page mirror its ready geometry without exposing fake values to assistive technology.
 * The parent owns the one announced loading sentence.
 */
export function DataSurfaceSkeletonBlock({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={className ? `data-surface-skeleton__block ${className}` : "data-surface-skeleton__block"}
      style={style}
    />
  );
}

/**
 * Keeps the cold surface non-empty from its first commit. This is the single live region for a
 * cold transition, so a caller must not render a live status line alongside it.
 */
export function DataSurfaceSkeleton({
  label, rows = 3, className,
}: { label: string; rows?: number; className?: string }) {
  const count = Math.max(1, Math.floor(rows));
  return (
    <div
      className={className ? `data-surface-skeleton ${className}` : "data-surface-skeleton"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <div className="data-surface-skeleton__row" key={index} aria-hidden="true">
          <DataSurfaceSkeletonBlock />
        </div>
      ))}
    </div>
  );
}

/**
 * Announces a revalidation without replacing visible stale content. Pass `live={false}` where a
 * parent already owns the announcement for this transition, so assistive technology hears it once
 * (see the one-live-region rule).
 */
export function DataSurfaceStatus({
  children, busy = true, live = true, className,
}: { children: ReactNode; busy?: boolean; live?: boolean; className?: string }) {
  return (
    <div
      className={className ? `data-surface-status ${className}` : "data-surface-status"}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      aria-atomic={live ? "true" : undefined}
      aria-busy={busy || undefined}
    >
      {busy && <span className="spin" aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}
```

### 10.3 `client-resource.ts`의 초기 스냅샷 (감사 R2 지적)

`EMPTY_SNAPSHOT`만 고치면 안 된다. `getStore()`가 만드는 초기 리터럴도 새 필드가 필요하다
([client-resource.ts:38](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:38)).

```diff
     store = {
-      snapshot: { data: undefined, error: undefined, loading: false },
+      snapshot: {
+        data: undefined, error: undefined, loading: false,
+        refreshing: false, hasSucceeded: false, lastAttemptOk: false,
+      },
       listeners: new Set(),
```

### 10.4 계정 풀의 `refreshing` — 인플라이트 카운터 (감사 블로커 3)

단순 boolean은 겹친 요청에서 깨진다. 현재 `load()`는 초기 로드·30초 폴·쿼터 채움 타이머·명시적
액션이 모두 동시에 진행될 수 있고, 오래된 요청이 먼저 끝나면서 스피너를 꺼 버린다. 그러면
정작 908ms짜리 `?refresh=1`이 다시 안 보인다.

카운터로 소유권을 만든다.

```diff
   const [pausingExhausted, setPausingExhausted] = useState(false);
+  // Counts requests in flight, not "a" request: an older load finishing must not clear the
+  // spinner while a newer forced refresh is still running.
+  const [inflightCount, setInflightCount] = useState(0);
+  // "First attempt still pending", not "never succeeded": a failed first attempt settles this
+  // so the surface can show its error instead of an endless skeleton.
+  const [firstAttemptSettled, setFirstAttemptSettled] = useState(() => seed != null);
```

`try`는 카운터를 올린 직후 시작해야 한다. 감사 R3 지적: `beginActiveRead()`가 동기적으로
throw하면 카운터만 올라가고 내려가지 않아 스피너가 영구히 켜진다
([useCodexAccountPool.ts:134](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:134)).
옵서버 스냅샷, 태스크 생성, `Promise.all`, 모든 return이 `try` 안에 들어간다.

**기존 post-`Promise.all` 분기는 한 줄도 바꾸지 않는다.** 감사 R4 지적: 초안 diff가 그것을
`accountsOk && activeOk`로 바꿔 놓았는데, 현재 코드는 `/accounts`만 성공해도 `ready`를 유지하는
점진 페인트 설계다([useCodexAccountPool.ts:157](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:157),
[useCodexAccountPool.ts:194](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:194)).
`/active`가 실패해도 유효한 계정 행은 계속 보여야 한다. WP2가 추가하는 것은 카운터 증가와
`finally`뿐이다.

```diff
   const load = useCallback(async (refreshQuota = false): Promise<boolean> => {
     const generation = ++loadGenerationRef.current;
+    setInflightCount(count => count + 1);
+    try {
       // 아래 본문은 현재 코드 그대로다. 옵서버 스냅샷, 두 태스크 생성, Promise.all,
       // generation 체크, accountsOk 기반 progressive-paint 분기, 콜드 실패 처리, 모든 return이
       // 이 try 안에 들어간다. 로직 변경 없음.
       const observers = [...observersRef.current];
       ...
       const [accountsOk, activeOk] = await Promise.all([accountsTask, activeTask]);
       if (loadGenerationRef.current !== generation) return false;
       if (accountsOk) {
         setLoadState("ready");
         hasLoadedRef.current = true;
         // lastGoodByBase 갱신 — 기존과 동일
         return activeOk;
       }
       if (!hasLoadedRef.current) setLoadState("error");
       return false;
+    } finally {
+      setInflightCount(count => Math.max(0, count - 1));
+      setFirstAttemptSettled(true);
+    }
   }, [apiBase]);
```

`try`가 카운터 증가 직후에 열리는 것이 핵심이다. `beginActiveRead()`가 동기적으로 throw해도
`finally`가 카운터를 되돌린다.

`Math.max(0, ...)`는 방어일 뿐이며 정상 경로에서는 증가와 감소가 1:1로 짝지어진다.

컨트롤러 인터페이스에 두 필드를 더한다.

```diff
 export interface CodexAccountPoolController {
   accounts: CodexAccountEntry[];
   activeId: string | null;
   loadState: CodexAccountLoadState;
+  /** True while any load is in flight, including the forced quota refresh. */
+  refreshing: boolean;
+  /** True until the first load attempt settles, whether it succeeds or fails. */
+  initialLoading: boolean;
```

```diff
   return {
     accounts,
     activeId,
     loadState,
+    refreshing: inflightCount > 0,
+    initialLoading: !firstAttemptSettled,
```

`refreshQuota` 분기는 `loadState`에만 적용되므로 그대로 둔다. 강제 경로가 콘텐츠를 지우지
않으면서도 `refreshing`으로 관측되는 것이 의도한 동작이다.

### 10.5 클릭→스피너 배선 (감사 블로커 4)

현재 `CodexAccountPool`은 로컬 `refreshingQuota` state로 버튼 라벨만 바꾼다
([CodexAccountPool.tsx:189](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexAccountPool.tsx:189)).
로컬 state는 **버튼 비활성화 용도로만 남기고**, 화면 상태 표시는 컨트롤러의 `refreshing`을 쓴다.
두 개를 병행하면 어느 쪽이 진실인지 모호해진다.

경로를 명시한다.

| 단계 | 코드 |
|---|---|
| 사용자가 `할당량 새로고침` 클릭 | `onRefresh` → `refreshQuotas()` |
| 강제 로드 시작 | `controller.load(true)` → `inflightCount` 1 상승 |
| 컨트롤러 노출 | `refreshing === true` |
| 렌더 | 계정 행 유지 + `DataSurfaceStatus`(라이브) 1개 + 목록 컨테이너 `aria-busy` |
| 908ms 후 응답 | `inflightCount` 0, `refreshing === false`, 상태줄 제거 |

콜드 마운트에서는 `initialLoading && accounts.length === 0`일 때 `DataSurfaceSkeleton` 하나만
그린다. 이때 `DataSurfaceStatus`는 렌더하지 않는다(§9.2).

### 10.6 기존 계정 풀 테스트 보존 사항 (감사 블로커 5)

아래는 반드시 유지한다. 새 필드 추가로 깨지면 구현이 잘못된 것이다.

- 초기 `/accounts` 요청 정확히 1건 — `codex-account-pool-behaviour.test.tsx:133`
- 비활성 컨트롤러는 요청 0건 — 같은 파일 `:159`
- 보류 중 낙관적 pause 상태 유지
- 30초 인터벌 1개
- stale `/active` 읽기가 편집 중 값을 덮지 않음 — `codex-auto-switch-controller.test.tsx:336`
- 전략 컨트롤의 `/active` 대기 중 비활성화 semantics와 옵서버 순서

갱신 대상: 컨트롤러 인터페이스를 리터럴로 만드는 테스트 목에 `refreshing: false`,
`initialLoading: false`를 추가하고, 컨트롤러 계약 멤버 목록에 두 필드를 등재한다
([codex-account-pool-controller.test.ts:16](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-account-pool-controller.test.ts:16)).

### 10.7 게이트 명령 (감사 블로커 6)

한 스크립트로 이어 붙여도 안전하도록 서브셸로 감싼다. `cd gui`를 연달아 쓰면 두 번째가
`gui/gui`를 찾아 실패하고 이후 루트 명령까지 잘못된 디렉터리에서 돈다(감사 R3).

```bash
bun run typecheck
(cd gui && bun run build)        # GUI 소스 타입체크 (CI와 동일)
(cd gui && bun test tests)
bun run lint:gui
bun run privacy:scan
```

**IN**: `useKeyedClientResource` 위의 얇은 `useDataSurface` 판정 어댑터, skeleton/status
프리미티브, 이 프리미티브의 CSS, state-contract regression test, 그리고 위 migration contract다.

**OUT**: WP2는 15개 페이지를 이관하지 않는다. 각 페이지의 실제 endpoint·empty copy·retry UI·layout
변경은 WP3다. WP2는 poll 간격, request count, cache TTL, inflight 공유, quota fan-out도 바꾸지
않는다. 그 수량 정책은 WP4이며, 계획도 WP3의 단일 진입점 뒤에 WP4를 둔다
([000_plan.md:36](/Users/jun/Developer/new/700_projects/opencodex/devlog/_fin/260730_gui_hydration_loading_unify/000_plan.md:36)).
WP2는 설정 card/row primitive를 export하지 않으므로 WP6의 정렬 통일도 여기서 하지 않는다.
