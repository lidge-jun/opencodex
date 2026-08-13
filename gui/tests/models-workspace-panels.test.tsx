/**
 * Models tab workspace — mounted behaviour.
 *
 * The routing helpers are unit-tested at `tests/models-workspace-tabs.test.ts`. This file
 * exists because those assertions cannot see the failures that actually happened here:
 * a component-level early return that unmounted the whole tab tree while the catalog
 * loaded, and a disabled resource that swapped the combo editor for an empty state and
 * destroyed an unsaved draft. Both passed typecheck, lint, and every source-string
 * assertion. Only mounting the thing catches them.
 */
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Models from "../src/pages/Models";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const API_BASE = "http://localhost";

/** Every catalog/combos/routing endpoint the workspace can reach, with counted hits. */
function installFetch(): { hits: Map<string, number> } {
  const hits = new Map<string, number>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = url.replace(API_BASE, "").split("?")[0]!;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    if (url.includes("/api/models")) {
      return Response.json([
        { provider: "openai", id: "gpt-5", namespaced: "openai/gpt-5", native: true },
        { provider: "anthropic", id: "claude", namespaced: "anthropic/claude" },
      ]);
    }
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([{ name: "openai", disabled: false }]);
    if (url.includes("/api/selected-models")) return Response.json({});
    if (url.includes("/api/combos")) return Response.json([]);
    if (url.includes("/api/config")) return Response.json({ providers: { openai: { defaultModel: "gpt-5" } } });
    if (url.includes("/api/routing-profiles")) return Response.json([]);
    if (url.includes("/api/routing-analytics")) return Response.json(null);
    if (url.includes("/api/shadow-call-settings")) return Response.json({ enabled: false });
    if (url.includes("/api/v2")) return new Response(null, { status: 404 });
    if (url.includes("/api/lab/status")) return Response.json({ projectionAvailable: false });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { hits };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#models" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountModels(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Models apiBase={API_BASE} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  return { container, root };
}

const tabs = (container: HTMLElement) => [...container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
const panel = (container: HTMLElement, id: string) => container.querySelector(`#models-panel-${id}`);

test("the strip renders all four tabs with the catalog selected on the bare hash", async () => {
  installFetch();
  const { container, root } = await mountModels();
  try {
    expect(tabs(container).map(t => t.id)).toEqual([
      "models-tab-catalog", "models-tab-combos", "models-tab-routing", "models-tab-compatibility",
    ]);
    const selected = tabs(container).filter(t => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe("models-tab-catalog");
    // Roving tabindex: exactly one tab is in the tab order.
    expect(tabs(container).filter(t => t.tabIndex === 0)).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * The regression that shipped and had to be fixed: catalog loading and cold failure were
 * component-level early returns, so a slow catalog replaced the entire workspace — strip
 * included — and a cold failure left Combos and Routing unreachable.
 */
test("a cold catalog never removes the tab strip", async () => {
  let releaseCatalog!: () => void;
  const gate = new Promise<void>(resolve => { releaseCatalog = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/models")) { await gate; return Response.json([]); }
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([]);
    if (url.includes("/api/selected-models")) return Response.json({});
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root } = await mountModels();
  try {
    // Still cold here: the catalog fetch is parked on the gate.
    expect(tabs(container)).toHaveLength(4);
    expect(panel(container, "catalog")).toBeTruthy();
    releaseCatalog();
    await act(async () => { await Promise.resolve(); });
    expect(tabs(container)).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a cold catalog failure still lets the user reach another tab", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/models")) throw new Error("catalog down");
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([]);
    if (url.includes("/api/selected-models")) return Response.json({});
    if (url.includes("/api/routing-profiles")) return Response.json([]);
    if (url.includes("/api/routing-analytics")) return Response.json(null);
    if (url.includes("/api/config")) return Response.json({ providers: {} });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root } = await mountModels();
  try {
    await act(async () => { await Promise.resolve(); });
    expect(tabs(container)).toHaveLength(4);

    // "Reachable" has to mean the click works and the panel actually appears — asserting
    // the button merely exists would pass with a dead tab.
    await act(async () => {
      (container.querySelector("#models-tab-routing") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    expect(panel(container, "routing")).toBeTruthy();
    expect(panel(container, "routing")?.hasAttribute("hidden")).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

test("panel shells are always present; contents mount lazily and then stay", async () => {
  installFetch();
  const { container, root } = await mountModels();
  try {
    /*
     * The SHELL exists from the first render so every tab's `aria-controls` resolves;
     * a conditional wrapper left the unvisited tab pointing at nothing. The shell is
     * empty until visited, which is what keeps the lazy part lazy.
     */
    expect(panel(container, "combos")).toBeTruthy();
    expect(panel(container, "combos")?.children).toHaveLength(0);
    expect(panel(container, "routing")?.children).toHaveLength(0);

    await act(async () => {
      (container.querySelector("#models-tab-combos") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    expect(panel(container, "combos")!.children.length).toBeGreaterThan(0);
    expect(panel(container, "catalog")?.hasAttribute("hidden")).toBe(true);

    await act(async () => {
      (container.querySelector("#models-tab-catalog") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    // Still mounted, just hidden — this is what lets an unsaved draft survive.
    expect(panel(container, "combos")!.children.length).toBeGreaterThan(0);
    expect(panel(container, "combos")?.hasAttribute("hidden")).toBe(true);
    expect(panel(container, "catalog")?.hasAttribute("hidden")).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * Every tab's `aria-controls` must resolve from the first render, including for tabs
 * that have never been opened. A conditional panel wrapper broke this silently.
 */
test("every tab controls an element that exists before it is visited", async () => {
  installFetch();
  const { container, root } = await mountModels();
  try {
    for (const tabEl of tabs(container)) {
      const target = tabEl.getAttribute("aria-controls")!;
      expect(container.querySelector(`#${target}`)).toBeTruthy();
    }
  } finally {
    await act(async () => root.unmount());
  }
});

test("every rendered panel is wired to its tab", async () => {
  installFetch();
  const { container, root } = await mountModels();
  try {
    for (const id of ["combos", "routing", "compatibility"]) {
      await act(async () => {
        (container.querySelector(`#models-tab-${id}`) as HTMLButtonElement).click();
      });
      await act(async () => { await Promise.resolve(); });
    }
    for (const id of ["catalog", "combos", "routing", "compatibility"]) {
      const p = panel(container, id)!;
      expect(p.getAttribute("role")).toBe("tabpanel");
      expect(p.getAttribute("aria-labelledby")).toBe(`models-tab-${id}`);
      const tab = container.querySelector(`#models-tab-${id}`)!;
      expect(tab.getAttribute("aria-controls")).toBe(`models-panel-${id}`);
    }
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * The ARIA test above pins wiring, not isolation — it would pass with every boundary
 * deleted. This one makes a panel actually throw. App's boundary is keyed by page, and
 * all four tabs are now one page, so without per-panel boundaries one broken tab would
 * take the whole workspace down and stay broken across a switch.
 */
test("a panel load failure does not take its siblings with it", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/models")) return Response.json([]);
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([]);
    if (url.includes("/api/selected-models")) return Response.json({});
    // A shape the combos loader cannot parse into a coherent page.
    if (url.includes("/api/combos")) return Response.json({ combos: { not: "an array" } });
    if (url.includes("/api/config")) return Response.json(null);
    if (url.includes("/api/routing-profiles")) return Response.json([]);
    if (url.includes("/api/routing-analytics")) return Response.json(null);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root } = await mountModels();
  try {
    await act(async () => {
      (container.querySelector("#models-tab-combos") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });

    // Whatever Combos did, the strip and the other tabs must still be usable. This is a
    // failed LOAD, not a render throw — the boundary mechanism itself is covered by
    // error-boundary.test.tsx; what matters here is that one panel's failure is
    // contained.
    expect(tabs(container)).toHaveLength(4);
    await act(async () => {
      (container.querySelector("#models-tab-routing") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    expect(panel(container, "routing")?.hasAttribute("hidden")).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * The whole point of gating: a hidden catalog must stop polling.
 *
 * The first version waited 60ms against a 10-SECOND poll interval, so it passed whether
 * or not the poll was gated — a green assertion proving nothing. Fake timers advance
 * past a full period without spending it, following `logs-auto-refresh.test.tsx`. The
 * counted endpoint is catalog-exclusive; `/api/models` is requested by several panels.
 */
test("a hidden catalog stops polling across a full interval", async () => {
  const { hits } = installFetch();
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  const { container, root } = await mountModels();
  try {
    await act(async () => { await Promise.resolve(); });
    expect(hits.get("/api/provider-context-caps") ?? 0).toBeGreaterThan(0);

    await act(async () => {
      (container.querySelector("#models-tab-routing") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    const afterSwitch = hits.get("/api/provider-context-caps") ?? 0;

    // Past one full poll period. A shorter advance cannot tell a gated poll from an
    // ungated one, which is exactly how the first version of this test lied.
    await act(async () => { jest.advanceTimersByTime(11_000); });
    await act(async () => { await Promise.resolve(); });
    expect(hits.get("/api/provider-context-caps") ?? 0).toBe(afterSwitch);
  } finally {
    await act(async () => root.unmount());
    jest.useRealTimers();
  }
});

/*
 * The failure that actually shipped: an unsaved draft vanished on a tab switch. The
 * lazy-mount test above cannot catch it — the panel wrapper stayed mounted the whole
 * time while the editor subtree underneath was replaced.
 */
test("an unsaved combo draft survives a tab switch", async () => {
  installFetch();
  const { container, root } = await mountModels();
  try {
    await act(async () => {
      (container.querySelector("#models-tab-combos") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });

    const field = () => panel(container, "combos")?.querySelector("input") as HTMLInputElement | null;
    const input = field();
    expect(input).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        testWindow.HTMLInputElement.prototype, "value",
      )?.set;
      setter?.call(input, "draft-probe");
      input!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(field()?.value).toBe("draft-probe");

    await act(async () => {
      (container.querySelector("#models-tab-catalog") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      (container.querySelector("#models-tab-combos") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });

    expect(field()?.value).toBe("draft-probe");
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * A reactivation whose fetch fails is classified `failed-cold` once the store has been
 * evicted, and replacing the workspace there would destroy the retained draft.
 */
test("a failed combos reload keeps the workspace instead of replacing it", async () => {
  let failNext = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (failNext && url.includes("/api/combos")) throw new Error("combos down");
    if (url.includes("/api/models")) return Response.json([]);
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([]);
    if (url.includes("/api/selected-models")) return Response.json({});
    if (url.includes("/api/combos")) return Response.json([]);
    if (url.includes("/api/config")) return Response.json({ providers: {} });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root } = await mountModels();
  try {
    await act(async () => {
      (container.querySelector("#models-tab-combos") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    expect(panel(container, "combos")?.querySelector(".combos-workspace-root")).toBeTruthy();

    failNext = true;
    await act(async () => {
      (container.querySelector("#models-tab-catalog") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      (container.querySelector("#models-tab-combos") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });

    expect(panel(container, "combos")?.querySelector(".combos-workspace-root")).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
  }
});
