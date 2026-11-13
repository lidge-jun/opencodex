import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { resolveAppHashChange } from "../src/app-routing";
import { toPutBody, type ComboItem } from "../src/combo-workspace-data";
import { LanguageProvider } from "../src/i18n/provider";
import Combos from "../src/pages/Combos";
import { readCombosView } from "../src/pages/combos-view";
import { readModelsTab } from "../src/pages/models-tab";
import {
  buildRouteRows,
  channelKey,
  channelTargetsForPut,
  distinctProviderLabels,
  formatContextWindow,
  moveChannel,
  planStrategyChange,
  quotaTone,
} from "../src/route-board-model";
import { chooseOption } from "./helpers/custom-select";

const combo = (id: string, targets: Array<[string, string]>, extra: Partial<ComboItem> = {}): ComboItem => ({
  id,
  model: `combo/${id}`,
  alias: null,
  nativeAlias: false,
  displayName: null,
  strategy: "failover",
  stickyLimit: 1,
  defaultEffort: null,
  imageInput: "auto",
  reasoningEffortMode: "strict",
  targets: targets.map(([provider, model]) => ({ provider, model })),
  ...extra,
});

const NOW = 1_800_000_000_000;

describe("route board model", () => {
  test("quota colour follows the remaining-percent thresholds", () => {
    expect([quotaTone(51), quotaTone(50), quotaTone(20), quotaTone(19.9)]).toEqual(["ok", "warn", "warn", "low"]);
  });

  test("rows carry channel order, per-provider quota, last resort, catalog name, context and on/off", () => {
    const [row] = buildRouteRows({
      combos: [combo("opus", [["google-antigravity", "claude-opus-5-5"], ["anthropic", "claude-opus-5-5"], ["anthropic-apikey", "claude-opus-5-5"], ["zed", "claude-opus-5-5"]])],
      catalog: { opus: { displayName: "Claude Opus 5.5", contextWindow: 200_000, disabled: true } },
      lastResort: { opus: [channelKey("zed", "claude-opus-5-5")] },
      providers: [
        { name: "google-antigravity", authMode: "oauth" },
        { name: "anthropic", authMode: "oauth" },
        { name: "anthropic-apikey", authMode: "key" },
        { name: "zed", authMode: "oauth", disabled: true },
      ],
      quotaReports: [
        {
          provider: "google-antigravity",
          updatedAt: NOW,
          quota: {
            customWindows: [
              { label: "Gem", percent: 10, resetAt: NOW + 3_600_000 },
              { label: "Cla (Weekly)", percent: 72, resetAt: NOW + 86_400_000 },
              { label: "Cla", percent: 85, resetAt: NOW + 3_600_000 },
            ],
            updatedAt: NOW,
          },
        },
        {
          provider: "anthropic",
          updatedAt: NOW,
          quota: { fiveHourPercent: 17, weeklyPercent: 49, updatedAt: NOW },
          aggregation: { includedAccounts: 2, excludedAccounts: 1 },
        },
      ],
      now: NOW,
    });
    expect(row!.displayName).toBe("Claude Opus 5.5");
    expect(row!.publicId).toBe("combo/opus");
    expect(row!.contextWindow).toBe(200_000);
    expect(row!.enabled).toBe(false);
    expect(row!.channels.map(channel => [channel.provider, channel.lastResort, channel.providerDisabled])).toEqual([
      ["google-antigravity", false, false],
      ["anthropic", false, false],
      ["anthropic-apikey", false, false],
      ["zed", true, true],
    ]);
    const quota = Object.fromEntries(row!.quotas.map(line => [line.provider, line.quota]));
    // A Claude channel shows the Claude windows, never Antigravity's Gemini window.
    expect(quota["google-antigravity"]).toEqual({
      kind: "windows",
      windows: [
        expect.objectContaining({ label: "Cla (Weekly)", remainingPercent: 28, tone: "warn" }),
        expect.objectContaining({ label: "Cla", remainingPercent: 15, tone: "low" }),
      ],
    });
    expect(quota.anthropic).toEqual({
      kind: "windows",
      accounts: 3,
      windows: [
        expect.objectContaining({ labelKey: "quota.weeklyLimit", remainingPercent: 51, tone: "ok" }),
        expect.objectContaining({ labelKey: "quota.fiveHourLimit", remainingPercent: 83, tone: "ok" }),
      ],
    });
    expect(quota["anthropic-apikey"]).toEqual({ kind: "metered" });
    expect(quota.zed).toEqual({ kind: "unknown" });
  });

  test("a combo missing from the catalog falls back to its id and counts as on", () => {
    const [row] = buildRouteRows({ combos: [combo("x", [["a", "m"]])], catalog: {}, lastResort: {}, providers: [], quotaReports: undefined });
    expect([row!.displayName, row!.enabled, row!.contextWindow]).toEqual(["x", true, undefined]);
  });

  test("providers sharing a display name stay distinguishable in one row", () => {
    const labels = distinctProviderLabels(["anthropic", "zed", "anthropic-apikey"], provider => provider.startsWith("anthropic") ? "Anthropic Claude" : "Zed");
    expect([...labels.values()]).toEqual(["Anthropic Claude", "Zed", "Anthropic Claude (anthropic-apikey)"]);
  });

  test("strategy picks: save after validation, JEV opens the advanced editor, invalid never saves", () => {
    const item = combo("a", [["p", "m"]]);
    expect(planStrategyChange(item, "failover", () => null)).toEqual({ kind: "unchanged" });
    expect(planStrategyChange(item, "jev", () => null)).toEqual({ kind: "open-advanced" });
    expect(planStrategyChange(item, "random", () => "noEnabledTarget")).toEqual({ kind: "invalid", error: "noEnabledTarget" });
    expect(planStrategyChange(item, "random", () => null)).toEqual({ kind: "save", item: { ...item, strategy: "random" } });
  });

  test("channel moves stay in range and the PUT carries lastResort explicitly", () => {
    expect(moveChannel(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveChannel(["a", "b"], 1, 2)).toEqual(["a", "b"]);
    expect(channelTargetsForPut(
      [{ provider: "p", model: "1", weight: 2 }, { provider: "q", model: "2" }],
      [{ provider: "q", model: "2", lastResort: true }, { provider: "p", model: "1", lastResort: false }],
    )).toEqual([{ provider: "p", model: "1", weight: 2, lastResort: false }, { provider: "q", model: "2", lastResort: true }]);
  });

  test("context windows read as tokens", () => {
    expect([formatContextWindow(1_000_000), formatContextWindow(1_500_000), formatContextWindow(128_000)]).toEqual(["1M", "1.5M", "128K"]);
  });
});

describe("combos view routing", () => {
  test("the overview is the default and the workspace lives at models/combos/advanced", () => {
    expect(readCombosView("#models/combos")).toBe("overview");
    expect(readCombosView("#combos")).toBe("overview");
    expect(readCombosView("#models/combos/advanced")).toBe("advanced");
    expect(readModelsTab("#models/combos/advanced")).toBe("combos");
    expect(resolveAppHashChange("models/combos/advanced")).toEqual({ page: "models", replaceTo: null });
  });

  test("the JEV Auto deep link still opens the workspace and keeps its query", () => {
    expect(readCombosView("#models/combos/jev-auto?decisionProvider=local")).toBe("advanced");
    expect(resolveAppHashChange("models/combos/jev-auto?decisionProvider=local")).toEqual({ page: "models", replaceTo: null });
  });
});

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let testWindow: Window;
let root: Root | null;
let host: HTMLElement;

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let combosPayload: unknown;

const alpha = combo("alpha", [["openai", "gpt-5"], ["anthropic", "claude"]]);
const offOnly = combo("offline", [["dead", "m"]]);

function installFetch() {
  calls = [];
  combosPayload = {
    combos: [
      {
        ...toPutBody(alpha).combo,
        id: "alpha",
        model: "combo/alpha",
        displayName: "Alpha",
        targets: [{ provider: "openai", model: "gpt-5", modelProfile: "subscription first" }, { provider: "anthropic", model: "claude", lastResort: true }],
      },
      { ...toPutBody(offOnly).combo, id: "offline", model: "combo/offline" },
    ],
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json(url.endsWith("/api/combos") ? { success: true } : { ok: true });
      }
      if (url.endsWith("/api/combos")) return Response.json(combosPayload);
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: {
            openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" },
            anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key" },
            dead: { adapter: "openai-chat", baseUrl: "https://example.invalid", disabled: true },
          },
        });
      }
      if (url.endsWith("/api/models")) {
        return Response.json([
          { provider: "openai", id: "gpt-5" },
          { provider: "anthropic", id: "claude" },
          { provider: "dead", id: "m" },
          { provider: "combo", id: "alpha", displayName: "Alpha", displayNameSource: "provider", contextWindow: 200000, disabled: false },
          { provider: "combo", id: "offline", disabled: false },
        ]);
      }
      if (url.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
      if (url.endsWith("/api/sidecar-settings")) return Response.json({});
      throw new Error(`unexpected request: ${url}`);
    },
  });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#models/combos" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function renderPage() {
  const { createRoot } = await import("react-dom/client");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<LanguageProvider><Combos apiBase="" /></LanguageProvider>); });
  await flush();
}

function row(id: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>(".rb-row")].find(item => item.querySelector("code")?.textContent === `combo/${id}`);
  if (!found) throw new Error(`row not found: ${id}`);
  return found;
}

function strategyTrigger(id: string): HTMLButtonElement {
  return row(id).querySelector<HTMLButtonElement>(`[role=combobox][aria-label="Strategy for combo/${id}"]`)!;
}

function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent?.trim() === name || item.getAttribute("aria-label") === name);
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

describe("Combos overview page", () => {
  test("opens on the overview: one row per combo with order, last resort, metered quota and context", async () => {
    await renderPage();
    expect(host.querySelector(".combos-workspace-root")).toBeNull();
    const alphaRow = row("alpha");
    expect(alphaRow.querySelector("strong")?.textContent).toBe("Alpha");
    expect(alphaRow.querySelector(".rb-order")?.textContent).toContain("→");
    expect(alphaRow.querySelector(".rb-mark")?.textContent).toBe("last resort");
    expect(alphaRow.querySelector(".rb-quota")?.textContent).toContain("pay per use");
    expect(alphaRow.textContent).toContain("ctx 200K");
  });

  test("picking a strategy saves the normal PUT body and leaves lastResort to the server", async () => {
    await renderPage();
    await chooseOption(strategyTrigger("alpha"), "round-robin");
    await flush();
    const saved = { ...alpha, displayName: "Alpha", targets: [{ provider: "openai", model: "gpt-5", modelProfile: "subscription first" }, { provider: "anthropic", model: "claude" }] };
    expect(calls).toEqual([{ url: "/api/combos", method: "PUT", body: toPutBody({ ...saved, strategy: "round-robin" }) }]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("lastResort");
  });

  test("picking JEV saves nothing and opens the advanced editor on that combo", async () => {
    await renderPage();
    await chooseOption(strategyTrigger("alpha"), "jev");
    await flush();
    expect(calls).toEqual([]);
    expect(window.location.hash).toBe("#models/combos/advanced");
    const workspace = host.querySelector<HTMLElement>(".rb-advanced");
    expect(workspace?.hidden).toBe(false);
    expect(host.querySelector(".combos-workspace-detail-title")?.textContent).toBe("combo/alpha");
  });

  test("a strategy that fails validation sends nothing and says why in the row", async () => {
    await renderPage();
    await chooseOption(strategyTrigger("offline"), "random");
    await flush();
    expect(calls).toEqual([]);
    expect(row("offline").querySelector("[role=alert]")?.textContent).toContain("Not saved");
  });

  test("the switch writes the combo's model-visibility selector", async () => {
    await renderPage();
    await act(async () => { button(row("alpha"), "List combo/alpha to clients").click(); });
    await flush();
    expect(calls).toEqual([{
      url: "/api/model-visibility",
      method: "PUT",
      body: { scope: "models", provider: "combo", targets: [{ id: "alpha" }], enabled: false },
    }]);
  });

  test("the channel editor reorders, marks last resort and saves explicit flags", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-row-toggle")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    await act(async () => { editor.querySelector<HTMLButtonElement>('button[aria-label$="gpt-5 down"]')!.click(); });
    const lastResortButtons = editor.querySelectorAll<HTMLButtonElement>(".rb-last-resort");
    await act(async () => { lastResortButtons[0]!.click(); });
    expect(editor.textContent).toContain("Unsaved");
    await act(async () => { button(editor, "Save").click(); });
    await flush();
    const body = calls[0]!.body as ReturnType<typeof toPutBody>;
    expect(body.combo.displayName).toBe("Alpha");
    expect(body.combo.targets).toEqual([
      { provider: "anthropic", model: "claude", lastResort: false },
      { provider: "openai", model: "gpt-5", modelProfile: "subscription first", lastResort: false },
    ]);
  });

  test("an unsaved advanced draft survives the overview, locks its own row, and outlives a refresh", async () => {
    window.location.hash = "#models/combos/advanced";
    await renderPage();
    const railRow = [...host.querySelectorAll<HTMLButtonElement>(".combos-workspace-rail-row")]
      .find(item => item.querySelector(".combos-workspace-rail-name")?.textContent === "combo/alpha")!;
    await act(async () => { railRow.click(); });
    await flush();
    const alias = host.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(alias, "draft-alias");
      alias.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });

    await act(async () => { button(host, "Back to overview").click(); });
    await flush();
    expect(host.querySelector<HTMLElement>(".rb-advanced")?.hidden).toBe(true);
    expect(strategyTrigger("alpha").disabled).toBe(true);
    expect(row("alpha").textContent).toContain("unsaved in Advanced");
    expect(strategyTrigger("offline").disabled).toBe(false);
    await act(async () => { button(row("alpha"), "List combo/alpha to clients").click(); });
    await flush();
    expect(calls.map(call => call.url)).toEqual(["/api/model-visibility"]);

    await act(async () => { button(host, "Advanced").click(); });
    await flush();
    expect(host.querySelector<HTMLInputElement>("#cwi-edit-alias")?.value).toBe("draft-alias");
  });
});
