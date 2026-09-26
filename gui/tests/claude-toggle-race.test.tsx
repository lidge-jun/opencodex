import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * Rapid clicks on the Claude connection switch must serialize to a single
 * in-flight PUT (ClaudeCode.tsx `connectionInFlight` + disabled while pending).
 *
 * The control moved out of the sidebar when the three integration pages
 * collapsed into one Integrations route, but its semantics did not: it still
 * commits immediately rather than becoming another Save-gated draft, so the
 * serialization it depended on has to move with it.
 */

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let putBodies: unknown[] = [];
let claudeEnabled = false;
let cliFirstParty = false;
let firstPartyPutResponse: { body: unknown; status?: number } | null = null;
let releasePut: (() => void) | null = null;
let putGate: Promise<void> | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The fields ClaudeCode reads while rendering. A bare `{ enabled }` payload was
 * enough while the switch lived in the sidebar, but the control now sits on the
 * Claude Code surface itself, so the page has to render for the switch to
 * exist at all — and it throws on a response missing `aliases`/`available`.
 */
const CLAUDE_CODE_STATE = {
  authMode: "auto",
  autoConnectSupported: false,
  systemEnv: false,
  fastMode: null,
  maxContextTokens: null,
  autoContext: true,
  autoCompactWindow: null,
  injectAgents: true,
  smallFastModel: "",
  effectiveModelEnv: {},
  available: [],
  aliases: [],
  modelMap: {},
  port: 10100,
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  // The switch now lives on the Claude Code surface, so the route has to be
  // the one that mounts it.
  testWindow = new Window({ url: "http://localhost/#integrations/claude" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).__APP_VERSION__ = "0.0.0-test";

  // The resource store is module-level: without this, the previous test's Claude Code state
  // seeds the next mount and its cold-start GET is skipped (staleAfterMs).
  clearClientResourceStoresForTests();
  putBodies = [];
  claudeEnabled = false;
  cliFirstParty = false;
  firstPartyPutResponse = null;
  putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (url.includes("/api/machine/status")) return jsonResponse({}, 404);
    if (url.includes("/api/claude-code") && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean; cliFirstParty?: boolean };
      putBodies.push(body);
      if (typeof body.cliFirstParty === "boolean" && firstPartyPutResponse) {
        return jsonResponse(firstPartyPutResponse.body, firstPartyPutResponse.status ?? 200);
      }
      await putGate;
      // The server persists what it was sent, so the following GET reports it.
      // A fixed response would let the page re-read `enabled: false` after
      // enabling and send the same value twice — hiding a real toggle bug.
      if (typeof body.enabled === "boolean") claudeEnabled = body.enabled;
      if (typeof body.cliFirstParty === "boolean") cliFirstParty = body.cliFirstParty;
      return jsonResponse({
        ...CLAUDE_CODE_STATE,
        enabled: claudeEnabled,
        cliFirstParty,
        desktopFirstParty: false,
        cliFirstPartyApplied: cliFirstParty && claudeEnabled,
        interceptEligible: claudeEnabled,
        interceptRunning: claudeEnabled,
        sharedProxy: cliFirstParty ? (claudeEnabled ? "live" : "stopped") : "none",
      });
    }
    if (url.includes("/api/claude-code")) {
      return jsonResponse({
        ...CLAUDE_CODE_STATE,
        enabled: claudeEnabled,
        cliFirstParty,
        desktopFirstParty: false,
        cliFirstPartyApplied: cliFirstParty && claudeEnabled,
        interceptEligible: claudeEnabled,
        interceptRunning: claudeEnabled,
        sharedProxy: cliFirstParty ? (claudeEnabled ? "live" : "stopped") : "none",
      });
    }
    if (url.includes("/healthz")) {
      return jsonResponse({ status: "ok", version: "0.0.0-test", uptime: 1 });
    }
    return jsonResponse({});
  }) as typeof fetch;

  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  releasePut?.();
  releasePut = null;
  putGate = null;
  testWindow.close();
  // Clear the auth-fetch install latch along with the window it was installed against.
  //
  // `installApiAuthFetch` installs once per module instance. Leaving the latch set after
  // this window closes makes a LATER test's own install a silent no-op, so its requests go
  // out unwrapped and it fails only when run after this file. Restoring the globals is not
  // enough; the latch lives in the module.
  const { resetApiAuthFetchForTests } = await import("../src/api");
  resetApiAuthFetchForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

async function mountApp() {
  const { resetApiAuthFetchForTests, installApiAuthFetch } = await import("../src/api");
  resetApiAuthFetchForTests();
  installApiAuthFetch();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });
  const [{ createRoot }, { LanguageProvider }, { default: App }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/App"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><App /></LanguageProvider>);
  });
}

function firstPartySwitch(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    item => item.getAttribute("aria-label") === "Toggle Claude Code CLI first-party",
  );
  if (!button) throw new Error("Claude CLI first-party switch not found");
  return button as HTMLButtonElement;
}

function claudeSwitch(): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Toggle Claude connection",
  );
  if (!btn) throw new Error("Claude toggle switch not found");
  return btn as unknown as HTMLButtonElement;
}

test("rapid Claude toggle clicks issue only one PUT until the first settles", async () => {
  const { resetApiAuthFetchForTests, installApiAuthFetch } = await import("../src/api");
  resetApiAuthFetchForTests();
  installApiAuthFetch();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });

  const [{ createRoot }, { LanguageProvider }, { default: App }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/App"),
  ]);

  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <App />
      </LanguageProvider>,
    );
  });

  await waitFor(() => {
    try {
      return !!claudeSwitch();
    } catch {
      return false;
    }
  });

  const sw = claudeSwitch();
  expect(sw.disabled).toBe(false);
  expect(sw.getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    sw.click();
    sw.click();
    sw.click();
  });

  expect(putBodies).toEqual([{ enabled: true }]);
  expect(claudeSwitch().disabled).toBe(true);

  await act(async () => {
    releasePut?.();
    releasePut = null;
    await Promise.resolve();
  });

  await waitFor(() => !claudeSwitch().disabled);

  // Re-arm a gated PUT and confirm a later click can fire again.
  putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  await act(async () => {
    claudeSwitch().click();
  });
  expect(putBodies).toEqual([{ enabled: true }, { enabled: false }]);

  await act(async () => {
    releasePut?.();
    releasePut = null;
  });
  await waitFor(() => !claudeSwitch().disabled);
});

test("CLI first-party waits for one PUT and a confirmed GET", async () => {
  claudeEnabled = true;
  await mountApp();
  await waitFor(() => {
    try { return !!firstPartySwitch(); } catch { return false; }
  });

  await act(async () => {
    firstPartySwitch().click();
    firstPartySwitch().click();
    firstPartySwitch().click();
  });
  expect(putBodies).toEqual([{ cliFirstParty: true }]);
  expect(firstPartySwitch().disabled).toBe(true);
  expect(firstPartySwitch().getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    releasePut?.();
    releasePut = null;
    await Promise.resolve();
  });
  await waitFor(() => firstPartySwitch().getAttribute("aria-pressed") === "true");
});

const refusalCases = [
  ["intercept_disabled", "The interception proxy is disabled."],
  ["intercept_unavailable", "The interception proxy is not running in this process."],
  ["foreign_env", "Another program owns the Claude proxy settings."],
  ["ca_unavailable", "The local certificate authority is unavailable."],
  ["unreadable", "Claude settings could not be read."],
  ["write_failed", "Claude settings could not be written."],
] as const;

for (const [code, message] of refusalCases) {
  test(`CLI first-party refusal ${code} leaves the switch off`, async () => {
    firstPartyPutResponse = { status: code === "intercept_disabled" || code === "intercept_unavailable" || code === "foreign_env" ? 409 : 500, body: { error: message, code } };
    await mountApp();
    await waitFor(() => { try { return !!firstPartySwitch(); } catch { return false; } });
    await act(async () => { firstPartySwitch().click(); });
    await waitFor(() => (container.textContent ?? "").includes(message));
    expect(firstPartySwitch().getAttribute("aria-pressed")).toBe("false");
  });
}

test("CLI first-party success trusts the divergent GET state", async () => {
  firstPartyPutResponse = { body: { ok: true } };
  await mountApp();
  await waitFor(() => { try { return !!firstPartySwitch(); } catch { return false; } });
  await act(async () => { firstPartySwitch().click(); });
  await waitFor(() => !firstPartySwitch().disabled);
  expect(firstPartySwitch().getAttribute("aria-pressed")).toBe("false");
});

test("CLI first-party can turn off while the proxy is stopped", async () => {
  cliFirstParty = true;
  claudeEnabled = false;
  await mountApp();
  await waitFor(() => firstPartySwitch().getAttribute("aria-pressed") === "true");
  await act(async () => {
    firstPartySwitch().click();
    releasePut?.();
    releasePut = null;
  });
  await waitFor(() => firstPartySwitch().getAttribute("aria-pressed") === "false");
  expect(putBodies).toEqual([{ cliFirstParty: false }]);
});

test("the Save payload does not overwrite CLI first-party intent", async () => {
  cliFirstParty = true;
  claudeEnabled = true;
  await mountApp();
  await waitFor(() => firstPartySwitch().getAttribute("aria-pressed") === "true");
  const save = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Save") as HTMLButtonElement | undefined;
  if (!save) throw new Error("Claude Code Save button not found");
  await act(async () => {
    save.click();
    releasePut?.();
    releasePut = null;
  });
  await waitFor(() => putBodies.length === 1);
  expect(putBodies[0]).not.toHaveProperty("cliFirstParty");
});
