/**
 * Codex Set shell (devlog 260802_codex_set_prompt_composer/030).
 *
 * Two exclusive tabpanels shaped like Logs/Debug, a legacy hash that still
 * resolves, and a Prompt panel that renders the five config-toggle rows from the
 * live inventory rather than a locally rebuilt list.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import CodexSet from "../src/pages/CodexSet";
import CodexSetPrompt from "../src/pages/codex-set-prompt";
import { readPageFromHash, resolveAppHashChange, hashBelongsToPage } from "../src/app-routing";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const INVENTORY = [
  { id: "base-instructions", class: "base", key: null, default: null, order: 0 },
  { id: "model-switch", class: "runtime-conditional", key: null, default: null, order: 1 },
  { id: "personality", class: "feature-gated", key: "features.personality", default: true, order: 2 },
  { id: "permissions", class: "config-toggle", key: "include_permissions_instructions", default: true, order: 6 },
  { id: "collaboration", class: "config-toggle", key: "include_collaboration_mode_instructions", default: true, order: 7 },
  { id: "environment", class: "config-toggle", key: "include_environment_context", default: true, order: 8 },
  { id: "apps", class: "config-toggle", key: "include_apps_instructions", default: true, order: 10 },
  { id: "skills", class: "config-toggle", key: "skills.include_instructions", default: true, order: 13 },
];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/config.toml",
    storePath: "/tmp/opencodex-prompt.json",
    configExists: true,
    readable: true,
    developerInstructionsOwned: false,
    developerInstructionsState: "absent" as const,
    drift: null,
    revision: "sha256:one",
    inventory: INVENTORY,
    toggles: INVENTORY.filter(d => d.class === "config-toggle").map(d => ({
      id: d.id, key: d.key as string, userFileValue: null, defaultedUserValue: true, default: true,
    })),
    extensionLayersEnumerable: false,
    custom: [],
    modelInstructionsFile: null,
    baseVariants: [],
    baseSelection: { kind: "default" as const },
    maxBaseVariants: 2,
    ...over,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#codex-set" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The resource store is keyed by apiBase and outlives a single test. Without
  // this, a later case renders the PREVIOUS case's snapshot from cache and its
  // fetch stub is never consulted.
  clearClientResourceStoresForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

interface StubCall { url: string; method: string; body: unknown }

function stubRoutes(handler: (call: StubCall) => Response | Promise<Response>) {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: StubCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function mountShell(apiBase = "", machineApiBase = apiBase): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><CodexSet apiBase={apiBase} machineApiBase={machineApiBase} /></LanguageProvider>);
  });
  return { root, container };
}

async function mountPrompt(): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><CodexSetPrompt apiBase="" /></LanguageProvider>);
  });
  return { root, container };
}

function panel(container: HTMLElement, name: "multiauth" | "prompt" | "desktop"): HTMLElement | null {
  return container.querySelector("#codex-set-panel-" + name);
}

test("1. #codex-set renders Multi-auth, and Prompt is not mounted", async () => {
  stubRoutes(() => json({}));
  const { container, root } = await mountShell();
  const multi = panel(container, "multiauth");
  expect(multi).not.toBeNull();
  expect(multi!.hasAttribute("hidden")).toBe(false);
  // Case 4: Prompt does not mount until first visited.
  expect(panel(container, "prompt")).toBeNull();
  expect(panel(container, "desktop")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("desktop compatibility deep link mounts only its read-only status surface", async () => {
  testWindow.location.hash = "#codex-set/desktop";
  const calls = stubRoutes(call => json(call.url.endsWith("/settings") ? { ok: true, settings: { startOnProxyStart: false, revision: "a".repeat(64) } } : call.url.endsWith("/certificate")
    ? { ok: true, certificate: { supported: true, state: "missing", busy: null } }
    : { ok: true, runtime: { supported: true, phase: "off", running: false } }));
  const { container, root } = await mountShell("/shared", "/machine");
  expect(hashBelongsToPage("codex-set/desktop", "codex-set")).toBe(true);
  expect(resolveAppHashChange("codex-set/desktop").replaceTo).toBeNull();
  expect(panel(container, "desktop")?.hasAttribute("hidden")).toBe(false);
  expect(panel(container, "multiauth")).toBeNull(); expect(panel(container, "prompt")).toBeNull();
  expect(new Set(calls.map(call => call.url))).toEqual(new Set([
    "/machine/api/codex/desktop-compatibility/settings", "/machine/api/codex/desktop-compatibility/certificate",
    "/machine/api/codex/desktop-compatibility/runtime",
  ]));
  expect(calls.every(call => call.method === "GET" && call.url.startsWith("/machine/api/codex/desktop-compatibility/"))).toBe(true);
  await act(async () => { root.unmount(); });
});

test("2. #codex-set/prompt renders the Prompt panel", async () => {
  testWindow.location.hash = "#codex-set/prompt";
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mountShell();
  const prompt = panel(container, "prompt");
  expect(prompt).not.toBeNull();
  expect(prompt!.hasAttribute("hidden")).toBe(false);
  // Symmetric lazy mount: arriving straight at Prompt must NOT start Multi-auth's
  // /api/config fetch and 30s account poll behind a hidden panel.
  expect(panel(container, "multiauth")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("3. the shipped #codex-auth bookmark redirects to #codex-set", () => {
  expect(readPageFromHash("codex-auth")).toBe("codex-set");
  const action = resolveAppHashChange("codex-auth");
  expect(action.page).toBe("codex-set");
  expect(action.replaceTo).toBe("codex-set");
  // A nested legacy bookmark resolves too, rather than landing on an unknown page.
  expect(resolveAppHashChange("codex-auth/anything").page).toBe("codex-set");
  expect(hashBelongsToPage("codex-set/prompt", "codex-set")).toBe(true);
});

test("5. Prompt stays mounted after switching away", async () => {
  testWindow.location.hash = "#codex-set/prompt";
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mountShell();
  expect(panel(container, "prompt")).not.toBeNull();
  await act(async () => {
    testWindow.location.hash = "#codex-set";
    testWindow.dispatchEvent(new testWindow.Event("hashchange"));
  });
  // Still in the tree, just hidden: a remount would refetch for nothing.
  const prompt = panel(container, "prompt");
  expect(prompt).not.toBeNull();
  expect(prompt!.hasAttribute("hidden")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("6. a tab switch pushes history, so Back returns to the previous tab", async () => {
  // Driving the hash by hand would pass even if the tab REPLACED history instead
  // of pushing it, which is the regression this case exists to catch. happy-dom
  // back() cannot be driven through act() without tripping React's scheduler, so
  // the discriminator is history growth plus the absence of a replaceState call.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mountShell();
  const promptTab = container.querySelector("#codex-set-tab-prompt") as HTMLButtonElement;
  const lengthBefore = testWindow.history.length;
  let replaceCalls = 0;
  const realReplace = testWindow.history.replaceState.bind(testWindow.history);
  testWindow.history.replaceState = ((...args: unknown[]) => {
    replaceCalls += 1;
    return (realReplace as (...a: unknown[]) => unknown)(...args);
  }) as typeof testWindow.history.replaceState;
  await act(async () => { promptTab.click(); });
  expect(testWindow.location.hash).toBe("#codex-set/prompt");
  // happy-dom does not emit hashchange for a scripted assignment the way a browser
  // does, so the shell hears it here rather than through the environment.
  await act(async () => { testWindow.dispatchEvent(new testWindow.Event("hashchange")); });
  expect(container.querySelector("#codex-set-tab-prompt")!.getAttribute("aria-selected")).toBe("true");

  expect(testWindow.history.length).toBeGreaterThan(lengthBefore);
  expect(replaceCalls).toBe(0);

  await act(async () => {
    testWindow.location.hash = "#codex-set";
    testWindow.dispatchEvent(new testWindow.Event("hashchange"));
  });
  expect(container.querySelector("#codex-set-tab-multiauth")!.getAttribute("aria-selected")).toBe("true");
  await act(async () => { root.unmount(); });
});

test("7. the timing copy promises new sessions, not an immediate or restarted apply", async () => {
  // devlog 003 section 3 leaves the frontend reload path UNKNOWN, so the panel
  // must not claim either. Pinned here so a later copy edit cannot quietly
  // promise something the runtime does not do.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mountPrompt();
  const text = container.textContent ?? "";
  expect(text).toContain("newly started sessions");
  expect(text).not.toContain("immediately");
  expect(text).not.toContain("restart");
  await act(async () => { root.unmount(); });
});

test("8. the five switches come from the inventory, one per config-toggle row", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mountPrompt();
  const switches = container.querySelectorAll("[data-layer-class=\"config-toggle\"] button[role=\"switch\"]");
  expect(switches).toHaveLength(5);
  const text = container.textContent ?? "";
  expect(text).toContain("include_apps_instructions");
  // WP4 renders every class; what stays true here is that a switch appears for a
  // config-toggle row and for nothing else. The full taxonomy, including the rule
  // that a locked layer gets no switch ELEMENT at all, is owned by
  // codex-set-prompt-layers.test.tsx.
  for (const descriptor of INVENTORY.filter(d => d.class !== "config-toggle")) {
    const el = container.querySelector("[data-layer-id=\"" + descriptor.id + "\"]");
    expect(el, descriptor.id).not.toBeNull();
    expect(el!.querySelector("input"), descriptor.id).toBeNull();
  }
  for (const descriptor of INVENTORY.filter(d => d.class === "config-toggle")) {
    expect(container.querySelector("[data-layer-id=\"" + descriptor.id + "\"]")).not.toBeNull();
  }
  await act(async () => { root.unmount(); });
});

test("9. toggling PUTs once with the current revision", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") {
      return json({ ok: true, changed: true, snapshot: snapshot({ revision: "sha256:two" }) });
    }
    return json(snapshot());
  });
  const { container, root } = await mountPrompt();
  const first = container.querySelector("[data-layer-class=\"config-toggle\"] button[role=\"switch\"]") as HTMLButtonElement;
  await act(async () => {
    first.click();
  });
  const puts = calls.filter(c => c.method === "PUT");
  expect(puts).toHaveLength(1);
  // Endpoint and layer id matter as much as the payload: a PUT to the wrong URL
  // or the wrong row would otherwise satisfy a body-only assertion.
  expect(puts[0]!.url).toBe("/api/codex-prompt/toggle");
  const body = puts[0]!.body as { id: string; enabled: boolean; revision: string };
  expect(body.id).toBe("permissions");
  expect(body.revision).toBe("sha256:one");
  expect(body.enabled).toBe(false);
  // The echoed snapshot is installed, so the next write carries the NEW revision.
  expect(container.textContent).toContain("include_permissions_instructions");
  await act(async () => { root.unmount(); });
});

test("10. a stale-revision 409 re-reads instead of retrying blindly", async () => {
  let gets = 0;
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: false, code: "stale_revision" }, 409);
    gets += 1;
    return json(snapshot({ revision: gets > 1 ? "sha256:fresh" : "sha256:one" }));
  });
  const { container, root } = await mountPrompt();
  const first = container.querySelector("[data-layer-class=\"config-toggle\"] button[role=\"switch\"]") as HTMLButtonElement;
  await act(async () => {
    first.click();
  });
  // Exactly one write attempt: a blind retry would overwrite whatever moved the file.
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
  expect(gets).toBeGreaterThan(1);
  expect(container.querySelector("[role=\"alert\"]")).not.toBeNull();

  // The re-read must be INSTALLED, not merely issued. Counting GETs cannot show
  // that: a refresh whose payload is discarded issues the same request. The only
  // proof is the NEXT write carrying the refreshed revision, which is exactly what
  // the user needs for their retry to land.
  await act(async () => {
    (container.querySelector("[data-layer-class=\"config-toggle\"] button[role=\"switch\"]") as HTMLButtonElement).click();
  });
  const puts = calls.filter(c => c.method === "PUT");
  expect(puts).toHaveLength(2);
  expect((puts[1]!.body as { revision: string }).revision).toBe("sha256:fresh");
  await act(async () => { root.unmount(); });
});

test("11. configExists false leaves the switches live, not disabled", async () => {
  // First run: the file does not exist yet and the first write creates it.
  stubRoutes(() => json(snapshot({ configExists: false })));
  const { container, root } = await mountPrompt();
  const switches = [...container.querySelectorAll("[data-layer-class=\"config-toggle\"] button[role=\"switch\"]")] as HTMLButtonElement[];
  expect(switches).toHaveLength(5);
  for (const input of switches) expect(input.disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test("a failed load is visible, not an empty settled list", async () => {
  // The cold failure used to render as a title, the timing line, and nothing else.
  // The loading contract exists to keep "failed" and "empty" apart, and a source
  // scan for .showError cannot tell whether anything is actually rendered.
  stubRoutes(() => new Response("nope", { status: 500 }));
  const { container, root } = await mountPrompt();
  expect(container.querySelector("[role=\"alert\"]")).not.toBeNull();
  expect(container.querySelectorAll("[data-layer-class=\"config-toggle\"] button[role=\"switch\"]")).toHaveLength(0);
  await act(async () => { root.unmount(); });
});
test("an unreadable config refuses writes and says so", async () => {
  stubRoutes(() => json(snapshot({ readable: false })));
  const { container, root } = await mountPrompt();
  expect(container.querySelector("[role=\"alert\"]")).not.toBeNull();
  const switches = [...container.querySelectorAll("[data-layer-class=\"config-toggle\"] button[role=\"switch\"]")] as HTMLButtonElement[];
  for (const input of switches) expect(input.disabled).toBe(true);
  await act(async () => { root.unmount(); });
});
