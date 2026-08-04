import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { Window } from "happy-dom";
import { normalizeHashPath, replaceHash, navigateHash } from "../src/hash-routing";
import { hashBelongsToPage, readPageFromHash, resolveAppHashChange } from "../src/app-routing";

/**
 * Hash routing contract after WP5 removed the Classic/Workspace split.
 *
 * The cases that survived from the dual-layout era are the ones that were never about
 * the preference: the generic helpers, history semantics, and passive normalization.
 * The legacy `#providers/workspace` deep link is kept as a REDIRECT case — it must land
 * on `#providers` without trapping Back.
 */

describe("hash helpers", () => {
  let win: Window;
  let previous: Record<string, unknown>;
  const keys = ["window", "document"] as const;

  beforeEach(() => {
    previous = Object.fromEntries(keys.map((k) => [k, Reflect.get(globalThis, k)]));
    win = new Window({ url: "http://localhost/#providers" });
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: win },
      document: { configurable: true, value: win.document },
    });
  });

  afterEach(() => {
    for (const k of keys) Object.defineProperty(globalThis, k, { configurable: true, value: previous[k] });
  });

  test("normalizeHashPath strips the leading marker in both forms", () => {
    expect(normalizeHashPath("#providers")).toBe("providers");
    expect(normalizeHashPath("#/providers")).toBe("providers");
    expect(normalizeHashPath("providers")).toBe("providers");
  });

  test("replaceHash does not increase history length", () => {
    const before = win.history.length;
    replaceHash("models", win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBe(before);
  });

  test("navigateHash creates a deliberate history entry", () => {
    const before = win.history.length;
    navigateHash("models", win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBeGreaterThan(before);
  });
});

describe("route resolution", () => {
  test("bare page hashes resolve without a rewrite", () => {
    for (const page of ["dashboard", "providers", "models", "logs", "usage"]) {
      expect(resolveAppHashChange(page).replaceTo).toBeNull();
    }
  });

  test("the legacy workspace deep link redirects to #providers", () => {
    // WP5: the dual-layout hash is no longer a route. It must normalise away rather
    // than persist, and replaceTo (not a push) keeps Back usable.
    expect(hashBelongsToPage("providers/workspace", "providers")).toBe(false);
    const action = resolveAppHashChange("providers/workspace");
    expect(action.page).toBe("providers");
    expect(action.replaceTo).toBe("providers");
  });

  test("registered sub-hashes survive; unknown ones are normalised away", () => {
    expect(resolveAppHashChange("logs/debug").replaceTo).toBeNull();
    expect(resolveAppHashChange("dashboard/models").replaceTo).toBeNull();
    expect(resolveAppHashChange("providers/nope").replaceTo).toBe("providers");
    expect(resolveAppHashChange("models/nope").replaceTo).toBe("models");
  });

  test("legacy #debug still maps onto the Logs tab", () => {
    const action = resolveAppHashChange("debug");
    expect(action.page).toBe("logs");
    expect(action.replaceTo).toBe("logs/debug");
  });

  test("an unknown page falls back to the dashboard", () => {
    expect(readPageFromHash("#nonsense")).toBe("dashboard");
  });
});


describe("useAppRouteState (real hook)", () => {
  const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  let previous: Record<(typeof globals)[number], unknown>;
  let win: Window;
  let host: HTMLElement;
  let root: import("react-dom/client").Root | null = null;

  async function mountAt(hash: string, storage?: Storage) {
    win = new Window({ url: `http://localhost/${hash}` });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: win.document },
      window: { configurable: true, value: win },
      navigator: { configurable: true, value: win.navigator },
      localStorage: { configurable: true, value: storage ?? win.localStorage },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as never);

    // Lazy imports: a static react-dom/client import binds to the document that existed
    // when the module graph loaded and corrupts sibling suites in the same process.
    const [{ act }, { createRoot }, { useAppRouteState }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("../src/use-app-route-state"),
    ]);
    const seen: { current: ReturnType<typeof useAppRouteState> | null } = { current: null };
    function Probe() {
      seen.current = useAppRouteState();
      return null;
    }
    await act(async () => {
      root = createRoot(host);
      root.render(<Probe />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    return { seen, act };
  }

  beforeEach(() => {
    previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      const { act } = await import("react");
      await act(async () => { current.unmount(); });
      root = null;
    }
    for (const key of globals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  });

  test("the legacy workspace hash is REPLACED, so Back is not trapped", async () => {
    const { seen, act } = await mountAt("#dashboard");

    // Build a real prior entry, then navigate onto the legacy hash the way a bookmark
    // or a pasted link would.
    const baseline = win.history.length;
    await act(async () => { seen.current!.navigateToPage("models"); });
    expect(win.history.length).toBeGreaterThan(baseline);

    const beforeLegacy = win.history.length;
    await act(async () => {
      win.location.hash = "providers/workspace";
      win.dispatchEvent(new win.HashChangeEvent("hashchange"));
      await new Promise((r) => setTimeout(r, 10));
    });

    // The rewrite itself must be a replace, so it adds no entry beyond the navigation.
    expect(normalizeHashPath(win.location.hash)).toBe("providers");
    expect(seen.current!.page).toBe("providers");
    expect(win.history.length).toBe(beforeLegacy + 1);

    // And Back must reach the previous page rather than bouncing on a rewritten entry.
    await act(async () => {
      win.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(seen.current!.page).toBe("models");
  });

  test("an unknown suffix is normalised through the hook", async () => {
    const { seen } = await mountAt("#models/nope");
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(seen.current!.page).toBe("models");
  });

  test("navigateToPage pushes a history entry", async () => {
    const { seen, act } = await mountAt("#dashboard");
    const before = win.history.length;
    await act(async () => {
      seen.current!.navigateToPage("models");
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBeGreaterThan(before);
  });

  test("stale layout-preference keys are cleared on mount", async () => {
    const seed = new Window({ url: "http://localhost/#dashboard" });
    seed.localStorage.setItem("ocx-global-view", "workspace");
    seed.localStorage.setItem("ocx-providers-view", "classic");
    seed.localStorage.setItem("keep-me", "yes");

    await mountAt("#dashboard", seed.localStorage as unknown as Storage);

    expect(seed.localStorage.getItem("ocx-global-view")).toBeNull();
    expect(seed.localStorage.getItem("ocx-providers-view")).toBeNull();
    // Unrelated keys must survive the cleanup.
    expect(seed.localStorage.getItem("keep-me")).toBe("yes");
  });

  test("a throwing storage does not break routing", async () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    } as unknown as Storage;

    const { seen } = await mountAt("#providers/workspace", throwing);
    // Cleanup failure is swallowed; the redirect still happens.
    expect(normalizeHashPath(win.location.hash)).toBe("providers");
    expect(seen.current!.page).toBe("providers");
  });
});
