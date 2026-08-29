import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { LanguageProvider } from "../src/i18n/provider";
import { DashboardProvidersSection } from "../src/pages/dashboard-providers-section";
import type { ProviderInfo } from "../src/pages/dashboard-shared";

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

function makeT(): (key: string, vars?: Record<string, unknown>) => string {
  const dict: Record<string, string> = {
    "dash.activeProviders": "Active Providers",
    "dash.noProviders": "No providers found. Run `ocx init` to get started.",
    "dash.col.name": "Name",
    "dash.col.adapter": "Adapter",
    "dash.col.baseUrl": "Base URL",
    "dash.col.model": "Model",
    "dash.col.status": "Status",
    "dash.providerStatus.ok": "Healthy",
    "dash.providerStatus.error": "Error",
    "dash.providerStatus.disabled": "Disabled",
    "dash.providerStatus.unknown": "Unknown",
    "dash.port": "Port",
  };
  return (key: string) => dict[key] ?? key;
}

async function renderSection(providers: ProviderInfo[]): Promise<{ container: HTMLElement; root: ReturnType<typeof import("react-dom/client").createRoot> }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: ReturnType<typeof import("react-dom/client").createRoot>;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <DashboardProvidersSection t={makeT()} providers={providers} />
      </LanguageProvider>,
    );
  });
  return { container, root };
}

const baseProvider: ProviderInfo = {
  name: "openai",
  adapter: "openai-responses",
  baseUrl: "https://api.openai.com",
  hasApiKey: true,
};

function getStatusChip(container: HTMLElement): HTMLElement | null {
  const row = container.querySelector("tbody tr");
  if (!row) return null;
  const cells = row.querySelectorAll("td");
  const lastCell = cells[cells.length - 1];
  return lastCell?.querySelector(".chip") ?? null;
}

function chipHasColor(chip: HTMLElement, color: string): boolean {
  return (chip.getAttribute("style") ?? "").includes(color);
}

test("DashboardProvidersSection: ok discovery shows Healthy in green", async () => {
  const { container, root } = await renderSection([
    { ...baseProvider, discovery: { status: "ok" } },
  ]);
  const chip = getStatusChip(container)!;
  expect(chip).not.toBeNull();
  expect(chip.textContent).toContain("Healthy");
  expect(chipHasColor(chip, "var(--green)")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("DashboardProvidersSection: failed discovery shows Error in red", async () => {
  const { container, root } = await renderSection([
    { ...baseProvider, discovery: { status: "failed", reason: "http", httpStatus: 401 } },
  ]);
  const chip = getStatusChip(container)!;
  expect(chip.textContent).toContain("Error");
  expect(chipHasColor(chip, "var(--red)")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("DashboardProvidersSection: disabled provider shows Disabled", async () => {
  const { container, root } = await renderSection([
    { ...baseProvider, disabled: true, discovery: { status: "ok" } },
  ]);
  const chip = getStatusChip(container)!;
  expect(chip.textContent).toContain("Disabled");
  expect(chipHasColor(chip, "var(--muted)")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("DashboardProvidersSection: no discovery data shows Unknown", async () => {
  const { container, root } = await renderSection([
    { ...baseProvider },
  ]);
  const chip = getStatusChip(container)!;
  expect(chip.textContent).toContain("Unknown");
  expect(chipHasColor(chip, "var(--muted)")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("DashboardProvidersSection: empty list shows empty state", async () => {
  const { container, root } = await renderSection([]);
  expect(container.textContent).toContain("No providers configured");
  expect(container.querySelector("table")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("DashboardProvidersSection: status column header is present", async () => {
  const { container, root } = await renderSection([baseProvider]);
  const ths = [...container.querySelectorAll("thead th")];
  const lastTh = ths[ths.length - 1];
  expect(lastTh?.textContent).toBe("Status");
  await act(async () => { root.unmount(); });
});
