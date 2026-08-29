import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { DashboardOverviewHead } from "../src/pages/dashboard-overview-head";
import type { HealthData, ProviderInfo } from "../src/pages/dashboard-shared";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#dashboard" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const baseProps = {
  locale: "en",
  health: null as HealthData | null,
  providers: [] as ProviderInfo[],
  usage30d: null as { summary: { requests: number; totalTokens: number; coverageRatio: number } } | null,
  usageLoading: false,
  healthLoading: false,
  startupHealth: null as string | null,
  projectConfigWarnings: [] as Array<{ path: string; issues: string[]; bypass: string }>,
  maMode: "default" as const,
  maBusy: false,
  maHelpTriggerRef: { current: null },
  maHelpOpen: false,
  setMaHelpOpen: () => {},
  switchMaMode: async () => {},
  maError: null as string | null,
};

async function renderHead(props?: Partial<typeof baseProps>): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <DashboardOverviewHead {...baseProps} {...props} />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

function findStatByLabel(container: HTMLElement, label: string): HTMLElement | null {
  const stats = container.querySelectorAll(".stat");
  for (const stat of stats) {
    if (stat.querySelector(".label")?.textContent?.trim() === label) return stat;
  }
  return null;
}

function getStatValue(container: HTMLElement, label: string): string | null {
  const stat = findStatByLabel(container, label);
  return stat?.querySelector(".value")?.textContent?.trim() ?? null;
}

function statHasAriaBusy(container: HTMLElement, label: string): boolean {
  const stat = findStatByLabel(container, label);
  return stat?.hasAttribute("aria-busy") ?? false;
}

// --- Port tests ---

test("DashboardOverviewHead: health.port present shows correct port number", async () => {
  const { root, container } = await renderHead({
    health: { status: "ok", version: "2.36.0", uptime: 100, port: 10100 },
  });
  expect(getStatValue(container, "Port")).toBe("10100");
  await act(async () => { root.unmount(); });
});

test("DashboardOverviewHead: health.port missing shows placeholder dash", async () => {
  const { root, container } = await renderHead({
    health: { status: "ok", version: "2.36.0", uptime: 100 },
  });
  expect(getStatValue(container, "Port")).toBe("—");
  await act(async () => { root.unmount(); });
});

test("DashboardOverviewHead: health null shows placeholder dash for port", async () => {
  const { root, container } = await renderHead({
    health: null,
  });
  expect(getStatValue(container, "Port")).toBe("—");
  await act(async () => { root.unmount(); });
});

test("DashboardOverviewHead: healthLoading sets aria-busy on port stat", async () => {
  const { root, container } = await renderHead({
    healthLoading: true,
    health: null,
  });
  expect(statHasAriaBusy(container, "Port")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("DashboardOverviewHead: healthLoaded removes aria-busy from port stat", async () => {
  const { root, container } = await renderHead({
    healthLoading: false,
    health: { status: "ok", version: "2.36.0", uptime: 100, port: 10100 },
  });
  expect(statHasAriaBusy(container, "Port")).toBe(false);
  await act(async () => { root.unmount(); });
});

// --- Provider status column tests ---

test("DashboardOverviewHead: shows correct provider count", async () => {
  const providers: ProviderInfo[] = [
    { name: "openai", adapter: "openai-responses", baseUrl: "https://api.openai.com", hasApiKey: true },
    { name: "anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", hasApiKey: true },
  ];
  const { root, container } = await renderHead({ providers });
  expect(getStatValue(container, "Providers")).toBe("2");
  await act(async () => { root.unmount(); });
});

test("DashboardOverviewHead: online status shows green dot and Online text", async () => {
  const { root, container } = await renderHead({
    health: { status: "ok", version: "2.36.0", uptime: 100, port: 10100 },
  });
  const statusStat = findStatByLabel(container, "Status")!;
  expect(statusStat).not.toBeNull();
  expect(statusStat.querySelector(".dot-green")).not.toBeNull();
  expect(statusStat.textContent).toContain("Online");
  await act(async () => { root.unmount(); });
});

test("DashboardOverviewHead: offline status shows red dot and Offline text", async () => {
  const { root, container } = await renderHead({
    health: { status: "error", version: "2.36.0", uptime: 100 },
  });
  const statusStat = findStatByLabel(container, "Status")!;
  expect(statusStat.querySelector(".dot-red")).not.toBeNull();
  expect(statusStat.textContent).toContain("Offline");
  await act(async () => { root.unmount(); });
});

test("DashboardOverviewHead: version shows health version", async () => {
  const { root, container } = await renderHead({
    health: { status: "ok", version: "2.36.0", uptime: 100, port: 10100 },
  });
  expect(getStatValue(container, "Version")).toBe("2.36.0");
  await act(async () => { root.unmount(); });
});

// --- Status text accessibility ---

test("DashboardOverviewHead: status text is self-describing (not color-only)", async () => {
  const { root, container } = await renderHead({
    health: { status: "ok", version: "2.36.0", uptime: 100, port: 10100 },
  });
  const statusStat = findStatByLabel(container, "Status")!;
  // The status value contains text "Online" — not relying solely on dot color
  expect(statusStat.querySelector(".value")?.textContent).toContain("Online");
  await act(async () => { root.unmount(); });
});
