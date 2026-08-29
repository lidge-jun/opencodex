import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { DashboardOverviewHead } from "../src/pages/dashboard-overview-head";
import { DashboardProvidersSection } from "../src/pages/dashboard-providers-section";
import type { HealthData, ProviderInfo } from "../src/pages/dashboard-shared";

/* ------------------------------------------------------------------ */
/*  Global stubs — same pattern as logs-auto-refresh.test.tsx         */
/* ------------------------------------------------------------------ */

const globals = [
  "document", "window", "navigator", "localStorage",
  "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver",
] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
        toJSON() { return this; },
      };
    },
  });
  class ResizeObserverStub {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
    observe(target: Element) {
      this.#cb(
        [{
          target,
          contentRect: {
            x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
            toJSON() { return this; },
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#dashboard" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  clearClientResourceStoresForTests();
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/* ------------------------------------------------------------------ */
/*  DashboardOverviewHead                                             */
/* ------------------------------------------------------------------ */

function makeOverviewProps(overrides: Partial<Parameters<typeof DashboardOverviewHead>[0]> = {}) {
  return {
    locale: "en" as const,
    health: null as HealthData | null,
    providers: [] as ProviderInfo[],
    usage30d: null as { summary: { requests: number; totalTokens: number; coverageRatio: number } } | null,
    usageLoading: false,
    healthLoading: false,
    startupHealth: undefined as "native" | "protected" | "at-risk" | "error" | undefined,
    projectConfigWarnings: [] as Array<{ path: string; issues: string[]; bypass: string }>,
    maMode: "default" as const,
    maBusy: false,
    maHelpTriggerRef: { current: null },
    maHelpOpen: false,
    setMaHelpOpen: () => {},
    switchMaMode: () => {},
    maError: undefined as string | undefined,
    ...overrides,
  };
}

async function mountOverview(overrides: Partial<Parameters<typeof DashboardOverviewHead>[0]> = {}) {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  const props = makeOverviewProps(overrides);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <DashboardOverviewHead {...props} />
      </LanguageProvider>,
    );
  });
  await flushMicrotasks();
  return { root, container };
}

/* ------------------------------------------------------------------ */
/*  DashboardProvidersSection                                         */
/* ------------------------------------------------------------------ */

function fakeT(key: string, vars?: Record<string, unknown>): string {
  const dict: Record<string, string> = {
    "dash.activeProviders": "Active providers",
    "dash.noProviders": "No providers configured. Run {cmd}.",
    "dash.col.name": "Name",
    "dash.col.adapter": "Adapter",
    "dash.col.baseUrl": "Base URL",
    "dash.col.model": "Model",
    "dash.col.status": "Status",
    "dash.providerStatus.ok": "Healthy",
    "dash.providerStatus.error": "Error",
    "dash.providerStatus.disabled": "Disabled",
    "dash.providerStatus.unknown": "Unknown",
  };
  let value = dict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replaceAll(`{${k}}`, String(v));
    }
  }
  return value;
}

function makeProvider(overrides: Partial<ProviderInfo> & { name: string }): ProviderInfo {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.openai.com",
    hasApiKey: true,
    ...overrides,
  };
}

async function mountProvidersSection(providers: ProviderInfo[]) {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <DashboardProvidersSection t={fakeT} providers={providers} />,
    );
  });
  await flushMicrotasks();
  return { root, container };
}

function getStatusChip(container: HTMLElement): HTMLElement | null {
  const row = container.querySelector("tbody tr");
  if (!row) return null;
  const cells = row.querySelectorAll("td");
  const lastCell = cells[cells.length - 1];
  return lastCell?.querySelector(".chip") ?? null;
}

/* ------------------------------------------------------------------ */
/*  Tests: DashboardOverviewHead — port rendering                      */
/* ------------------------------------------------------------------ */

test("DashboardOverviewHead renders port when health data includes it", async () => {
  const { root, container } = await mountOverview({
    health: { status: "ok", version: "2.36.0", uptime: 100, port: 10100 },
  });
  expect(container.textContent).toContain("Port");
  expect(container.textContent).toContain("10100");
  await act(async () => { root.unmount(); });
});

test("DashboardOverviewHead shows placeholder when port is missing", async () => {
  const { root, container } = await mountOverview({
    health: { status: "ok", version: "2.36.0", uptime: 100 },
  });
  expect(container.textContent).toContain("Port");
  // health.port is undefined → fallback "—"
  expect(container.textContent).toContain("—");
  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------------ */
/*  Tests: DashboardProvidersSection — status column                   */
/* ------------------------------------------------------------------ */

test("DashboardProvidersSection renders status column with ok status", async () => {
  const { root, container } = await mountProvidersSection([
    makeProvider({ name: "openai", discovery: { status: "ok" } }),
  ]);
  expect(container.querySelector(".tbl")).not.toBeNull();
  const chip = getStatusChip(container)!;
  expect(chip).not.toBeNull();
  expect(chip.textContent).toContain("Healthy");
  expect((chip.getAttribute("style") ?? "").includes("var(--green)")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("DashboardProvidersSection renders status column with failed status", async () => {
  const { root, container } = await mountProvidersSection([
    makeProvider({
      name: "anthropic",
      discovery: { status: "failed", reason: "401 Unauthorized" },
    }),
  ]);
  const chip = getStatusChip(container)!;
  expect(chip).not.toBeNull();
  expect(chip.textContent).toContain("Error");
  expect((chip.getAttribute("style") ?? "").includes("var(--red)")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("DashboardProvidersSection renders status column with disabled provider", async () => {
  const { root, container } = await mountProvidersSection([
    makeProvider({ name: "old-provider", disabled: true, discovery: { status: "ok" } }),
  ]);
  const chip = getStatusChip(container)!;
  expect(chip).not.toBeNull();
  expect(chip.textContent).toContain("Disabled");
  expect((chip.getAttribute("style") ?? "").includes("var(--muted)")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("DashboardProvidersSection renders status column with unknown status when no discovery", async () => {
  const { root, container } = await mountProvidersSection([
    makeProvider({ name: "mystery-provider" }),
  ]);
  const chip = getStatusChip(container)!;
  expect(chip).not.toBeNull();
  expect(chip.textContent).toContain("Unknown");
  expect((chip.getAttribute("style") ?? "").includes("var(--muted)")).toBe(true);
  await act(async () => { root.unmount(); });
});
