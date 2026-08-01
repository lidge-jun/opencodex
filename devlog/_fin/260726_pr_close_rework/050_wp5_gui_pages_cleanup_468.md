# WP5 — PR #468 Startup/Debug/Storage/Usage 정리

대상: PR #468 (Wibias). `git merge-tree` clean.

## 상황 변경 — rework에서 verify-and-integrate로

계획 작성 이후 두 가지가 바뀌었다.

**1. 선행 조건 소멸.** WP4(#466)는 동료가 `d9e5102a`로 dev에 직접 머지했다.
따라서 "`9c7e922e` 기준 delta만 적용" 지시는 무효다. dev에 이미 기반이 있다.

**2. 기여자가 결함 5건을 모두 수정했다.** head가
`8b7c73fd` → `46bef6cf` → `fd5ad596`으로 두 번 움직였고, 커밋 제목이
`restore request ownership for misc react-doctor pages`와
`close Startup/Storage/Usage abort and Debug PUT races`다.

| 결함 | 최초 계획 | 기여자 수정 |
|---|---|---|
| 1-3 abort 후 loading 무조건 해제 | `if (!signal?.aborted)` | `if (generation === loadGenerationRef.current)` — generation 소유권 |
| 4 `debugBusy` 제거 | 상태 복원 + PUT 응답 주입 | `Debug.tsx:21,184`에 복원 |
| 5 행 key 충돌 | `${entry.at}-${index}` | `entry.id` + `inbound-debug.ts`에 monotonic `nextCaptureId` |

결함 5의 기여자 해법이 **우리 제안보다 낫다.** index 기반 key는 링 버퍼가
재정렬되면 여전히 흔들리는데, 생산자 측 단조 증가 ID는 그 문제가 없다.

신규 테스트도 3+1개 추가됐다: `gui/tests/storage-loading-race.test.tsx`,
`gui/tests/debug-mutation-busy.test.tsx`, `gui/tests/debug-claude-inbound-keys.test.tsx`,
`tests/claude-inbound-debug.test.ts`.

**따라서 이 work-phase는 rework가 아니라 verify-and-integrate다.**
아래 결함 서술은 기여자 수정을 검증할 기준으로만 남긴다. 우리가 다시 구현하지 않는다.
검증 대상은 (a) 각 수정이 실제로 올바른지, (b) 신규 테스트가 수정 전 실패하는 진짜
회귀인지, (c) +1456/-569 추출 리팩터가 동작 보존인지다.

## 통합 절차 (A-gate blocker 1 — 최초 안은 무효)

최초 안은 `9c7e922e`(구 #466 head) 기준 delta에서 GUI 10파일만 골라 적용했다.
그 절차를 따르면 `src/claude/inbound-debug.ts`와 테스트 4개가 통째로 빠져
행 key가 `undefined`가 되고 결함 5가 그대로 재현된다.

현재 dev(`74ddd96d`)에는 #466이 이미 머지돼 있으므로 부분 적용이 필요 없다.
**PR head 전체를 적용한다.**

```bash
PRE_APPLY_HEAD=fd5ad59634cd8ffff49b259d6434b65550c1dc9f
git fetch origin pull/468/head:pr-468 --force
test "$(git rev-parse pr-468)" = "$PRE_APPLY_HEAD" || { echo "head moved — restart WP5"; exit 1; }
git diff dev..."$PRE_APPLY_HEAD" | git apply -3
```

적용 대상 15파일 전수:

| 구분 | 파일 |
|---|---|
| GUI 페이지 (4) | `Debug.tsx` `Startup.tsx` `Storage.tsx` `Usage.tsx` |
| 추출 모듈 (6) | `debug-claude-inbound-panel.tsx` `debug-log-viewer.tsx` `debug-settings-panel.tsx` `debug-shared.ts` `startup-sections.tsx` `startup-shared.ts` |
| 백엔드 (1) | `src/claude/inbound-debug.ts` — **누락 시 결함 5 재현** |
| 테스트 (4) | `gui/tests/storage-loading-race.test.tsx` `gui/tests/debug-mutation-busy.test.tsx` `gui/tests/debug-claude-inbound-keys.test.tsx` `tests/claude-inbound-debug.test.ts` |

`gui/src/api.ts` 회피 조항은 불필요해졌다. 그 파일은 #466 머지 시 `afc99ec6`·`138751f7`로
이미 별도 처리됐다.

## 보강할 테스트 (A-gate blocker 2-4)

기여자 구현 5건은 리뷰어가 전부 정확하다고 확인했다. 다만 테스트 4건 중 일부가
결함을 실제로 잡지 못한다. 통합과 함께 아래를 보강한다.

### (a) `gui/tests/debug-claude-inbound-keys.test.tsx` — false confidence

행 내용만 검사해서 **중복 key 구현에서도 통과한다.** React가 duplicate-key 경고를
내지만 테스트가 그걸 보지 않는다. `console.error`를 캡처해 경고 부재를 단언한다.

```tsx
const errors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
try {
  // ...render...
  expect(errors.join("\n")).not.toContain("Encountered two children with the same key");
} finally {
  console.error = originalError;
}
```

`tests/claude-inbound-debug.test.ts`도 3건만 캡처해 링 버퍼 wraparound를 넘지 않는다.
20건을 초과해 캡처한 뒤 잔존 항목의 `id`가 여전히 유일하고 내림차순인지 확인한다.

### (b) Startup / Usage 경합 회귀 부재

`storage-loading-race.test.tsx`는 진짜 회귀지만 Storage만 덮는다.
`Startup.tsx:116-130`과 `Usage.tsx:608-623`은 독립적으로 퇴행할 수 있다.
같은 형태(교체 요청 시작 후 이전 요청 지연 reject)로 두 페이지 테스트를 추가한다.

### (c) Debug 응답 설치 순서 미증명

`debug-mutation-busy.test.tsx`의 두 흐름 모두 최종 상태가 초기 상태(`usage=false`)와
같아서, `setClientResourceData()`를 빼도 최종 UI 단언이 통과한다.
`false → true`로 바뀌는 PUT을 지연시킨 뒤, 컨트롤이 다시 활성화되는 시점에
`aria-pressed="true"`인지 확인하는 케이스를 하나 추가한다.

## 결함 1-3 — abort된 요청이 후속 요청의 loading을 해제

`apiBase`/range/surface가 바뀌면 교체 요청이 시작된 뒤에 이전 요청의 `finally`가 돌아
`loading=false`를 세운다. UI가 미완료 데이터를 확정된 것처럼 보여주고 컨트롤을 조기 활성화한다.

`gui/src/pages/Startup.tsx:113-116` — before:

```ts
} finally {
  setTrayLoading(false);
  setLoading(false);
}
```

after:

```ts
} finally {
  if (!signal?.aborted) {
    setTrayLoading(false);
    setLoading(false);
  }
}
```

`gui/src/pages/Storage.tsx:130-134` — before:

```ts
} finally {
  // Unconditional: aborted requests may briefly clear loading before the next
  // effect-owned fetch sets it true again (react-doctor: no-loading-flag-reset-outside-finally).
  setLoading(false);
}
```

after:

```ts
} finally {
  if (!signal?.aborted) setLoading(false);
}
```

`gui/src/pages/Usage.tsx:567-570` — before:

```ts
} finally {
  // Unconditional clear; a newer effect-owned fetch re-sets loading true.
  setLoading(false);
}
```

after:

```ts
} finally {
  if (!signal.aborted) setLoading(false);
}
```

린터를 만족시키려고 abort 가드를 약화한 것이므로, 소유권 판정으로 되돌린다.

## 결함 4 — `debugBusy` 제거로 PUT 중 컨트롤이 열려 있음

`gui/src/pages/Debug.tsx:15-20,125-145,161-168`.

import 교체:

```ts
import {
  setClientResourceData,
  useKeyedClientResource,
} from "../client-resource";
```

`const { t } = useI18n();` 뒤에 상태 추가:

```ts
const [debugBusy, setDebugBusy] = useState(false);
```

`setDebugFlag` 교체:

```ts
const setDebugFlag = async (
  flag: "debug" | "usage" | "injection" | "claude",
  enabled: boolean,
) => {
  setDebugBusy(true);
  try {
    const res = await fetch(`${apiBase}/api/debug`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [flag]: enabled }),
    });
    if (res.ok) {
      const next = await res.json() as DebugSettings;
      setClientResourceData(`debug-settings:${apiBase}`, next);
    }
  } catch {
    // Keep the last confirmed settings.
  } finally {
    setDebugBusy(false);
  }
};
```

`resetDebug`도 같은 형태로 교체하되 body는 `{ reset: true }`.

마지막으로 `debugBusy={false}` → `debugBusy={debugBusy}`.

PUT 응답을 그대로 캐시에 심는 것이 핵심이다. busy만 복원하고 `debugPoll.refresh()`를 부르면
컨트롤이 PUT 이전 값을 보여주는 상태로 다시 열린다.

## 결함 5 — Claude inbound 행 key 충돌

`gui/src/pages/debug-claude-inbound-panel.tsx:30-32`. 생산자가
`src/claude/inbound-debug.ts:85`에서 `Date.now()`를 찍어 같은 ms에 동일 모델 요청이
여러 건 잡히면 key가 겹친다.

before:

```tsx
{entries.map(entry => (
  <tr key={`${entry.at}:${entry.endpoint}:${entry.model}`}>
```

after (리팩터 이전 계약 복원):

```tsx
{entries.map((entry, index) => (
  <tr key={`${entry.at}-${index}`}>
```

링은 최신순이고 서버 시퀀스 필드가 없으므로 index 성분이 유일성을 만든다.

## 회귀 테스트

A-gate blocker 3 반영: 최초 안은 `installPendingFetch` / `render` / `refreshButton`을
정의 없이 참조했다. 세 헬퍼 모두 `dev`·#466·#467·#468 어디에도 없다. 컴파일 자체가
불가능했으므로 전체 파일 계약을 아래에 확정한다.

NEW(폐기): `gui/tests/react-doctor-pages.test.tsx` — 기여자가 동등 범위를 세 파일로
이미 제공하므로 작성하지 않는다. 아래 테스트 설계는 보강 케이스의 참고용으로만 남긴다.

### 파일 상단 — import와 전역 하네스 (필수, 생략 금지)

```tsx
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Debug from "../src/pages/Debug";
import Startup from "../src/pages/Startup";
import Storage from "../src/pages/Storage";
import Usage from "../src/pages/Usage";
import { DebugClaudeInboundPanel } from "../src/pages/debug-claude-inbound-panel";

const globals = [
  "document",
  "window",
  "navigator",
  "fetch",
  "ResizeObserver",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let container: HTMLElement;
let root: Root | null;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previous;

  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    ResizeObserver: { configurable: true, value: ResizeObserverStub },
  });
  Object.defineProperty(win, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

  container = document.createElement("div");
  document.body.append(container);
  root = null;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  win.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previous[key],
    });
  }
});
```

### 헬퍼 3종 — 정의 (blocker 3의 직접 해소)

```tsx
async function render(node: ReactElement): Promise<void> {
  await act(async () => {
    if (!root) root = createRoot(container);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}

type PendingRequest = {
  url: string;
  signal?: AbortSignal;
  reject: (reason?: unknown) => void;
};

/** Replaces global fetch with a queue that never settles on its own. */
function installPendingFetch(): PendingRequest[] {
  const pending: PendingRequest[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        pending.push({
          url: String(input),
          signal: init?.signal ?? undefined,
          reject,
        });
      }),
  });
  return pending;
}

function refreshButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find(candidate => candidate.textContent?.includes(label));
  if (!button) throw new Error(`refresh button not found: ${label}`);
  return button;
}
```

### 테스트 1-3 — abort 소유권 (Startup / Storage / Usage 동형)

```tsx
test("Startup keeps loading owned by the replacement request after the old request aborts", async () => {
  const pending = installPendingFetch();

  await render(<Startup apiBase="/old" />);
  expect(pending).toHaveLength(1);

  await render(<Startup apiBase="/new" />);
  expect(pending).toHaveLength(2);
  expect(pending[0]!.signal?.aborted).toBe(true);

  await act(async () => {
    pending[0]!.reject(new DOMException("aborted", "AbortError"));
    await Promise.resolve();
  });

  expect(refreshButton("Refresh").disabled).toBe(true);
  expect(container.textContent).toContain("Checking startup protection");
});
```

핵심은 **교체 요청이 시작된 뒤에** 이전 요청을 reject하는 순서다.

A-gate R2 blocker 3 반영: "동일 구조"로 넘기지 않고 Storage/Usage 본문도 전부 적는다.

```tsx
test("Storage keeps loading owned by the replacement request after the old request aborts", async () => {
  const pending = installPendingFetch();

  await render(<Storage apiBase="/old" />);
  expect(pending).toHaveLength(1);

  await render(<Storage apiBase="/new" />);
  expect(pending).toHaveLength(2);
  expect(pending[0]!.signal?.aborted).toBe(true);

  await act(async () => {
    pending[0]!.reject(new DOMException("aborted", "AbortError"));
    await Promise.resolve();
  });

  // Storage's button is "Rescan", not "Refresh" — see the label table below.
  expect(refreshButton("Rescan").disabled).toBe(true);
  expect(container.textContent).toContain("Scanning storage");
});

test("Usage keeps the replacement request loading after the previous request aborts", async () => {
  const pending = installPendingFetch();

  await render(<Usage apiBase="/old" />);
  expect(pending).toHaveLength(1);

  await render(<Usage apiBase="/new" />);
  expect(pending.length).toBeGreaterThanOrEqual(2);
  expect(pending[0]!.signal?.aborted).toBe(true);

  await act(async () => {
    pending[0]!.reject(new DOMException("aborted", "AbortError"));
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Loading usage data");
});
```

Usage만 `toBeGreaterThanOrEqual(2)`인 이유: Usage 페이지는 range/surface에 따라 마운트당
요청을 2건 이상 낼 수 있어 정확 개수를 고정하면 취약해진다. abort 소유권 검증에는
`pending[0]`의 상태만 있으면 충분하다.

### 버튼 라벨 확정 (A-gate R3 blocker 1)

"B 단계에서 확인"으로 미뤘던 라벨을 실제 사전에서 읽어 확정했다.
`git show pr-468:gui/src/i18n/en.ts` 기준:

| 키 | en-US 렌더 | 사용처 |
|---|---|---|
| `startup.refresh` (`:40`) | `Refresh` | Startup 테스트 |
| `storage.refresh` (`:602`) | **`Rescan`** | Storage 테스트 |
| `debug.reset` (`:542`) | `Clear runtime overrides` | Debug 테스트 |

**Storage는 `Refresh`가 아니라 `Rescan`이다.** 위 Storage 테스트의
위 Storage 테스트 본문에 이미 반영했다. 잘못된 라벨을 쓰면 `refreshButton`이 헬퍼 안에서
throw해 수정 전후 모두 실패한다 — RED가 결함이 아니라 셀렉터 오류에서 나오므로
회귀 테스트로서 무의미해진다.

로딩 문구 3종(`"Checking startup protection"`, `"Scanning storage"`,
`"Loading usage data"`)도 B 단계 첫 동작에서 같은 사전으로 대조한다.

### 테스트 4 — PUT 중 컨트롤 잠금

```tsx
test("Debug disables settings during a PUT and installs the returned settings before re-enabling them", async () => {
  const initial = {
    enabled: false, usage: false, injection: false, claude: false,
    runtimeOverride: {},
    env: { debug: false, usage: false, injection: false, claude: false },
  };
  const updated = { ...initial, enabled: true, runtimeOverride: { debug: true } };

  let resolvePut!: (response: Response) => void;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return await new Promise<Response>(resolve => { resolvePut = resolve; });
      }
      return new Response(JSON.stringify(initial), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await render(<Debug apiBase="/debug-busy-regression" />);

  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Provider debug"]');
  expect(toggle).not.toBeNull();
  expect(toggle!.getAttribute("aria-pressed")).toBe("false");

  await act(async () => toggle!.click());

  const switches = Array.from(container.querySelectorAll<HTMLButtonElement>("button.switch"));
  expect(switches).toHaveLength(4);
  expect(switches.every(button => button.disabled)).toBe(true);
  expect(refreshButton("Clear runtime overrides").disabled).toBe(true);

  await act(async () => {
    resolvePut(new Response(JSON.stringify(updated), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await Promise.resolve();
  });

  const updatedToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Provider debug"]');
  expect(updatedToggle?.disabled).toBe(false);
  expect(updatedToggle?.getAttribute("aria-pressed")).toBe("true");
});
```

### 테스트 5 — 행 key 유일성

```tsx
test("DebugClaudeInboundPanel does not emit duplicate-key warnings for simultaneous equal captures", async () => {
  const entry = {
    at: 1_700_000_000_000,
    endpoint: "messages",
    model: "claude-test",
    hasMetadataUserId: false,
    hasSystem: false,
  };

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  try {
    await render(<DebugClaudeInboundPanel entries={[entry, { ...entry }]} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(errors.join("\n")).not.toContain("Encountered two children with the same key");
  } finally {
    console.error = originalError;
  }
});
```

### 선행 확인 (B 단계 첫 동작)

`gui/tests/`가 테스트 루트로 동작하는지, `happy-dom`이 `gui/package.json`에 있는지,
`DebugClaudeInboundPanel`이 named export인지 세 가지를 먼저 확인한다.
하나라도 없으면 그 자체가 B 단계 첫 작업 항목이다.

RED→GREEN 근거: 1-3은 무조건 `finally`가 활성 요청의 loading을 지워 실패,
4는 `debugBusy={false}`라 disabled assertion에서 실패, 5는 중복 key 경고가 잡혀 실패한다.

## 활성화 시나리오

새 분기 3종이 모두 테스트로 활성화된다: `signal.aborted` 가드(1-3),
`debugBusy` 상태 전이(4), index 기반 key(5). 관찰 효과는 각각
로딩 텍스트 유지 / 버튼 disabled / 경고 부재다.

## 커밋

```
fix(gui): preserve request ownership and mutation state in page cleanup (#468)

Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>
```

## 검증

```bash
# 기여자 테스트 3건 + 우리 보강분
cd gui && bun test tests/storage-loading-race.test.tsx tests/debug-mutation-busy.test.tsx \
  tests/debug-claude-inbound-keys.test.tsx && cd ..
bun test tests/claude-inbound-debug.test.ts
bun run typecheck
bun run lint:gui
```

`react-doctor-pages.test.tsx`는 **작성하지 않는다.** 기여자가 같은 범위를 세 파일로
이미 커버했다. 우리는 위 blocker 2-4의 보강만 얹는다.

`gui/src/pages/Usage.tsx`는 dev에서도 최근 레이아웃/접근성 작업이 있었다.
merge 결과에서 양쪽 변경이 모두 살아남았는지 확인한다.
