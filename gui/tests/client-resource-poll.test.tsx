import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import {
  clearClientResourceStoresForTests,
  hasPollTimerForTests,
  setClientResourceData,
  useClientResource,
  useKeyedClientResource,
} from "../src/client-resource";

// Bun's default per-test budget is 5s. waitFor below is 15s (busy CI runners),
// so every case in this file needs a higher ceiling or the suite fails as
// "waitFor timed out" while the predicate never got its full window.
function test(name: string, fn: () => void | Promise<void>): void {
  bunTest(name, fn, { timeout: 30_000 });
}

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/**
 * 1s was enough on an idle machine and not enough on a loaded CI runner: the
 * visibility test waits for a poll that only fires after a real 20ms interval
 * plus a React commit, and macOS CI blew through the budget mid-suite while the
 * same file passed in isolation. Windows GHA later timed out the same waits at
 * 5s under suite load (`waitFor timed out` on #827). The assertions below are
 * about *whether* the fetch happens, never about how fast, so a longer ceiling
 * costs nothing on a healthy run — it only stops a busy runner from reading as
 * a product bug.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

/**
 * happy-dom derives `visibilityState` from internals, so drive it directly and fire the
 * event the store listens for — the same pair a real tab switch produces.
 */
async function setVisibility(state: "visible" | "hidden"): Promise<void> {
  Object.defineProperty(testWindow.document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  await act(async () => {
    testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
    await Promise.resolve();
  });
}

test("after the latest subscriber unmounts, polling continues with the surviving loader", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const calls: string[] = [];
  const KEY = `poll-survivors-${Date.now()}`;

  function Subscriber({
    label,
    pollMs,
  }: {
    label: string;
    pollMs: number;
  }) {
    useClientResource(
      KEY,
      async () => {
        calls.push(label);
        return label;
      },
      { pollMs },
    );
    return <span data-label={label} />;
  }

  function Harness() {
    const [showLatest, setShowLatest] = useState(true);
    useEffect(() => {
      (window as unknown as { __dropLatest?: () => void }).__dropLatest = () => setShowLatest(false);
    }, []);
    return (
      <>
        <Subscriber label="survivor" pollMs={40} />
        {showLatest ? <Subscriber label="latest" pollMs={40} /> : null}
      </>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });

  // Initial subscribe fetch(es) from both subscribers sharing one store (first only fetches).
  await waitFor(() => calls.length >= 1);
  const beforeUnmount = calls.length;

  await act(async () => {
    (window as unknown as { __dropLatest: () => void }).__dropLatest();
  });

  await waitFor(() => calls.length > beforeUnmount);

  const afterUnmount = calls.slice(beforeUnmount);
  expect(afterUnmount.length).toBeGreaterThan(0);
  expect(afterUnmount.every((label) => label === "survivor")).toBe(true);
  expect(afterUnmount.some((label) => label === "latest")).toBe(false);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

// Hidden suspension means the timer is GONE, not just skipped. Subscriber churn in the
// hidden phase (unmount one of two) runs recomputePoll and must not re-arm it.
test("subscriber churn while hidden never re-arms a timer", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `poll-hidden-churn-${Date.now()}`;
  let fetches = 0;

  function Page({ both }: { both: boolean }) {
    useClientResource(KEY, async () => { fetches += 1; return `v${fetches}`; }, { pollMs: 20 });
    const [showSecond] = useState(both);
    return showSecond ? <Second /> : null;
  }
  function Second() {
    useClientResource(KEY, async () => { fetches += 1; return "s"; }, { pollMs: 40 });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page both={true} />);
  });
  await waitFor(() => fetches >= 1);
  expect(hasPollTimerForTests(KEY)).toBe(true);

  await setVisibility("hidden");
  expect(hasPollTimerForTests(KEY)).toBe(false); // suspended: timer gone

  // Churn: drop the second subscriber while hidden.
  await act(async () => {
    root.render(<Page both={false} />);
  });
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 60));
  });
  expect(hasPollTimerForTests(KEY)).toBe(false);

  await setVisibility("visible");
  await waitFor(() => hasPollTimerForTests(KEY));
  await act(async () => { root.unmount(); });
  container.remove();
});

// A store first subscribed while the tab is already hidden must not create a live timer,
// but its visibility listener must still be installed or nothing would ever resume it.
test("first subscribe while hidden arms no timer and still makes up on visible", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `poll-mount-hidden-${Date.now()}`;
  let fetches = 0;

  await setVisibility("hidden");
  function Page() {
    useClientResource(KEY, async () => { fetches += 1; return `v${fetches}`; }, { pollMs: 20 });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => fetches >= 1); // the cold-start fetch is unaffected by suspension
  expect(hasPollTimerForTests(KEY)).toBe(false);
  const atMount = fetches;
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 80));
  });
  expect(fetches).toBe(atMount); // no ticks while hidden

  await setVisibility("visible");
  await waitFor(() => fetches >= atMount + 1); // make-up fetch proves the listener lived
  await act(async () => { root.unmount(); });
  container.remove();
  await setVisibility("visible");
});

// The opt-out subscriber is what keeps a hidden store ticking. When it leaves while
// hidden, the remaining paused subscribers must not inherit a timer that wakes every
// interval with nothing eligible to run.
test("opt-out leaving while hidden suspends the timer for the paused remainder", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `poll-optout-churn-${Date.now()}`;
  let fetches = 0;

  function Page({ optOut }: { optOut: boolean }) {
    useClientResource(KEY, async () => { fetches += 1; return `v${fetches}`; }, { pollMs: 20 });
    return optOut ? <OptOut /> : null;
  }
  function OptOut() {
    useClientResource(KEY, async () => { fetches += 1; return "o"; }, { pollMs: 20, pauseWhenHidden: false });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page optOut={true} />);
  });
  await waitFor(() => fetches >= 1);

  await setVisibility("hidden");
  // The opt-out keeps the store polling while hidden.
  expect(hasPollTimerForTests(KEY)).toBe(true);
  const atHide = fetches;
  await waitFor(() => fetches > atHide);

  // It leaves; the interval is unchanged, so only an explicit re-check can suspend.
  await act(async () => {
    root.render(<Page optOut={false} />);
  });
  expect(hasPollTimerForTests(KEY)).toBe(false);
  const atSuspend = fetches;
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 80));
  });
  expect(fetches).toBe(atSuspend);

  await setVisibility("visible");
  await waitFor(() => hasPollTimerForTests(KEY));
  await act(async () => { root.unmount(); });
  container.remove();
  await setVisibility("visible");
});

// The mirror case: an opt-out joining an already-suspended store must arm it, since
// noticing an off-screen event is the only reason that subscriber exists.
test("opt-out joining a suspended store arms it while still hidden", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `poll-optout-join-${Date.now()}`;
  let fetches = 0;

  function Page({ optOut }: { optOut: boolean }) {
    useClientResource(KEY, async () => { fetches += 1; return `v${fetches}`; }, { pollMs: 20 });
    return optOut ? <OptOut /> : null;
  }
  function OptOut() {
    useClientResource(KEY, async () => { fetches += 1; return "o"; }, { pollMs: 20, pauseWhenHidden: false });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page optOut={false} />);
  });
  await waitFor(() => fetches >= 1);

  await setVisibility("hidden");
  expect(hasPollTimerForTests(KEY)).toBe(false);

  await act(async () => {
    root.render(<Page optOut={true} />);
  });
  expect(hasPollTimerForTests(KEY)).toBe(true);
  const atJoin = fetches;
  await waitFor(() => fetches > atJoin);

  await act(async () => { root.unmount(); });
  container.remove();
  await setVisibility("visible");
});

// The last polling subscriber leaving WHILE hidden must not strand the store: the flag
// resets with the teardown, so a later poller resumes cleanly on the next visible.
test("last poller leaves while hidden, then a new poller resumes on visible", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `poll-hidden-teardown-${Date.now()}`;
  let fetches = 0;

  function Page({ poller }: { poller: boolean }) {
    useClientResource(KEY, async () => { fetches += 1; return `v${fetches}`; });
    return poller ? <Poller /> : null;
  }
  function Poller() {
    useClientResource(KEY, async () => { fetches += 1; return "p"; }, { pollMs: 20 });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page poller={true} />);
  });
  await waitFor(() => fetches >= 1);

  await setVisibility("hidden");
  expect(hasPollTimerForTests(KEY)).toBe(false);

  // The only poller leaves while hidden: full poll teardown, suspension resets.
  await act(async () => {
    root.render(<Page poller={false} />);
  });
  // A NEW poller subscribes, still hidden: the arm-time guard holds, no timer.
  await act(async () => {
    root.render(<Page poller={true} />);
  });
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 60));
  });
  expect(hasPollTimerForTests(KEY)).toBe(false);

  await setVisibility("visible");
  await waitFor(() => hasPollTimerForTests(KEY));
  const atResume = fetches;
  await waitFor(() => fetches > atResume); // cadence alive again
  await act(async () => { root.unmount(); });
  container.remove();
  await setVisibility("visible");
});

// A hidden tab has nobody reading the paint, so a passive poll there is pure waste. The
// interesting part is what happens on the way back: the skipped ticks are made up once,
// rather than the user waiting out the rest of the interval on stale content.
test("a hidden tab stops passive polling and one quiet fetch makes up for it on return", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `poll-visibility-${Date.now()}`;
  let fetches = 0;

  function Page() {
    useClientResource(KEY, async () => { fetches += 1; return `v${fetches}`; }, { pollMs: 20 });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => fetches >= 1);

  await setVisibility("hidden");
  const atHide = fetches;
  // Several intervals' worth of time passes with the tab in the background.
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 120));
  });
  expect(fetches).toBe(atHide);

  await setVisibility("visible");
  // `>=`, not `===`: the resumed 20ms interval may tick between the catch-up fetch and
  // the next predicate check on a loaded runner, and an exact-equality predicate can then
  // never observe the +1 state and burns the whole budget (windows dev run, 075c2f34c).
  // The hidden-phase assertion above already proves no polling while hidden; this phase
  // proves the catch-up happens promptly rather than after a full interval.
  await waitFor(() => fetches >= atHide + 1);
  expect(fetches).toBeGreaterThanOrEqual(atHide + 1);

  await act(async () => { root.unmount(); });
  container.remove();
});

// The restart-reconnect poll is the counterexample: its entire job is to notice a server
// coming back while the user is looking elsewhere. Pausing it while hidden would break the
// one case it exists for, so it opts out and keeps ticking.
test("a subscriber that opts out keeps polling while hidden", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `poll-visibility-optout-${Date.now()}`;
  let fetches = 0;

  function Page() {
    useClientResource(
      KEY,
      async () => { fetches += 1; return `v${fetches}`; },
      { pollMs: 20, pauseWhenHidden: false },
    );
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => fetches >= 1);

  await setVisibility("hidden");
  const atHide = fetches;
  await waitFor(() => fetches > atHide);
  expect(fetches).toBeGreaterThan(atHide);

  await act(async () => { root.unmount(); });
  container.remove();
});

// Options are per subscriber, not per store: a fixed key can be shared, and one consumer's
// opt-out must not be dropped because a paused peer subscribed to the same key.
test("on a shared key, one opted-out subscriber keeps the hidden tick alive for the store", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `poll-visibility-mixed-${Date.now()}`;
  let fetches = 0;

  function Page() {
    // Paused subscriber first, so the opt-out is the later of the two.
    useClientResource(KEY, async () => { fetches += 1; return `v${fetches}`; }, { pollMs: 20 });
    useClientResource(
      KEY,
      async () => { fetches += 1; return `v${fetches}`; },
      { pollMs: 20, pauseWhenHidden: false },
    );
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => fetches >= 1);

  await setVisibility("hidden");
  const atHide = fetches;
  await waitFor(() => fetches > atHide);
  expect(fetches).toBeGreaterThan(atHide);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("unmounting the subscriber that owns an in-flight request must not overwrite remaining data", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `inflight-owner-${Date.now()}`;
  let resolveB!: (value: string) => void;
  const deferredB = new Promise<string>((resolve) => {
    resolveB = resolve;
  });

  type HarnessApi = {
    dropB: () => void;
    refreshB: () => void;
    readA: () => string | undefined;
  };
  const api: HarnessApi = {
    dropB: () => {},
    refreshB: () => {},
    readA: () => undefined,
  };

  function SubscriberA() {
    const resource = useClientResource(KEY, async () => "from-A");
    useEffect(() => {
      api.readA = () => resource.data;
    }, [resource.data]);
    return <span data-a={resource.data ?? ""} />;
  }

  function SubscriberB() {
    const resource = useClientResource(KEY, async () => deferredB);
    useEffect(() => {
      api.refreshB = () => resource.refresh();
    }, [resource.refresh]);
    return <span data-b="" />;
  }

  function Harness() {
    const [showB, setShowB] = useState(true);
    useEffect(() => {
      api.dropB = () => setShowB(false);
    }, []);
    return (
      <>
        <SubscriberA />
        {showB ? <SubscriberB /> : null}
      </>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });

  await waitFor(() => api.readA() === "from-A");

  await act(async () => {
    api.refreshB();
  });

  await act(async () => {
    api.dropB();
  });

  await act(async () => {
    resolveB("from-B");
  });
  // Settle so a buggy late write would have time to land.
  await waitFor(() => api.readA() === "from-A");
  expect(api.readA()).toBe("from-A");

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("when the in-flight owner unmounts with no cache, a remaining subscriber replaces the fetch", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `replace-inflight-${Date.now()}`;
  const deferredB = new Promise<string>(() => {
    /* intentionally never resolves — owner unmount must replace it */
  });

  type HarnessApi = {
    mountA: () => void;
    dropB: () => void;
    read: () => { data: string | undefined; loading: boolean };
  };
  const api: HarnessApi = {
    mountA: () => {},
    dropB: () => {},
    read: () => ({ data: undefined, loading: false }),
  };

  function SubscriberA() {
    const resource = useClientResource(KEY, async () => "from-A");
    useEffect(() => {
      api.read = () => ({ data: resource.data, loading: resource.loading });
    }, [resource.data, resource.loading]);
    return <span data-a={resource.data ?? ""} data-loading={String(resource.loading)} />;
  }

  function SubscriberB() {
    useClientResource(KEY, async () => deferredB);
    return <span data-b="" />;
  }

  function Harness() {
    const [showA, setShowA] = useState(false);
    const [showB, setShowB] = useState(true);
    useEffect(() => {
      api.mountA = () => setShowA(true);
      api.dropB = () => setShowB(false);
    }, []);
    return (
      <>
        {showB ? <SubscriberB /> : null}
        {showA ? <SubscriberA /> : null}
      </>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });

  // B is sole subscriber with a deferred request → shared snapshot is loading with no data.
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
  });

  await act(async () => {
    api.mountA();
  });

  await act(async () => {
    api.dropB();
  });

  await waitFor(() => api.read().data === "from-A" && api.read().loading === false);

  expect(api.read()).toEqual({ data: "from-A", loading: false });

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("keyed deps changes force loading while retaining previous data until refetch completes", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `keyed-deps-${Date.now()}`;
  let resolveNext!: (value: string) => void;
  let nextValue = new Promise<string>((resolve) => {
    resolveNext = resolve;
  });

  type Snap = { data: string | undefined; loading: boolean };
  let snap: Snap = { data: undefined, loading: false };
  let setFilter!: (value: string) => void;

  function Page() {
    const [filter, setFilterState] = useState("one");
    setFilter = setFilterState;
    const resource = useKeyedClientResource(
      KEY,
      [filter],
      async () => {
        if (filter === "one") return "data-one";
        return nextValue;
      },
    );
    useEffect(() => {
      snap = { data: resource.data, loading: resource.loading };
    }, [resource.data, resource.loading]);
    return <span />;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });

  await waitFor(() => snap.data === "data-one" && snap.loading === false);

  await act(async () => {
    setFilter("two");
  });

  await waitFor(() => snap.loading === true && snap.data === "data-one");

  await act(async () => {
    resolveNext("data-two");
  });
  await waitFor(() => snap.data === "data-two" && snap.loading === false);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("changing pollMs keeps cached data without a cold refetch", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `pollms-churn-${Date.now()}`;
  let fetches = 0;
  type Snap = { data: string | undefined; loading: boolean };
  let snap: Snap = { data: undefined, loading: false };
  let setPollMs!: (value: number) => void;

  function Page() {
    const [pollMs, setPollMsState] = useState(40);
    setPollMs = setPollMsState;
    const resource = useClientResource(
      KEY,
      async () => {
        fetches += 1;
        return "cached";
      },
      { pollMs },
    );
    useEffect(() => {
      snap = { data: resource.data, loading: resource.loading };
    }, [resource.data, resource.loading]);
    return <span />;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });

  await waitFor(() => snap.data === "cached" && snap.loading === false);
  expect(fetches).toBe(1);

  await act(async () => {
    setPollMs(80);
  });

  // Subscribe identity churn must not wipe the store or force a cold fetch.
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 20));
  });
  expect(snap).toEqual({ data: "cached", loading: false });
  expect(fetches).toBe(1);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("store is evicted after the last subscriber leaves", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `store-evict-${Date.now()}`;
  let fetches = 0;
  type Snap = { data: string | undefined };
  let snap: Snap = { data: undefined };

  function Page() {
    const resource = useClientResource(KEY, async () => {
      fetches += 1;
      return `v${fetches}`;
    });
    useEffect(() => {
      snap = { data: resource.data };
    }, [resource.data]);
    return <span />;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => snap.data === "v1");
  expect(fetches).toBe(1);

  await act(async () => {
    root.unmount();
  });
  // Flush deferred eviction.
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });

  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => snap.data === "v2");
  expect(fetches).toBe(2);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("pre-subscribe seed still quiet-revalidates on first subscribe", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `seed-revalidate-${Date.now()}`;
  let fetches = 0;
  setClientResourceData(KEY, "seeded");

  function Page() {
    const resource = useClientResource(KEY, async () => {
      fetches += 1;
      return "fresh";
    });
    return <span>{resource.data ?? ""}</span>;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  // Without seedNeedsRevalidate the mount would skip the fetch entirely (gets stay 0).
  await waitFor(() => fetches === 1 && container.textContent === "fresh");
  expect(fetches).toBe(1);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("StrictMode remount still quiet-revalidates a pre-subscribe seed", async () => {
  const { createRoot } = await import("react-dom/client");
  const { StrictMode } = await import("react");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `seed-strictmode-${Date.now()}`;
  let fetches = 0;
  setClientResourceData(KEY, "seeded");

  function Page() {
    const resource = useClientResource(KEY, async () => {
      fetches += 1;
      return "fresh";
    });
    return <span>{resource.data ?? ""}</span>;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
  });
  // Dev StrictMode aborts the first subscribe's fetch; the remount must still revalidate.
  await waitFor(() => container.textContent === "fresh");
  expect(fetches).toBeGreaterThanOrEqual(1);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
