import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Guardrails from "../src/pages/Guardrails";
import type {
  GuardrailsActivity,
  GuardrailsImportPreview,
  GuardrailsOverview,
  GuardrailsRules,
  GuardrailsSettingsPatch,
  GuardrailsSettings,
} from "../src/pages/guardrails/types";

const API_BASE = "http://guardrails.workspace.test";
const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "HTMLElement",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let host: HTMLDivElement;
let overview: GuardrailsOverview;
let activity: GuardrailsActivity;
let failOverview = false;
let failSettings = false;
let failActivity = false;
let emptyRules = false;
let holdOverview = false;
let holdActivity = false;
let importConflict = false;
let failExport = false;
let releaseOverview: (() => void) | null = null;
let releaseActivity: (() => void) | null = null;
const mutations: Array<{ body: unknown; ifMatch: string | null }> = [];
const activityRequests: string[] = [];
const importRequests: Array<{ body: Record<string, unknown>; ifMatch: string | null }> = [];
let overviewRequests = 0;
let rulesRequests = 0;
let exportRequests = 0;

const telemetry = {
  counters: {
    scanned: 1,
    masked: 1,
    detected: 0,
    blocked: 0,
    passthrough: 0,
    demaskWarning: 0,
    toolArgumentRestoreSkipped: 0,
  },
  topRules: [{ id: "rule-one", count: 1 }],
  topCategories: [{ id: 1 as const, count: 1 }],
  recentEvents: [{
    id: 1,
    timestamp: 1_700_000_000_000,
    surface: "responses" as const,
    mode: "enforce" as const,
    result: "masked" as const,
    registryGeneration: 1,
    count: 1,
    categoryIds: [1 as const],
    ruleIds: ["rule-one"],
    latencyMs: 1,
    severity: "info" as const,
  }],
  retention: {
    kind: "in-memory" as const,
    ttlMs: 3_600_000,
    maxEvents: 1_000,
    maxBytes: 2_097_152,
    currentEvents: 1,
    currentBytes: 256,
    evictedEvents: 0,
    oldestAt: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
  },
};

const unchangedSecurityDiff: GuardrailsImportPreview["securityDiff"] = {
  weakensProtection: false,
  requiresReview: false,
  enabled: { before: true, after: true, changed: false, weakening: false },
  mode: { before: "enforce", after: "enforce", changed: false, weakening: false },
  failurePolicy: { before: "block", after: "block", changed: false, weakening: false },
  providerScope: {
    before: { mode: "all" },
    after: { mode: "all" },
    addedProviderIds: [],
    removedProviderIds: [],
    changed: false,
    weakening: false,
  },
  enabledDataTypes: {
    before: [1, 2, 3, 4, 5, 6],
    after: [1, 2, 3, 4, 5, 6],
    added: [],
    removed: [],
    changed: false,
    weakening: false,
  },
  disabledBuiltinRules: {
    beforeCount: 0,
    afterCount: 0,
    newlyDisabledCount: 0,
    reenabledCount: 0,
    changed: false,
    weakening: false,
  },
  customRules: {
    beforeCount: 0,
    afterCount: 0,
    addedCount: 0,
    removedCount: 0,
    changedDefinitionCount: 0,
    changed: false,
    weakening: false,
    requiresReview: false,
  },
  keywordPrefilterEnabled: {
    before: false,
    after: false,
    changed: false,
    weakening: false,
  },
};

const weakeningSecurityDiff: GuardrailsImportPreview["securityDiff"] = {
  ...structuredClone(unchangedSecurityDiff),
  weakensProtection: true,
  requiresReview: true,
  enabled: { before: true, after: false, changed: true, weakening: true },
  mode: { before: "enforce", after: "detect", changed: true, weakening: true },
  failurePolicy: {
    before: "block",
    after: "passthrough",
    changed: true,
    weakening: true,
  },
  enabledDataTypes: {
    before: [1, 2, 3, 4, 5, 6],
    after: [1, 2],
    added: [],
    removed: [3, 4, 5, 6],
    changed: true,
    weakening: true,
  },
  keywordPrefilterEnabled: {
    before: false,
    after: true,
    changed: true,
    weakening: true,
  },
};

function settings(enabled = true, revision = "rev-1"): GuardrailsSettings {
  return {
    activation: { status: enabled ? "active" : "disabled" },
    configuredEnabled: enabled,
    customRuleCount: 0,
    disabledBuiltinRuleIds: [],
    enabled,
    enabledDataTypes: [1, 2, 3, 4, 5, 6],
    failurePolicy: "block",
    keywordPrefilterEnabled: false,
    mode: "enforce",
    providerOptions: [
      { id: "anthropic-native", kind: "native", configured: true, disabled: false },
      { id: "openai", kind: "configured", configured: true, disabled: false },
    ],
    providerScope: { mode: "all" },
    revision,
  };
}

function overviewFixture(enabled = true, revision = "rev-1"): GuardrailsOverview {
  return {
    ...settings(enabled, revision),
    registry: {
      status: enabled ? "ready" : "disabled",
      generation: enabled ? 1 : null,
      policyRevision: "policy-1",
      effectiveRuleCount: enabled ? 266 : 0,
    },
    ruleSummary: { total: 266, builtin: 266, custom: 0 },
    overview: structuredClone(telemetry),
  };
}

const rules: GuardrailsRules = {
  revision: "rev-1",
  rules: [{
    ruleId: "rule-one",
    dataType: 1,
    group: "CREDENTIALS",
    displayName: "Rule one",
    description: "A rule",
    source: "manual",
    enabled: true,
    custom: false,
  }],
  builtinRuleCount: 1,
  customRuleCount: 0,
  customRules: [],
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function installFetch() {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/guardrails" && method === "GET") {
        overviewRequests += 1;
        if (holdOverview) {
          await new Promise<void>(resolve => { releaseOverview = resolve; });
        }
        return failOverview ? json({ error: "overview unavailable" }, 503) : json(overview);
      }
      if (url.pathname === "/api/guardrails/rules" && method === "GET") {
        rulesRequests += 1;
        return json({
          ...rules,
          revision: overview.revision,
          ...(emptyRules ? {
            rules: [],
            builtinRuleCount: 0,
            customRuleCount: 0,
            customRules: [],
          } : {}),
        });
      }
      if (url.pathname === "/api/guardrails/export" && method === "GET") {
        exportRequests += 1;
        return failExport
          ? json({ error: "export unavailable" }, 503)
          : json({ version: 1, settings: {}, customRules: [] });
      }
      if (url.pathname === "/api/guardrails/activity" && method === "GET") {
        activityRequests.push(url.search);
        if (holdActivity) {
          await new Promise<void>(resolve => { releaseActivity = resolve; });
        }
        return failActivity ? json({ error: "activity unavailable" }, 503) : json(activity);
      }
      if (url.pathname === "/api/guardrails/import" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        importRequests.push({ body, ifMatch: headers.get("if-match") });
        if (body.dryRun === true) {
          return json({
            ok: !importConflict,
            dryRun: true,
            mode: body.mode,
            createCount: importConflict ? 0 : 1,
            unchangedCount: 0,
            replaceCount: 0,
            conflicts: importConflict ? ["custom.conflict"] : [],
            securityDiff: body.mode === "replace"
              ? weakeningSecurityDiff
              : unchangedSecurityDiff,
            ...(importConflict ? { error: "import conflicts with an existing custom rule" } : {}),
          });
        }
        return json({ ok: true, dryRun: false });
      }
      if (url.pathname === "/api/guardrails/settings" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as GuardrailsSettingsPatch;
        const headers = new Headers(init?.headers);
        mutations.push({ body, ifMatch: headers.get("if-match") });
        if (failSettings) {
          overview = overviewFixture(false, "rev-remote");
          return json({
            error: "Guardrails settings changed since they were loaded",
            code: "guardrails_revision_conflict",
            revision: "rev-remote",
          }, 412);
        }
        const enabled = body.enabled ?? overview.enabled;
        overview = {
          ...overview,
          ...body,
          enabled,
          configuredEnabled: enabled,
          activation: { status: enabled ? "active" : "disabled" },
          revision: "rev-2",
        };
        return json({ ok: true, persistence: "saved", ...settings(overview.enabled, "rev-2") });
      }
      return json({ error: `unexpected ${method} ${url.pathname}` }, 500);
    },
  });
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#guardrails" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    HTMLElement: { configurable: true, value: testWindow.HTMLElement },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  overview = overviewFixture();
  activity = {
    ...structuredClone(telemetry),
    events: structuredClone(telemetry.recentEvents),
    totalMatching: 1,
    filteredSummary: {
      eventCount: 1,
      findingCount: 1,
      averageLatencyMs: 1,
      topRules: [{ id: "rule-one", count: 1 }],
      topCategories: [{ id: 1, count: 1 }],
    },
  };
  failSettings = false;
  failActivity = false;
  failOverview = false;
  emptyRules = false;
  holdOverview = false;
  holdActivity = false;
  importConflict = false;
  failExport = false;
  releaseOverview = null;
  releaseActivity = null;
  mutations.splice(0, mutations.length);
  activityRequests.splice(0, activityRequests.length);
  importRequests.splice(0, importRequests.length);
  overviewRequests = 0;
  rulesRequests = 0;
  exportRequests = 0;
  installFetch();
});

afterEach(async () => {
  releaseOverview?.();
  releaseActivity?.();
  if (root) {
    const mounted = root;
    await act(async () => { mounted.unmount(); });
    root = null;
  }
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

async function mount(settle = true) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Guardrails apiBase={API_BASE} />
      </LanguageProvider>,
    );
  });
  if (settle) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  }
}

async function confirm(label: string) {
  const action = [...document.querySelectorAll<HTMLButtonElement>(".modal-actions button")]
    .find(button => button.textContent?.trim() === label)!;
  await act(async () => {
    action.click();
    await new Promise(resolve => setTimeout(resolve, 15));
  });
}

async function openTab(name: "rules" | "activity" | "settings") {
  await act(async () => {
    host.querySelector<HTMLButtonElement>(`#guardrails-tab-${name}`)!.click();
    await new Promise(resolve => setTimeout(resolve, 15));
  });
}

function namedButton(label: string, rootNode: ParentNode = host): HTMLButtonElement {
  return [...rootNode.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === label)!;
}

async function uploadImportBundle() {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const bundle = new testWindow.File(
    [JSON.stringify({ version: 1, settings: {}, customRules: [] })],
    "guardrails.json",
    { type: "application/json" },
  );
  Object.defineProperty(input, "files", { configurable: true, value: [bundle] });
  await act(async () => {
    input.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 15));
  });
}

test("successful disable synchronizes both tabs and returns focus", async () => {
  await mount();
  const trigger = host.querySelector<HTMLButtonElement>(".guardrails-overview-hero .switch")!;
  trigger.focus();
  await act(async () => { trigger.click(); });
  await confirm("Disable");

  expect(mutations).toEqual([{ body: { enabled: false }, ifMatch: '"rev-1"' }]);
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    host.querySelector<HTMLButtonElement>("#guardrails-tab-settings")!.click();
    await new Promise(resolve => setTimeout(resolve, 5));
  });
  expect(host.querySelector<HTMLButtonElement>("#guardrails-panel-settings .switch")
    ?.getAttribute("aria-pressed")).toBe("false");
});

test("revision conflict refetches authoritative state and keeps the dialog retryable", async () => {
  failSettings = true;
  await mount();
  const trigger = host.querySelector<HTMLButtonElement>(".guardrails-overview-hero .switch")!;
  trigger.focus();
  await act(async () => { trigger.click(); });
  await confirm("Disable");

  const dialog = document.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("Guardrails settings changed since they were loaded");
  expect(dialog.querySelector<HTMLButtonElement>(".modal-actions button")?.disabled).toBe(false);
  expect(overviewRequests).toBeGreaterThanOrEqual(2);
  expect(rulesRequests).toBeGreaterThanOrEqual(2);
  expect(trigger.getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    dialog.querySelector<HTMLButtonElement>(".modal-head button")!.click();
    await new Promise(resolve => setTimeout(resolve, 5));
  });
  expect(document.activeElement).toBe(trigger);
});

test("Activity refresh failure preserves stale rows and shows an error", async () => {
  await mount();
  await openTab("activity");
  expect(host.querySelectorAll("#guardrails-panel-activity tbody tr")).toHaveLength(1);

  failActivity = true;
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>("#guardrails-panel-activity button")]
      .find(button => button.textContent?.trim() === "Refresh")!.click();
    await new Promise(resolve => setTimeout(resolve, 15));
  });
  expect(host.querySelector(".notice-err")?.textContent).toContain("activity unavailable");
  expect(host.querySelectorAll("#guardrails-panel-activity tbody tr")).toHaveLength(1);
});

test("cold Overview renders a skeleton until its first response", async () => {
  holdOverview = true;
  await mount(false);
  await act(async () => { await Promise.resolve(); });

  expect(host.querySelector("#guardrails-panel-overview .data-surface-skeleton"))
    .not.toBeNull();
  expect(host.querySelector("#guardrails-panel-overview [aria-busy=\"true\"]"))
    .not.toBeNull();

  holdOverview = false;
  releaseOverview?.();
  releaseOverview = null;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  expect(host.querySelector(".guardrails-overview-hero")).not.toBeNull();
});

test("failed-cold Overview exposes Retry and retries through a skeleton", async () => {
  failOverview = true;
  await mount();

  expect(host.querySelector("#guardrails-panel-overview .empty")?.textContent)
    .toContain("overview unavailable");
  const retry = namedButton("Retry");

  failOverview = false;
  holdOverview = true;
  await act(async () => {
    retry.click();
    await Promise.resolve();
  });
  expect(host.querySelector("#guardrails-panel-overview .data-surface-skeleton"))
    .not.toBeNull();

  holdOverview = false;
  releaseOverview?.();
  releaseOverview = null;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  expect(host.querySelector(".guardrails-overview-hero")).not.toBeNull();
});

test("Activity refresh keeps stale rows visible while loading", async () => {
  await mount();
  await openTab("activity");
  holdActivity = true;

  await act(async () => {
    namedButton("Refresh", host.querySelector("#guardrails-panel-activity")!).click();
    await Promise.resolve();
  });

  expect(host.querySelectorAll("#guardrails-panel-activity tbody tr")).toHaveLength(1);
  expect(host.querySelector("#guardrails-panel-activity .data-surface-status"))
    .not.toBeNull();
  expect(host.querySelector("#guardrails-panel-activity .data-surface-skeleton"))
    .toBeNull();

  holdActivity = false;
  releaseActivity?.();
  releaseActivity = null;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
});

test("empty Rules response renders the canonical empty state", async () => {
  emptyRules = true;
  await mount();
  await openTab("rules");

  expect(host.querySelector("#guardrails-panel-rules .empty")?.textContent)
    .toContain("No rules match these filters.");
  expect(host.querySelector("#guardrails-panel-rules .guardrails-rule-list")).toBeNull();
});

test("bulk disable requires consequence confirmation before mutating settings", async () => {
  await mount();
  await openTab("rules");

  const trigger = namedButton("Disable 1");
  trigger.focus();
  await act(async () => { trigger.click(); });

  expect(mutations).toHaveLength(0);
  expect(document.querySelector("dialog")?.textContent).toContain("Disable 1 rules?");
  await confirm("Disable rules");

  expect(mutations).toEqual([{
    body: { disabledBuiltinRuleIds: ["rule-one"] },
    ifMatch: '"rev-1"',
  }]);
  expect(document.activeElement).toBe(trigger);
});

test("Rules export uses the authenticated API client and downloads the returned bundle", async () => {
  await mount();
  await openTab("rules");
  let downloadedFilename = "";
  const preventNavigation = (event: Event) => {
    const anchor = event.target;
    if (!(anchor instanceof testWindow.HTMLAnchorElement)) return;
    downloadedFilename = anchor.download;
    event.preventDefault();
  };
  document.addEventListener("click", preventNavigation);

  await act(async () => {
    namedButton("Export").click();
    await new Promise(resolve => setTimeout(resolve, 15));
  });

  document.removeEventListener("click", preventNavigation);
  expect(exportRequests).toBe(1);
  expect(downloadedFilename).toBe("opencodex-guardrails.json");
});

test("category disable requires confirmation and keyword prefilter saves directly", async () => {
  await mount();
  await openTab("settings");

  const credentials = [...host.querySelectorAll<HTMLLabelElement>(
    "#guardrails-panel-settings .guardrails-types label",
  )].find(label => label.textContent?.trim() === "Credentials")!
    .querySelector<HTMLInputElement>("input")!;
  credentials.focus();
  await act(async () => { credentials.click(); });

  expect(mutations).toHaveLength(0);
  expect(document.querySelector("dialog")?.textContent).toContain("Disable a data category?");
  await confirm("Disable category");
  expect(mutations[0]).toEqual({
    body: { enabledDataTypes: [2, 3, 4, 5, 6] },
    ifMatch: '"rev-1"',
  });
  expect(host.textContent).toContain("Reduced coverage");

  const prefilter = host.querySelector<HTMLButtonElement>(
    '#guardrails-panel-settings button[aria-label="Keyword prefilter"]',
  )!;
  prefilter.focus();
  await act(async () => { prefilter.click(); });

  expect(document.querySelector("dialog")).toBeNull();
  expect(mutations[1]).toEqual({
    body: { keywordPrefilterEnabled: true },
    ifMatch: '"rev-2"',
  });
  expect(host.textContent).toContain("Reduced coverage");
});

test("provider coverage narrowing requires consequence confirmation", async () => {
  await mount();
  await openTab("settings");

  const openai = [...host.querySelectorAll<HTMLLabelElement>(
    "#guardrails-panel-settings .guardrails-types label",
  )].find(label => label.textContent?.trim() === "openai")!
    .querySelector<HTMLInputElement>("input")!;
  openai.focus();
  await act(async () => { openai.click(); });

  expect(mutations).toHaveLength(0);
  expect(document.querySelector("dialog")?.textContent)
    .toContain("Limit provider coverage?");
  await confirm("Limit coverage");

  expect(mutations).toEqual([{
    body: {
      providerScope: {
        mode: "selected",
        providerIds: ["anthropic-native"],
      },
    },
    ifMatch: '"rev-1"',
  }]);
  expect(host.textContent).toContain("Provider coverage is limited");
  expect(document.activeElement).toBe(openai);
});

test("the last protected provider stays selected with a visible error", async () => {
  overview.providerOptions = [
    { id: "openai", kind: "configured", configured: true, disabled: false },
  ];
  overview.providerScope = { mode: "selected", providerIds: ["openai"] };
  await mount();
  await openTab("settings");

  const openai = [...host.querySelectorAll<HTMLLabelElement>(
    "#guardrails-panel-settings .guardrails-types label",
  )].find(label => label.textContent?.trim() === "openai")!
    .querySelector<HTMLInputElement>("input")!;
  await act(async () => { openai.click(); });

  expect(document.querySelector("dialog")).toBeNull();
  expect(mutations).toHaveLength(0);
  expect(host.querySelector('[role="alert"]')?.textContent)
    .toContain("Keep at least one provider selected");
  expect(openai.checked).toBe(true);
});

test("a stale-only provider scope is labelled and reports zero effective coverage", async () => {
  overview.providerOptions = [
    { id: "removed-provider", kind: "configured", configured: false, disabled: false },
  ];
  overview.providerScope = {
    mode: "selected",
    providerIds: ["removed-provider"],
  };
  await mount();
  await openTab("settings");

  expect(host.textContent).toContain("removed-provider · not configured");
  expect(host.textContent).toContain("No active provider is selected");
});

test("the last enabled data category stays enabled with a visible error", async () => {
  overview.enabledDataTypes = [1];
  await mount();
  await openTab("settings");

  const credentials = [...host.querySelectorAll<HTMLLabelElement>(
    "#guardrails-panel-settings .guardrails-types label",
  )].find(label => label.textContent?.trim() === "Credentials")!
    .querySelector<HTMLInputElement>("input")!;
  await act(async () => { credentials.click(); });

  expect(document.querySelector("dialog")).toBeNull();
  expect(mutations).toHaveLength(0);
  expect(host.querySelector('[role="alert"]')?.textContent)
    .toContain("At least one data type must remain enabled");
  expect(credentials.checked).toBe(true);
});

test("import is previewed before a separate apply request", async () => {
  await mount();
  await openTab("rules");
  await uploadImportBundle();

  expect(importRequests).toHaveLength(1);
  expect(importRequests[0]).toMatchObject({
    body: { mode: "merge", dryRun: true },
    ifMatch: '"rev-1"',
  });
  expect(host.textContent).toContain("Import preview");
  expect(namedButton("Apply import").disabled).toBe(false);

  await act(async () => {
    namedButton("Apply import").click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  expect(importRequests).toHaveLength(2);
  expect(importRequests[1]).toMatchObject({
    body: { mode: "merge", dryRun: false },
    ifMatch: '"rev-1"',
  });
  expect(host.textContent).not.toContain("Import preview");
});

test("Replace import that weakens protection requires explicit confirmation", async () => {
  await mount();
  await openTab("rules");

  const importMode = host.querySelector<HTMLButtonElement>(
    '#guardrails-panel-rules [role="combobox"][aria-label="Import mode"]',
  )!;
  await act(async () => { importMode.click(); });
  const replace = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(option => option.textContent?.trim() === "Replace")!;
  await act(async () => { replace.click(); });
  await uploadImportBundle();

  expect(host.textContent).toContain("reduces protection");
  await act(async () => { namedButton("Apply import").click(); });

  expect(importRequests).toHaveLength(1);
  expect(document.querySelector("dialog")?.textContent)
    .toContain("Apply an import that reduces protection?");
  await confirm("Apply reduced protection");

  expect(importRequests).toHaveLength(2);
  expect(importRequests[1]).toMatchObject({
    body: { mode: "replace", dryRun: false },
    ifMatch: '"rev-1"',
  });
});

test("conflicted import preview cannot be applied", async () => {
  importConflict = true;
  await mount();
  await openTab("rules");
  await uploadImportBundle();

  expect(host.textContent).toContain("custom.conflict");
  expect(namedButton("Apply import").disabled).toBe(true);
  expect(importRequests).toHaveLength(1);
});

test("Activity surface, mode, result, and category filters are sent to the server", async () => {
  await mount();
  await openTab("activity");

  const choose = async (label: string, optionLabel: string) => {
    const select = host.querySelector<HTMLButtonElement>(
      `#guardrails-panel-activity [role="combobox"][aria-label="${label}"]`,
    )!;
    await act(async () => { select.click(); });
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(candidate => candidate.textContent?.trim() === optionLabel)!;
    await act(async () => {
      option.click();
      await new Promise(resolve => setTimeout(resolve, 20));
    });
  };
  await choose("Surface", "Responses");
  await choose("Mode", "Enforce masking");
  await choose("Result", "Masked");
  await choose("Category", "Credentials");

  const query = new URLSearchParams(activityRequests.at(-1));
  expect(query.get("limit")).toBe("100");
  expect(query.get("surface")).toBe("responses");
  expect(query.get("mode")).toBe("enforce");
  expect(query.get("result")).toBe("masked");
  expect(query.get("category")).toBe("1");
  expect(host.querySelector("#guardrails-panel-activity tbody tr td:nth-child(6)")?.textContent)
    .toBe("1");
  expect(host.querySelector('[aria-label="Filtered activity summary"]')?.textContent)
    .toContain("Events: 1");
});
