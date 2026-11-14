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
  accountCountFromList,
  buildRouteRows,
  capabilityPatch,
  capabilitySource,
  combineLists,
  parseCapabilitySources,
  parseInferredCapabilities,
  parseProbeResponse,
  withInferredGaps,
  configuredMemberModels,
  withConfiguredMembers,
  dragSlot,
  memberRestorePatch,
  memberSettingsPatch,
  parseContextInput,
  comboContextWindow,
  parseCapabilitySettings,
  quotaFamilyWindow,
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
    expect(row!.quotas.find(line => line.provider === "anthropic")?.accounts).toEqual({ active: 3, paused: 0 });
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
      windows: [
        expect.objectContaining({ labelKey: "quota.weeklyLimit", remainingPercent: 51, tone: "ok" }),
        expect.objectContaining({ labelKey: "quota.fiveHourLimit", remainingPercent: 83, tone: "ok" }),
      ],
    });
    expect(quota["anthropic-apikey"]).toEqual({ kind: "metered" });
    expect(quota.zed).toEqual({ kind: "unknown" });
  });

  test("a channel whose only window is another family's pool shows unknown quota, not that pool", () => {
    const [row] = buildRouteRows({
      combos: [combo("opus", [["google-antigravity", "claude-opus-5-5"]])],
      catalog: {},
      lastResort: {},
      providers: [{ name: "google-antigravity", authMode: "oauth" }],
      quotaReports: [{
        provider: "google-antigravity",
        updatedAt: NOW,
        quota: { customWindows: [{ label: "Gem", percent: 10, resetAt: NOW + 3_600_000 }], updatedAt: NOW },
      }],
      now: NOW,
    });
    expect(row!.quotas[0]!.quota).toEqual({ kind: "unknown" });
  });

  test("a combo missing from the catalog falls back to its id and counts as on", () => {
    const [row] = buildRouteRows({ combos: [combo("x", [["a", "m"]])], catalog: {}, lastResort: {}, providers: [], quotaReports: undefined });
    expect([row!.displayName, row!.enabled, row!.contextWindow]).toEqual(["x", true, undefined]);
  });

  test("switched-off combos sort after the live ones and listed accounts fill in missing aggregates", () => {
    const rows = buildRouteRows({
      combos: [combo("a-off", [["p", "m"]]), combo("b-on", [["p", "m"]]), combo("c-on", [["p", "m"]])],
      catalog: { "a-off": { disabled: true }, "b-on": { disabled: false }, "c-on": { disabled: false } },
      lastResort: {},
      providers: [{ name: "p", authMode: "oauth" }],
      quotaReports: undefined,
      accountCounts: { p: { active: 7, paused: 1 } },
    });
    expect(rows.map(row => row.combo.id)).toEqual(["b-on", "c-on", "a-off"]);
    expect(rows[0]!.quotas[0]!.accounts).toEqual({ active: 7, paused: 1 });
    expect(accountCountFromList({ accounts: [{ id: "1" }, { id: "2", paused: true }, { id: "3" }] })).toEqual({ active: 2, paused: 1 });
    expect(accountCountFromList({ error: "unknown oauth provider" })).toBeNull();
  });

  test("Antigravity pool windows read as full family names", () => {
    expect(quotaFamilyWindow("Cla (Weekly)")).toEqual({ family: "Claude & GPT", weekly: true });
    expect(quotaFamilyWindow("Gem")).toEqual({ family: "Gemini", weekly: false });
    expect(quotaFamilyWindow("Argon (Weekly)")).toEqual({ family: "Gemini 4 Argon", weekly: true });
    expect(quotaFamilyWindow("First-party models")).toBeNull();
  });

  test("capability settings default when absent and only changed fields are sent", () => {
    expect(parseCapabilitySettings({})).toEqual({ capabilityPolicy: "intersection", onUnservable: "degrade" });
    const before = parseCapabilitySettings({ capabilityPolicy: "union" });
    expect(capabilityPatch(before, before)).toEqual({});
    expect(capabilityPatch(before, { ...before, onUnservable: "reject" })).toEqual({ onUnservable: "reject" });
  });

  test("context follows the policy: smallest member under intersection, largest under union", () => {
    const members = [{ contextWindow: 200_000 }, { contextWindow: 1_000_000 }, {}];
    // Intersection trusts the server's advertised number (it applies caps the member rows do not show).
    expect(comboContextWindow(members, "intersection", 128_000)).toEqual({ tokens: 128_000, basis: "min" });
    expect(comboContextWindow(members, "intersection", undefined)).toEqual({ tokens: 200_000, basis: "min" });
    expect(comboContextWindow(members, "union", 64_000)).toEqual({ tokens: 1_000_000, basis: "max" });
    expect(comboContextWindow([{}], "union", 64_000)).toEqual({ tokens: 64_000, basis: "catalog" });
    expect(combineLists([["text", "image"], ["text"], undefined], "intersection", ["text", "image"])).toEqual(["text"]);
    expect(combineLists([["high", "low"], ["medium"]], "union", ["low", "medium", "high"])).toEqual(["low", "medium", "high"]);
    expect(combineLists([undefined], "union")).toBeUndefined();
  });

  test("providers sharing a display name stay distinguishable in one row", () => {
    const labels = distinctProviderLabels(["anthropic", "zed", "anthropic-apikey"], provider => provider.startsWith("anthropic") ? "Anthropic Claude" : "Zed");
    expect([...labels.values()]).toEqual(["Anthropic Claude", "Zed", "Anthropic Claude (anthropic-apikey)"]);
  });

  test("strategy picks: save after validation, JEV opens the advanced editor, invalid never saves", () => {
    const item = combo("a", [["p", "m"]]);
    expect(planStrategyChange(item, "failover", () => null)).toEqual({ kind: "unchanged" });
    expect(planStrategyChange(item, "jev", () => null)).toEqual({ kind: "open-advanced" });
    expect(planStrategyChange(item, "random", () => "noEnabledTarget")).toEqual({ kind: "invalid", error: "noEnabledTarget", item: { ...item, strategy: "random" } });
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
    expect([formatContextWindow(1_000_000), formatContextWindow(1_048_576), formatContextWindow(1_500_000), formatContextWindow(128_000)]).toEqual(["1M", "1M", "1.5M", "128K"]);
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
let probeReply: "ok" | "baseline" | "busy" | "blocked" = "ok";
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
        if (url.endsWith("/api/providers/probe-capabilities")) {
          const sent = JSON.parse(String(init!.body)) as { confirmMetered?: boolean };
          if (probeReply === "busy") return Response.json({ error: "busy" }, { status: 409 });
          if (probeReply === "blocked") return Response.json({ applicable: false, reason: "unsupported_adapter", sent: false });
          if (!sent.confirmMetered) return Response.json({ applicable: true, sent: false, requiresConfirmation: true, metered: true, plannedRequests: 4 });
          if (probeReply === "baseline") {
            return Response.json({ applicable: true, sent: true, baseline: { status: "inconclusive" }, reasoning: { accepted: [], rejected: [], inconclusive: ["low"] }, applied: {} });
          }
          return Response.json({
            applicable: true, sent: true, baseline: { status: "accepted" }, image: { status: "accepted" },
            reasoning: { accepted: ["low", "high"], rejected: ["max"], inconclusive: [] },
            applied: { inputModalities: ["text", "image"], reasoningEfforts: ["low", "high"] },
          });
        }
        if (url.endsWith("/api/model-settings")) {
          const sent = JSON.parse(String(init!.body)) as { provider: string; modelId: string };
          return Response.json({ ok: true, provider: sent.provider, modelId: sent.modelId, changed: true, hasOverrides: true, saved: true, catalogRefresh: { status: "skipped" } });
        }
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
          { provider: "openai", id: "gpt-5", contextWindow: 400000, reasoningEfforts: ["low", "high"], reasoningOverridden: true },
          {
            provider: "anthropic", id: "claude",
            capabilitySources: { contextWindow: "unknown", inputModalities: "probed", reasoningEfforts: "unknown" },
            inputModalities: ["text"],
            inferredCapabilities: { contextWindow: { value: 1000000, basis: { source: "registry", provider: "anthropic", modelId: "claude" } } },
          },
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
  probeReply = "ok";
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
    expect(alphaRow.querySelector(".rb-mark")?.textContent).toBe("fallback only");
    // The page's combos set no cooldownWaitPolicy, so the mark is shown as not in effect.
    expect(alphaRow.querySelector(".rb-mark")?.classList.contains("rb-mark--inert")).toBe(true);
    expect(alphaRow.querySelector(".rb-quota")?.textContent).toContain("pay per use");
    expect(alphaRow.textContent).toContain("context 200K");
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
    expect(Object.hasOwn(body.combo, "capabilityPolicy")).toBe(false);
    expect(Object.hasOwn(body.combo, "onUnservable")).toBe(false);
    expect(Object.hasOwn(body.combo, "cooldownWaitPolicy")).toBe(false);
    expect(body.combo.targets).toEqual([
      { provider: "anthropic", model: "claude", lastResort: false },
      { provider: "openai", model: "gpt-5", modelProfile: "subscription first", lastResort: false },
    ]);
  });

  test("pointer drag: the row itself follows, the others slide aside, one commit on release", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-row-toggle")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    const list = editor.querySelector<HTMLElement>(".rb-channels")!;
    const names = () => [...editor.querySelectorAll(".rb-channel code")].map(node => node.textContent);
    const items = () => [...editor.querySelectorAll<HTMLElement>(".rb-channel")];
    // Rows 40px tall at 0 and 40 in a list at 0 (happy-dom has no layout).
    items().forEach((item, index) => {
      Object.defineProperty(item, "offsetTop", { configurable: true, value: index * 40 });
      Object.defineProperty(item, "offsetHeight", { configurable: true, value: 40 });
      item.getBoundingClientRect = () => ({ top: index * 40, height: 40, bottom: index * 40 + 40, left: 0, right: 0, width: 0, x: 0, y: index * 40, toJSON: () => ({}) }) as DOMRect;
    });
    const pointer = (target: EventTarget, type: string, clientY: number) => {
      const event = new testWindow.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
      Object.defineProperties(event, { clientY: { value: clientY }, clientX: { value: 0 }, pointerId: { value: 1 }, button: { value: 0 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      target.dispatchEvent(event);
    };
    const first = items()[0]!;
    await act(async () => { pointer(first, "pointerdown", 20); });
    await act(async () => { pointer(document, "pointermove", 30); });
    expect(list.classList.contains("sorting")).toBe(true);
    expect(first.classList.contains("dragging")).toBe(true);
    expect(editor.querySelectorAll(".rb-channel").length).toBe(2); // no copy of the dragged row
    expect(names()).toEqual(["gpt-5", "claude"]); // nothing reorders before the release
    await new Promise(resolve => setTimeout(resolve, 400)); // past the tap window
    await act(async () => { pointer(document, "pointerup", 75); });
    expect(names()).toEqual(["claude", "gpt-5"]);
    expect(list.classList.contains("sorting")).toBe(false);
    expect(items().every(item => item.style.transform === "")).toBe(true);
    expect(editor.textContent).toContain("Unsaved");
  });

  test("pointer drag: a press on a row's button stays a click, and Escape cancels a drag", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-row-toggle")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    const list = editor.querySelector<HTMLElement>(".rb-channels")!;
    const names = () => [...editor.querySelectorAll(".rb-channel code")].map(node => node.textContent);
    const pointer = (target: EventTarget, type: string, clientY: number) => {
      const event = new testWindow.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
      Object.defineProperties(event, { clientY: { value: clientY }, clientX: { value: 0 }, pointerId: { value: 1 }, button: { value: 0 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      target.dispatchEvent(event);
    };
    await act(async () => { pointer(editor.querySelector(".rb-remove")!, "pointerdown", 20); });
    await act(async () => { pointer(document, "pointermove", 60); });
    expect(list.classList.contains("sorting")).toBe(false);
    await act(async () => { pointer(document, "pointerup", 60); });
    await act(async () => { pointer(editor.querySelector(".rb-channel")!, "pointerdown", 20); });
    await act(async () => { pointer(document, "pointermove", 60); });
    expect(list.classList.contains("sorting")).toBe(true);
    await act(async () => { document.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
    expect(list.classList.contains("sorting")).toBe(false);
    await act(async () => { pointer(document, "pointerup", 75); });
    expect(names()).toEqual(["gpt-5", "claude"]);
  });

  test("member table: source tags per cell, and an in-place edit writes the provider's model settings", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-tag--button")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    const gpt = [...editor.querySelectorAll<HTMLElement>(".rb-members tbody tr")].find(tr => tr.textContent?.includes("gpt-5"))!;
    expect([...gpt.querySelectorAll(".rb-src")].map(tag => tag.textContent)).toEqual(["provider report", "unknown", "manual"]);
    expect(gpt.textContent).not.toContain("unknown unknown");
    await act(async () => { button(gpt, "Edit what OpenAI (Codex login) gpt-5 can take").click(); });
    const form = editor.querySelector<HTMLElement>(".rb-member-edit")!;
    expect(form.textContent).toContain("every combo that uses this model changes too");
    const input = form.querySelector<HTMLInputElement>("input")!;
    const setValue = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "nonsense");
      input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => { button(form, "Save").click(); });
    expect(form.querySelector("[role=alert]")?.textContent).toContain("200K");
    expect(calls).toEqual([]);
    await act(async () => {
      setValue.call(input, "1M");
      input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => { button(form, "images").click(); });
    await act(async () => { button(form, "Save").click(); });
    await flush();
    expect(calls).toEqual([{ url: "/api/model-settings", method: "PUT", body: { provider: "openai", modelId: "gpt-5", contextWindow: 1000000, inputModalities: ["image"] } }]);
    expect(editor.querySelector(".rb-member-edit")).toBeNull();
  });

  test("a gap with a same-name estimate shows it, and Adopt saves it as a manual setting", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-tag--button")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    const claude = [...editor.querySelectorAll<HTMLElement>(".rb-members tbody tr")].find(tr => tr.textContent?.includes("claude"))!;
    expect(claude.textContent).toContain("inferred 1M (based on anthropic built-in table)");
    expect(claude.textContent).toContain("probed");
    expect(editor.querySelector(".rb-members tfoot")?.textContent).toContain("includes inferred");
    await act(async () => { claude.querySelector<HTMLButtonElement>(".rb-adopt")!.click(); });
    await flush();
    expect(calls).toEqual([{ url: "/api/model-settings", method: "PUT", body: { provider: "anthropic", modelId: "claude", contextWindow: 1000000 } }]);
  });

  test("Test it asks before a metered probe, then repeats with consent and lists the results", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-tag--button")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    const gpt = () => [...editor.querySelectorAll<HTMLElement>(".rb-members tbody tr")].find(tr => tr.querySelector("th")?.textContent?.includes("gpt-5"))!;
    await act(async () => { button(gpt(), "Test what OpenAI (Codex login) gpt-5 accepts").click(); });
    await flush();
    const dialog = editor.querySelector<HTMLElement>("[role=alertdialog]")!;
    expect(dialog.textContent).toContain("sends 4 very small requests");
    expect(editor.textContent).not.toContain("Context is inferred from the model name, not measured.");
    await act(async () => { button(dialog, "Run the test").click(); });
    await flush();
    expect(calls.map(call => call.body)).toEqual([
      { name: "openai", model: "gpt-5", apply: true },
      { name: "openai", model: "gpt-5", apply: true, confirmMetered: true },
    ]);
    const results = editor.querySelector(".rb-probe")!.textContent!;
    expect(results).toContain("Images: accepted");
    expect(results).toContain("accepted: low · high; refused: max");
    expect(results).toContain("saved effort levels: low · high");
    expect(results).toContain("Context is inferred from the model name, not measured.");
  });

  test("Test it: a failed baseline changes nothing, a busy provider says so, an inapplicable one greys the button", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-tag--button")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    const gpt = () => [...editor.querySelectorAll<HTMLElement>(".rb-members tbody tr")].find(tr => tr.querySelector("th")?.textContent?.includes("gpt-5"))!;
    const test = () => button(gpt(), "Test what OpenAI (Codex login) gpt-5 accepts");
    probeReply = "baseline";
    await act(async () => { test().click(); });
    await flush();
    await act(async () => { button(editor.querySelector("[role=alertdialog]")!, "Run the test").click(); });
    await flush();
    expect(editor.querySelector(".rb-probe")!.textContent).toContain("Inconclusive");
    probeReply = "busy";
    await act(async () => { test().click(); });
    await flush();
    expect(editor.querySelector(".rb-probe")!.textContent).toContain("already being tested");
    probeReply = "blocked";
    await act(async () => { test().click(); });
    await flush();
    expect(editor.querySelector(".rb-probe")!.textContent).toContain("only OpenAI-compatible endpoints");
    expect(test().disabled).toBe(true);
  });

  test("restoring a member sends null only for the fields set by hand", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-tag--button")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    const gpt = [...editor.querySelectorAll<HTMLElement>(".rb-members tbody tr")].find(tr => tr.textContent?.includes("gpt-5"))!;
    await act(async () => { button(gpt, "Edit what OpenAI (Codex login) gpt-5 can take").click(); });
    await act(async () => { button(editor.querySelector(".rb-member-edit")!, "Use the provider's values").click(); });
    await flush();
    expect(calls[0]!.body).toEqual({ provider: "openai", modelId: "gpt-5", reasoningEfforts: null });
  });

  test("the context tag opens More settings in place, with the members' numbers", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-tag--button")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    expect(editor.querySelector(".rb-more-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(editor.querySelector(".rb-members")).not.toBeNull();
    expect(window.location.hash).toBe("#models/combos");
  });

  test("the context tag keeps an open editor's unsaved order, and the combined context follows the draft", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-row-toggle")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    await act(async () => { editor.querySelector<HTMLButtonElement>('button[aria-label$="gpt-5 down"]')!.click(); });
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-tag--button")!.click(); });
    const open = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    expect(open).toBe(editor);
    expect(open.querySelector(".rb-more-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect([...open.querySelectorAll(".rb-channel code")].map(code => code.textContent)).toEqual(["claude", "gpt-5"]);
    expect(open.querySelector(".rb-members tfoot td")?.textContent).not.toContain("200K");
  });

  test("the fallback-only switch writes cooldownWaitPolicy", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-row-toggle")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    await act(async () => { editor.querySelector<HTMLButtonElement>(".rb-more-toggle")!.click(); });
    await act(async () => { editor.querySelector<HTMLButtonElement>('[role=switch][aria-label="Fallback channels wait their turn"]')!.click(); });
    await act(async () => { button(editor, "Save").click(); });
    await flush();
    expect((calls[0]!.body as { combo: Record<string, unknown> }).combo.cooldownWaitPolicy).toBe("before-last-resort");
  });

  test("capability policy: union reveals the unservable choice and only changed fields are sent", async () => {
    await renderPage();
    await act(async () => { row("alpha").querySelector<HTMLButtonElement>(".rb-row-toggle")!.click(); });
    const editor = row("alpha").querySelector<HTMLElement>(".rb-editor")!;
    await act(async () => { editor.querySelector<HTMLButtonElement>(".rb-more-toggle")!.click(); });
    expect(editor.querySelector('[role=combobox][aria-label="When no channel can serve it"]')).toBeNull();
    await chooseOption(editor.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Capabilities"]')!, "union");
    await chooseOption(editor.querySelector<HTMLButtonElement>('[role=combobox][aria-label="When no channel can serve it"]')!, "reject");
    await act(async () => { button(editor, "Save").click(); });
    await flush();
    const body = calls[0]!.body as { combo: Record<string, unknown> };
    expect([body.combo.capabilityPolicy, body.combo.onUnservable]).toEqual(["union", "reject"]);
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

describe("drag slot", () => {
  const mids = (count: number) => Array.from({ length: count }, (_, index) => index * 40 + 20);
  /** Runs a pointer path and returns every slot change, like dragover events would. */
  const sweep = (count: number, from: number, path: number[]) => {
    const start = mids(count);
    let slot = from;
    const changes: number[] = [];
    for (const y of path) {
      const next = dragSlot(start, from, y, slot);
      if (next !== slot) { changes.push(next); slot = next; }
    }
    return { slot, changes };
  };
  const range = (from: number, to: number, step: number) => {
    const out: number[] = [];
    for (let y = from; step > 0 ? y <= to : y >= to; y += step) out.push(y);
    return out;
  };

  for (const count of [4, 6]) {
    test(`${count} rows: a slow drag to the last place passes each slot once`, () => {
      const result = sweep(count, 0, range(20, count * 40, 1));
      expect(result.slot).toBe(count - 1);
      expect(result.changes).toEqual(Array.from({ length: count - 1 }, (_, index) => index + 1));
    });
    test(`${count} rows: a slow drag back to the first place passes each slot once`, () => {
      const result = sweep(count, count - 1, range(count * 40 - 20, 0, -1));
      expect(result.slot).toBe(0);
      expect(result.changes).toEqual(Array.from({ length: count - 1 }, (_, index) => count - 2 - index));
    });
    test(`${count} rows: a fast drag lands on the first and the last place`, () => {
      expect(sweep(count, count - 1, [count * 40 - 20, -10]).slot).toBe(0);
      expect(sweep(count, 0, [20, count * 40 + 30]).slot).toBe(count - 1);
    });
    test(`${count} rows: a pointer jittering on a boundary changes the slot at most once`, () => {
      const boundary = mids(count)[2]!;
      const jitter = Array.from({ length: 40 }, (_, index) => boundary + (index % 2 === 0 ? 3 : -3));
      expect(sweep(count, 0, [20, boundary - 10, ...jitter]).changes.length).toBeLessThanOrEqual(2);
    });
  }

  test("moving back past the start returns the row to its own place", () => {
    expect(sweep(4, 1, [60, 140, 60]).slot).toBe(1);
  });
});

describe("member capability edits", () => {
  test("context input accepts plain numbers and K/M suffixes", () => {
    expect(parseContextInput("200000")).toBe(200000);
    expect(parseContextInput("200K")).toBe(200000);
    expect(parseContextInput("1m")).toBe(1000000);
    expect(parseContextInput("1.5M")).toBe(1500000);
    expect(parseContextInput("1,000,000")).toBe(1000000);
    expect(parseContextInput("big")).toBeUndefined();
    expect(parseContextInput("0")).toBeUndefined();
  });

  test("only changed fields are patched; unknown lists left empty stay unknown", () => {
    const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    expect(memberSettingsPatch({ contextWindow: 200000 }, { context: "200K", input: [], efforts: [] }, order)).toEqual({ patch: {} });
    expect(memberSettingsPatch({ reasoningEfforts: ["high"] }, { context: "", input: ["text"], efforts: ["high", "low"] }, order))
      .toEqual({ patch: { inputModalities: ["text"], reasoningEfforts: ["low", "high"] } });
    expect(memberSettingsPatch({}, { context: "lots", input: [], efforts: [] }, order).invalid).toBe("context");
  });

  test("a member with no catalog row still shows its per-model config, tagged manual", () => {
    expect(configuredMemberModels({
      zed: { modelContextWindows: { m: 400000 }, modelCapabilities: { m: { inputModalities: ["text"] } } },
      other: { modelReasoningEfforts: { n: ["low"] } },
    })).toEqual([
      { provider: "zed", id: "m", contextWindow: 400000, inputModalities: ["text"], sources: { context: "manual", input: "manual", efforts: "unknown" } },
      { provider: "other", id: "n", reasoningEfforts: ["low"], sources: { context: "unknown", input: "unknown", efforts: "manual" } },
    ]);
  });

  test("a default-model placeholder keeps its configured values; a catalog row keeps its own", () => {
    const options = [{ provider: "zed", id: "listed", contextWindow: 100000 }, { provider: "zed", id: "default" }];
    const configured = [
      { provider: "zed", id: "listed", contextWindow: 1 },
      { provider: "zed", id: "default", contextWindow: 400000, sources: { context: "manual" as const, input: "unknown" as const, efforts: "unknown" as const } },
      { provider: "zed", id: "other", contextWindow: 8000 },
    ];
    expect(withConfiguredMembers(options, new Set([channelKey("zed", "listed")]), configured)).toEqual([
      { provider: "zed", id: "listed", contextWindow: 100000 },
      { provider: "zed", id: "default", contextWindow: 400000, sources: { context: "manual", input: "unknown", efforts: "unknown" } },
      { provider: "zed", id: "other", contextWindow: 8000 },
    ]);
  });

  test("sources: manual wins, an explicit inferred source next, else the provider's report", () => {
    expect(capabilitySource(true, true, "inferred")).toBe("manual");
    expect(capabilitySource(true, false, "inferred")).toBe("inferred");
    expect(capabilitySource(true, false)).toBe("reported");
    expect(capabilitySource(false, false)).toBe("unknown");
    expect(memberRestorePatch({ context: "manual", input: "reported", efforts: "manual" })).toEqual({ contextWindow: null, reasoningEfforts: null });
  });
});

describe("capability sources, estimates and probe replies", () => {
  test("sources come from the server's per-axis labels; junk reads as unknown", () => {
    expect(parseCapabilitySources({ contextWindow: "probed", inputModalities: "inferred", reasoningEfforts: "nonsense" }))
      .toEqual({ context: "probed", input: "inferred", efforts: "unknown" });
    expect(parseCapabilitySources(undefined)).toBeUndefined();
  });

  test("estimates keep only well-formed axes, and fill gaps only in the combined row", () => {
    const inferred = parseInferredCapabilities({
      contextWindow: { value: 1000000, basis: { source: "registry", provider: "anthropic", modelId: "m" } },
      inputModalities: { value: [], basis: { source: "vendor", provider: "x", modelId: "m" } },
      reasoningEfforts: { value: ["low"], basis: { source: "nowhere", provider: "x", modelId: "m" } },
    });
    expect(inferred).toEqual({ context: { value: 1000000, basis: { source: "registry", provider: "anthropic", modelId: "m" } } });
    expect(withInferredGaps([{ contextWindow: 200000, inferred }, { inferred }])).toEqual({
      members: [{ contextWindow: 200000, inferred }, { contextWindow: 1000000, inferred }],
      used: true,
    });
    expect(withInferredGaps([{ contextWindow: 200000 }]).used).toBe(false);
  });

  test("probe replies map to confirm, inapplicable, busy, done and failed", () => {
    expect(parseProbeResponse(200, { requiresConfirmation: true, plannedRequests: 5 })).toEqual({ kind: "confirm", planned: 5 });
    expect(parseProbeResponse(200, { applicable: false, reason: "oauth_auth" })).toEqual({ kind: "inapplicable", reason: "oauth_auth" });
    expect(parseProbeResponse(409, { error: "busy" })).toEqual({ kind: "busy" });
    expect(parseProbeResponse(500, { error: "x" })).toEqual({ kind: "failed" });
    expect(parseProbeResponse(200, { sent: true, baseline: { status: "inconclusive" } })).toMatchObject({ kind: "done", baselineOk: false });
  });

  test("restore clears probed declarations too", () => {
    expect(memberRestorePatch({ context: "reported", input: "probed", efforts: "manual" })).toEqual({ inputModalities: null, reasoningEfforts: null });
  });
});
