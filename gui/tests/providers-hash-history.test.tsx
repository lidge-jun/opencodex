import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { resolveAppHashChange } from "../src/app-routing";
import {
  navigateHash,
  normalizeHashPath,
  replaceHash,
  resolveProvidersHashChange,
} from "../src/hash-routing";
import { useAppRouteState } from "../src/use-app-route-state";
import {
  GLOBAL_VIEW_KEY,
  providersHashForViewMode,
  readViewMode,
  writeViewMode,
  type ViewMode,
} from "../src/view-mode";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let fetchMock: typeof fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#dashboard" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.localStorage.clear();
  fetchMock = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchMock;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

describe("hash-routing helpers", () => {
  test("replaceHash does not increase history length", () => {
    testWindow.location.hash = "#providers";
    const afterAssign = testWindow.history.length;
    replaceHash("providers/workspace", testWindow as unknown as Window);
    expect(normalizeHashPath(testWindow.location.hash)).toBe("providers/workspace");
    expect(testWindow.history.length).toBe(afterAssign);
  });

  test("navigateHash creates a deliberate history entry", () => {
    testWindow.location.hash = "#providers";
    const before = testWindow.history.length;
    navigateHash("providers/workspace", testWindow as unknown as Window);
    expect(normalizeHashPath(testWindow.location.hash)).toBe("providers/workspace");
    expect(testWindow.history.length).toBeGreaterThan(before);
  });

  test("resolveProvidersHashChange rewrites bare providers when workspace is preferred", () => {
    expect(resolveProvidersHashChange("providers", "workspace")).toEqual({
      replaceTo: "providers/workspace",
      viewMode: "workspace",
      handledPassively: true,
    });
  });

  test("resolveAppHashChange keeps page and viewMode paired for passive normalize", () => {
    expect(resolveAppHashChange("providers", "workspace")).toEqual({
      page: "providers",
      viewMode: "workspace",
      persistViewMode: "workspace",
      replaceTo: "providers/workspace",
    });
  });
});

/**
 * Thin harness around the production useAppRouteState hook (the same controller App uses).
 * Does not reimplement hash ownership — only renders the controller's state.
 */
function AppRouteHarness({
  onRender,
}: {
  onRender?: (snapshot: { page: string; mode: ViewMode }) => void;
}) {
  const { page, viewMode, toggleGlobalWorkspace, navigateToPage } = useAppRouteState();
  onRender?.({ page, mode: viewMode });
  return (
    <div>
      <div data-testid="page">{page}</div>
      <div data-testid="mode">{viewMode}</div>
      <input aria-label="unsaved-draft" defaultValue="unsaved" />
      <button type="button" data-testid="toggle" onClick={toggleGlobalWorkspace}>toggle</button>
      <button type="button" data-testid="go-dashboard" onClick={() => navigateToPage("dashboard")}>dashboard</button>
      <button type="button" data-testid="go-providers" onClick={() => navigateToPage("providers")}>providers</button>
      <button type="button" data-testid="go-models" onClick={() => navigateToPage("models")}>models</button>
      <button type="button" data-testid="go-claude" onClick={() => navigateToPage("claude")}>claude</button>
      <button type="button" data-testid="go-logs" onClick={() => navigateToPage("logs")}>logs</button>
    </div>
  );
}

async function awaitNavigation(action: () => void): Promise<void> {
  await act(async () => {
    action();
    // happy-dom may deliver popstate/hashchange just after history.back/forward.
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  });
}

async function historyBack(): Promise<void> {
  await awaitNavigation(() => {
    testWindow.history.back();
  });
}

async function historyForward(): Promise<void> {
  await awaitNavigation(() => {
    testWindow.history.forward();
  });
}

describe("production App route state (useAppRouteState)", () => {
async function mount(initialMode: ViewMode, initialHash: string) {
    writeViewMode(initialMode);
    testWindow.localStorage.setItem(GLOBAL_VIEW_KEY, initialMode);
    // Seed history with the initial hash via assignment (one entry), before React mounts.
    const raw = initialHash.replace(/^#/, "");
    if (normalizeHashPath(testWindow.location.hash) !== raw) {
      testWindow.location.hash = raw;
    }
    // Allow happy-dom to settle the hash before the route hook reads window.location.
    await Promise.resolve();
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;
    const renders: Array<{ page: string; mode: ViewMode }> = [];
    const historyBefore = testWindow.history.length;
    await act(async () => {
      root = createRoot(host);
      root.render(<AppRouteHarness onRender={snap => renders.push(snap)} />);
    });
    // Allow the sync effect to passively replaceHash when needed.
    await act(async () => {
      await Promise.resolve();
    });
    return { root, host, historyBefore, renders };
  }

  test("1. stored Workspace + bare #providers normalizes without growing history", async () => {
    const { root, host, historyBefore, renders } = await mount("workspace", "#providers");
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("providers");
    expect(testWindow.history.length).toBe(historyBefore);
    expect(renders[0]).toEqual({ page: "providers", mode: "workspace" });
    await act(async () => { root.unmount(); });
  });

  test("2. explicit #providers/workspace deep link forces Workspace without duplicate history", async () => {
    const { root, host, historyBefore } = await mount("classic", "#providers/workspace");
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    expect(readViewMode()).toBe("workspace");
    expect(testWindow.history.length).toBe(historyBefore);
    await act(async () => { root.unmount(); });
  });

  test("3. global toggle Classic→Workspace replaces hash (no history push)", async () => {
    const { root, host } = await mount("classic", "#providers");
    const before = testWindow.history.length;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    expect(readViewMode()).toBe("workspace");
    expect(testWindow.history.length).toBe(before);
    await act(async () => { root.unmount(); });
  });

  test("4. global toggle Workspace→Classic replaces hash (no history push)", async () => {
    const { root, host } = await mount("workspace", "#providers/workspace");
    const before = testWindow.history.length;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("classic");
    expect(readViewMode()).toBe("classic");
    expect(testWindow.history.length).toBe(before);
    await act(async () => { root.unmount(); });
  });

  test("5–6. page nav + Workspace toggle: Back returns to Dashboard; Forward restores Providers Workspace", async () => {
    const { root, host } = await mount("classic", "#dashboard");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="go-providers"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("providers");

    const afterProviders = testWindow.history.length;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(testWindow.history.length).toBe(afterProviders);

    await historyBack();
    expect(normalizeHashPath(window.location.hash)).toBe("dashboard");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("dashboard");

    await historyForward();
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("providers");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    await act(async () => { root.unmount(); });
  });

  test("7. stale #providers/#providers/workspace history does not trap Back", async () => {
    writeViewMode("workspace");
    // Build a legacy stack that still contains both Classic and Workspace Providers entries.
    testWindow.location.hash = "dashboard";
    navigateHash("providers", testWindow as unknown as Window);
    navigateHash("providers/workspace", testWindow as unknown as Window);
    expect(testWindow.history.length).toBeGreaterThanOrEqual(3);

    const { root, host } = await mount("workspace", "#providers/workspace");
    const lengthBeforeBack = testWindow.history.length;

    await historyBack();
    // Landing on bare #providers must passively replace to workspace without appending.
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    expect(testWindow.history.length).toBeLessThanOrEqual(lengthBeforeBack);

    await historyBack();
    expect(normalizeHashPath(window.location.hash)).toBe("dashboard");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("dashboard");
    await act(async () => { root.unmount(); });
  });

  test("8. non-Providers routes keep their hash when view mode changes", async () => {
    const { root, host } = await mount("workspace", "#dashboard");
    for (const id of ["go-dashboard", "go-claude", "go-models", "go-logs"] as const) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click();
      });
      const beforeHash = normalizeHashPath(window.location.hash);
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
      });
      expect(normalizeHashPath(window.location.hash)).toBe(beforeHash);
    }
    await act(async () => { root.unmount(); });
  });

  test("9. unsaved local state survives a global view-mode toggle", async () => {
    const { root, host } = await mount("classic", "#dashboard");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="unsaved-draft"]')!;
    input.value = "keep-me";
    expect(input.value).toBe("keep-me");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    // Uncontrolled input retains DOM value across viewMode updates (no remount).
    expect(host.querySelector<HTMLInputElement>('input[aria-label="unsaved-draft"]')?.value).toBe("keep-me");
    await act(async () => { root.unmount(); });
  });

  test("Providers first paint matches final route contract for workspace deep link", async () => {
    const { root, renders } = await mount("classic", "#providers/workspace");
    const providersRenders = renders.filter(r => r.page === "providers");
    expect(providersRenders.length).toBeGreaterThan(0);
    expect(providersRenders[0]?.mode).toBe("workspace");
    expect(providersRenders.every(r => r.mode === "workspace")).toBe(true);
    await act(async () => { root.unmount(); });
  });

  test("preferred providers hash helper stays aligned with view mode", () => {
    expect(providersHashForViewMode("workspace")).toBe("providers/workspace");
    expect(providersHashForViewMode("classic")).toBe("providers");
  });
});

describe("runtime viewMode survives storage failure", () => {
  function installThrowingStorage() {
    const throwing = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
      clear() { throw new Error("blocked"); },
      key() { throw new Error("blocked"); },
      get length() { throw new Error("blocked"); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: throwing });
    Object.defineProperty(testWindow, "localStorage", { configurable: true, value: throwing });
  }

  async function mountThrowing(initialHash: string) {
    installThrowingStorage();
    if (normalizeHashPath(testWindow.location.hash) !== initialHash.replace(/^#/, "")) {
      testWindow.location.hash = initialHash.replace(/^#/, "");
    }
    await Promise.resolve();
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;
    await act(async () => {
      root = createRoot(host);
      root.render(<AppRouteHarness />);
    });
    await act(async () => { await Promise.resolve(); });
    return { root, host };
  }

  test("getItem failure initializes Classic without crashing", async () => {
    const { root, host } = await mountThrowing("#dashboard");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("classic");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("dashboard");
    await act(async () => { root.unmount(); });
  });

  test("toggle Workspace while setItem throws keeps in-memory Workspace on Providers", async () => {
    const { root, host } = await mountThrowing("#dashboard");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    // Storage still fails — readViewMode must not win over React state.
    expect(readViewMode()).toBe("classic");

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="go-providers"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("providers");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    await act(async () => { root.unmount(); });
  });

  test("toggle Classic while storage throws updates Providers hash from React state", async () => {
    const { root, host } = await mountThrowing("#dashboard");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="go-providers"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("classic");
    expect(normalizeHashPath(window.location.hash)).toBe("providers");
    await act(async () => { root.unmount(); });
  });

  test("Back/Forward after failed persistence stay coherent with in-memory mode", async () => {
    const { root, host } = await mountThrowing("#dashboard");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="go-providers"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");

    await historyBack();
    expect(normalizeHashPath(window.location.hash)).toBe("dashboard");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");

    await historyForward();
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("providers");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    await act(async () => { root.unmount(); });
  });

  test("explicit #providers/workspace deep link works while storage throws", async () => {
    const { root, host } = await mountThrowing("#providers/workspace");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    await act(async () => { root.unmount(); });
  });

  test("multiple toggles keep the latest React mode when storage throws", async () => {
    const { root, host } = await mountThrowing("#dashboard");
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
      });
    }
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="go-providers"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    await act(async () => { root.unmount(); });
  });

  test("non-Providers hashes stay put when toggling with throwing storage", async () => {
    const { root, host } = await mountThrowing("#models");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="go-models"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("models");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("models");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    await act(async () => { root.unmount(); });
  });
});
