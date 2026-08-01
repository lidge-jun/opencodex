# WP4 — PR #466 react-doctor 공용 기반

대상: PR #466 (Wibias). WP5(#468)의 선행이다.

## HEAD 이동 경고 (A-gate blocker 2, STRICT)

이 PR의 head는 계획 수립 중에도 계속 움직였다.

| 시점 | head |
|---|---|
| 최초 분석 | `9c7e922e` |
| A-gate 감사 | `138751f7` |
| A-gate 반영 시점 재확인 | `7b0bcda7` |
| A-gate R2 재확인 | `971e0564` |

`f09ae7f3`와 `138751f7`가 아래 3개 소스 파일을 이미 수정했고 subscriber-owned fetcher와
테스트를 추가했다. 따라서 **아래 before 블록 중 일부는 최신 head에 존재하지 않으며,
deps 무효화 테스트는 그 head에서 이미 GREEN이다.**

**PRE_APPLY_HEAD 규칙 (A-gate R2 blocker 1 반영):** 최초 안은 SHA를 기록만 하고
실제로는 계속 움직이는 `pr-466` ref에 적용해, 감사한 head와 적용한 head가 달라질 수
있었다. 아래처럼 **fetch를 먼저 하고 동일성을 단언한 뒤, 이후 모든 명령에 SHA를 직접
쓴다.** ref 이름은 어디에도 쓰지 않는다.

```bash
git fetch origin pull/466/head:pr-466 --force
PRE_APPLY_HEAD=$(git rev-parse pr-466)
test "$PRE_APPLY_HEAD" = "$(gh pr view 466 --json headRefOid -q .headRefOid)" \
  || { echo "head moved during fetch — restart WP4"; exit 1; }
```

불일치면 그 자리에서 중단하고 처음부터 다시 시작한다. `--force`는 기존 `pr-466`
브랜치가 있을 때 non-fast-forward 거부를 피하기 위한 것이다.

이후 `git show "$PRE_APPLY_HEAD":gui/src/client-resource.ts`로 결함 1~7이 각각
**아직 살아있는지 하나씩 확인**한다. 이미 고쳐진 항목은 건너뛰고 그 사실을 이 문서에
기록한다. `git merge-tree`와 `git diff`도 전부 `"$PRE_APPLY_HEAD"`를 쓴다.
`9c7e922e` 기준의 clean 판정(tree `93505fd5`)은 무효다.

또한 최신 head에는 `gui/tests/client-resource-poll.test.tsx`가 있다.
이 파일은 subscriber-owned 폴링을 보호하므로 **반드시 함께 가져온다** (blocker 4).

## 범위 — `gui/src/api.ts` 제외 (STRICT)

```bash
git diff dev..."$PRE_APPLY_HEAD" -- \
  gui/src/client-resource.ts \
  gui/src/fetch-json.ts \
  gui/src/intl-formatters.ts \
  gui/tests/client-resource-poll.test.tsx | git apply -3
```

`gui/src/api.ts` 훅은 자격증명 보관을 `sessionStorage`에서 모듈 메모리로 바꾼다.
`AGENTS.md`/`MAINTAINERS.md` 기준 보안 리뷰 대상이므로 통합하지 않는다.
#467도 #468도 이 파일에 의존하지 않는다.

## 결함 1 — `_deps`가 무효화를 수행하지 않음

PR head `gui/src/client-resource.ts:143-155`.

before:

```ts
/** Stable loader via explicit deps — avoids react-doctor fresh-deps on inline fetchers. */
export function useKeyedClientResource<T>(
  key: string,
  _deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options?: { pollMs?: number; enabled?: boolean },
): ResourceSnapshot<T> & { refresh: () => void } {
  void _deps;
  return useClientResource(key, load, options);
}
```

after:

```ts
function depsChanged(prev: readonly unknown[] | null, next: readonly unknown[]): boolean {
  if (prev === null) return false;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * Like `useClientResource`, but refetches when `deps` change (element-wise
 * `Object.is`), even if the cache `key` stays the same. Callers may allocate a
 * fresh deps array each render — identity of the array is ignored.
 */
export function useKeyedClientResource<T>(
  key: string,
  deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options?: { pollMs?: number; enabled?: boolean },
): ResourceSnapshot<T> & { refresh: () => void } {
  const resource = useClientResource(key, load, options);
  const prevDepsRef = useRef<readonly unknown[] | null>(null);

  useLayoutEffect(() => {
    const prev = prevDepsRef.current;
    prevDepsRef.current = deps;
    if (!depsChanged(prev, deps)) return;
    resource.refresh();
  });

  return resource;
}
```

## 결함 2 — falsy 데이터를 빈 캐시로 오인 (`client-resource.ts:51`)

before: `if (!store.snapshot.data) {`
after: `if (store.snapshot.data === undefined) {`

## 결함 3 — 느린 폴링 요청을 매번 abort (`client-resource.ts:82`)

`runFetch`에 옵션을 추가한다:

```ts
options?: { replaceInflight?: boolean }
```

본문 시작:

```ts
const replaceInflight = options?.replaceInflight !== false;
if (store.inflight && !replaceInflight) return;
if (replaceInflight) store.inflight.abort();
```

폴링 틱: `void runFetch(store, fetcher, { replaceInflight: false });`
명시적 refresh는 기존대로 `replaceInflight: true`.

## 결함 4 — 구독자별 폴링 간격이 마운트 순서에 의존

per-listener 맵을 도입한다:

```ts
pollByListener: Map<() => void, number | undefined>;
```

구독자가 추가/제거될 때마다 가장 작은 양수 간격을 재계산한다.

## 결함 5 — 비활성 키가 캐시에서 제거되지 않음

마지막 구독자 정리 경로에서 abort와 타이머 해제 후:

```ts
stores.delete(key);
```

WP5의 전제조건이다. Claude 캡처를 껐다 켤 때 이전 스냅샷의 민감 메타데이터가
다시 노출되면 안 된다.

## 결함 6 — `setClientResourceData`를 오래된 in-flight가 덮어씀

before:

```ts
export function setClientResourceData<T>(key: string, data: T) {
  const store = getStore<T>(key);
  store.snapshot = { data, error: undefined, loading: false };
  emit(store);
}
```

after:

```ts
export function setClientResourceData<T>(key: string, data: T) {
  const store = getStore<T>(key);
  store.inflight?.abort();
  store.inflight = null;
  store.generation++;
  store.snapshot = { data, error: undefined, loading: false };
  emit(store);
}
```

## 결함 7 — 204/빈 본문 성공 응답에서 JSON 헬퍼가 throw

`gui/src/fetch-json.ts`에 추가:

```ts
async function readJsonBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}
```

두 성공 경로의 `res.json()`을 `readJsonBody<T>(res)`로 교체한다.

## 회귀 테스트

NEW: `gui/tests/client-resource.test.tsx`

```tsx
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  type ResourceSnapshot,
  useClientResource,
  useKeyedClientResource,
} from "../src/client-resource";

// `useClientResource` and `ResourceSnapshot` are used by the falsy-cache test below;
// `useKeyedClientResource` by the deps test. Keep all three imported in this file.

test("useKeyedClientResource refetches when a dependency changes without changing the cache key", async () => {
  const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as Record<(typeof globals)[number], unknown>;

  const win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls: string[] = [];
  const cacheKey = `deps-regression-${Date.now()}`;

  function Harness({ value }: { value: string }) {
    const resource = useKeyedClientResource(
      cacheKey,
      [value],
      async () => {
        calls.push(value);
        return value;
      },
    );
    return <div>{resource.data ?? "loading"}</div>;
  }

  try {
    await act(async () => {
      root.render(<Harness value="first" />);
      await Promise.resolve();
    });
    expect(calls).toEqual(["first"]);
    expect(container.textContent).toBe("first");

    await act(async () => {
      root.render(<Harness value="second" />);
      await Promise.resolve();
    });
    expect(calls).toEqual(["first", "second"]);
    expect(container.textContent).toBe("second");
  } finally {
    await act(async () => root.unmount());
    win.close();
    for (const key of globals) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: previous[key],
      });
    }
  }
});
```

RED→GREEN 근거: PR head는 최신 loader를 보관만 하고 deps 변경 시 호출하지 않아
`calls`가 `["first"]`에 머문다. 수정 후 layout effect가 `refresh()`를 호출한다.

단, 위 HEAD 이동 경고대로 최신 head에서는 이 결함이 이미 고쳐졌을 수 있다.
그 경우 이 테스트는 회귀 방지용으로 유지하되, RED 증거는 `dev` 기준으로 잡는다.

## 추가 회귀 테스트 (A-gate blocker 4)

결함 2~7은 각각 비동기 계약을 바꾸는데 deps 테스트 하나로는 전혀 보호되지 않는다.
`gui/tests/client-resource.test.tsx`에 아래 5개 케이스를 추가한다.

| 테스트명 | 대상 결함 | 관찰 지점 |
|---|---|---|
| `keeps a falsy cached value visible while a refresh runs` | 2 | 아래 정정 참조 |
| `a slow poll tick does not abort the in-flight request` | 3 | 폴링 2틱 동안 첫 요청의 `signal.aborted === false` |
| `uses the smallest positive poll interval across subscribers` | 4 | 구독자 2명(2000ms/500ms) 등록 후 실제 틱 간격 500ms |
| `evicts the store when the last subscriber unmounts` | 5 | 전체 unmount 후 재마운트 시 이전 스냅샷 미노출 |
| `setClientResourceData wins over an older in-flight response` | 6 | 보류 중이던 fetch를 뒤늦게 resolve해도 주입 값 유지 |
| `treats 204 and empty bodies as undefined` | 7 | `fetch-json` 두 성공 경로가 throw하지 않음 |

### falsy 테스트 정정 (A-gate R2 blocker 2)

최초 안의 "재구독 시 loader 재호출 0회"는 잘못된 관찰 지점이다.
`if (!store.snapshot.data)` 조건은 **loader 실행 여부가 아니라 `loading` 값**을 바꾼다.
게다가 마지막 구독자 해제 시 store를 제거하는 결함 5 수정과 서로 충돌한다
(재구독 시점엔 캐시가 이미 비어 있는 게 정상이다).

올바른 관찰: **구독자를 마운트한 채로** 캐시 값이 `0` / `""` / `false`인 상태에서
refresh를 시작하고, 그 falsy 스냅샷이 빈 캐시/로딩으로 취급되지 않고 계속 보이는지 본다.

A-gate R3 blocker 2 반영: 텍스트만 보면 안 된다. 하네스가 `loading` 여부와 무관하게
캐시 데이터를 렌더하면 결함이 있어도 통과한다. **`loading` 플래그를 직접 단언**하고
하네스를 완전히 적는다.

```tsx
test("keeps a falsy cached value visible while a refresh runs", async () => {
  const cacheKey = `falsy-regression-${Date.now()}`;
  let pendingResolve!: (value: number) => void;
  let calls = 0;
  // 최신 스냅샷을 테스트에서 직접 관찰하기 위해 밖으로 노출한다.
  let latest: ResourceSnapshot<number> & { refresh: () => void };

  function Harness() {
    latest = useClientResource<number>(cacheKey, () => {
      calls++;
      // 첫 호출은 즉시 0, 두 번째(refresh)는 테스트가 풀어줄 때까지 보류.
      if (calls === 1) return Promise.resolve(0);
      return new Promise<number>(resolve => { pendingResolve = resolve; });
    });
    return (
      <div>
        {latest.loading ? "loading" : `value:${String(latest.data)}`}
      </div>
    );
  }

  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });

  // 캐시에 falsy 값 0이 자리잡았다.
  expect(latest!.data).toBe(0);
  expect(latest!.loading).toBe(false);
  expect(container.textContent).toBe("value:0");

  // 구독자를 유지한 채 refresh를 시작한다. 응답은 아직 오지 않는다.
  await act(async () => {
    latest!.refresh();
    await Promise.resolve();
  });

  // 핵심 단언: 캐시된 0이 "빈 캐시"로 오인되어 loading으로 뒤바뀌면 안 된다.
  expect(latest!.loading).toBe(false);
  expect(latest!.data).toBe(0);
  expect(container.textContent).toBe("value:0");

  await act(async () => {
    pendingResolve(7);
    await Promise.resolve();
  });
  expect(latest!.data).toBe(7);
});
```

RED 근거: `!store.snapshot.data`는 `0`을 빈 캐시로 판정해 refresh 시작 시
`loading: true`로 전환한다. 따라서 `expect(latest!.loading).toBe(false)`가 실패하고,
렌더도 `"loading"`이 되어 텍스트 단언까지 함께 깨진다. 수정 후
(`store.snapshot.data === undefined`) 두 단언이 모두 통과한다.

`""`와 `false`도 같은 구조로 각각 케이스를 만든다. `0` 하나만으로도 RED는 잡히지만,
세 falsy 값이 모두 같은 경로를 타는지 확인하는 편이 낫다.

각 케이스는 해당 결함 수정 전 실패해야 한다. B 단계에서 수정 항목별로
RED를 개별 확인한 뒤 GREEN으로 넘어간다.

## 활성화 시나리오

새 분기: `depsChanged()`의 length/Object.is 비교, `replaceInflight` 게이트,
`stores.delete(key)` 정리 경로. 위 테스트가 deps 분기를 활성화하고,
WP5의 Debug/Claude 테스트가 캐시 정리 경로를 간접 활성화한다.

## 커밋

```
fix(gui): add react-doctor shared resource foundations (#466)

Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>
```

## 검증

```bash
cd gui && bun test tests/client-resource.test.tsx && cd ..
bun run typecheck
bun run lint:gui
```
