import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

/**
 * Mounted behavior for the Integrations surfaces.
 *
 * The adapter suite proves the wire contract and stops there, which let three
 * real defects ship green: a switch labelled Disable that sent an apply, a
 * restore control disabled for every row the server would actually have
 * accepted, and refusals that reached the user without the recovery
 * information the server took care to send. Each test here drives the real
 * component against a real fetch mock and asserts what the user sees or what
 * goes out on the wire.
 */

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "confirm",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: Array<{ url: string; method: string; body: unknown }> = [];
/**
 * `useDataSurface` caches by key, and the key includes `apiBase`. Reusing one
 * base across tests replayed the previous test's response, so a fixture change
 * silently had no effect — several of these tests passed against stale data
 * before this counter existed.
 */
let mountCount = 0;
let apiBase = "";

type JournalRow = {
  opId: string;
  clientId: string;
  kind: string;
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
};

let stateResponse: () => Response;
let journalRows: JournalRow[];
let putResponse: () => Response;
/**
 * The overview also reads Codex routing, API keys, Claude Code, Claude Desktop
 * and the Grok fence. Default answers keep every existing test's card grid
 * shaped the way it was written; flipping this makes all five fail so the
 * unknown path can be driven.
 */
let failExtraSources = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "hermes",
    state: "current",
    installed: true,
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshotCount: 1,
    retentionDegraded: false,
    ...overrides,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations/hermes" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  journalRows = [];
  mountCount += 1;
  apiBase = `http://ocx-test-${mountCount}.invalid`;
  stateResponse = () => json(status());
  putResponse = () => json({ ok: true, clientId: "hermes", changed: true, state: "absent", message: "disabled" });
  failExtraSources = false;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("/journal")) return json({ operations: journalRows });
    if (url.includes("/api/startup-health")) {
      return failExtraSources
        ? json({ error: "nope" }, 500)
        : json({ routingInjected: false, status: "native", recommendedCommand: null });
    }
    if (url.includes("/api/keys")) {
      return failExtraSources ? json({ error: "nope" }, 500) : json({ keys: [] });
    }
    if (url.includes("/api/claude-desktop/status")) {
      return failExtraSources
        ? json({ error: "nope" }, 500)
        : json({ desiredEnabled: true, installed: true, observedKind: "standard", applied: false, stale: false, activeProfile: null, appliedAt: null });
    }
    if (url.includes("/api/native-integrations")) {
      return json({ clients: [{
        clientId: "claude-desktop",
        state: "absent",
        installed: true,
        configPath: "/tmp/desktop",
        desiredEnabled: true,
        disableBlocked: null,
      }] });
    }
    if (url.includes("/api/claude-code")) {
      return failExtraSources ? json({ error: "nope" }, 500) : json({ enabled: false });
    }
    if (url.includes("/api/grok")) {
      return failExtraSources ? json({ error: "nope" }, 500) : json({ present: false, models: [] });
    }
    if (method === "PUT") return putResponse();
    if (url.includes("/restore")) return json({ ok: true, clientId: "hermes", changed: true, state: "current", message: "restored" });
    return stateResponse();
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountClient(
  active = true,
  client: "hermes" | "dsh" = "hermes",
): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: FileIntegrationPage }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/FileIntegrationPage"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <FileIntegrationPage apiBase={apiBase} client={client} active={active} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

test("the DSH surface uses localized ownership semantics and its own API route", async () => {
  stateResponse = () => json(status({
    clientId: "dsh",
    configPath: "/tmp/home/.dsh/settings.yaml",
  }));
  await mountClient(true, "dsh");

  const text = container.textContent ?? "";
  expect(text).toContain("DeepSeek Harness (DSH)");
  expect(text).toContain("llm-pi-ai.providers.opencodex");
  expect(text).toContain("hot reload");
  expect(text).toContain("default model");
  expect(text).toContain("deepseek-official");
  expect(text).toContain("loopback");
  expect(requests.some(request => request.url.endsWith("/api/client-integrations/dsh"))).toBe(true);
});

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")) as unknown as HTMLButtonElement[];
}

/**
 * The switch belonging to ONE card.
 *
 * `buttons()[0]` used to be the file client's switch because it was the only
 * card with one. The Codex card now renders too, so "the first switch" is
 * whichever card sorts first — a fact about layout, not about the client under
 * test.
 */
function switchFor(clientId: string): HTMLButtonElement | undefined {
  const card = container.querySelector(`[data-client="${clientId}"]`);
  if (!card) return undefined;
  return Array.from(card.querySelectorAll("button")).find(
    button => (button as HTMLButtonElement).className.includes("switch"),
  ) as HTMLButtonElement | undefined;
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return buttons().find(button => (button.textContent ?? "").trim() === text);
}

function toggleSwitch(): HTMLButtonElement {
  const found = buttons().find(button => button.className.includes("switch"));
  if (!found) throw new Error("integration switch not found");
  return found;
}

test("turning the switch off disables, even when the block is stale", async () => {
  /*
   * The defect this pins: `stale` also means our block is on disk, so the
   * switch reads applied — and it used to send `enabled: true` for that state,
   * asking the server to REFRESH while the control was labelled Disable. The
   * user's config stayed connected after they turned it off.
   */
  stateResponse = () => json(status({ state: "stale" }));
  await mountClient();

  const sw = toggleSwitch();
  expect(sw.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { sw.click(); });

  const put = requests.find(request => request.method === "PUT");
  expect(put?.body).toEqual({ enabled: false });
});

test("updating a stale block is a separate action from the switch", async () => {
  stateResponse = () => json(status({ state: "stale" }));
  await mountClient();

  const update = buttonByText("Update");
  expect(update).toBeDefined();
  await act(async () => { update!.click(); });
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({ enabled: true });
});

test("an absent integration applies", async () => {
  stateResponse = () => json(status({ state: "absent" }));
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({ enabled: true });
});

test("conflict locks the switch instead of guessing", async () => {
  // Never auto-resolved: the alternative is deleting an edit we do not own.
  stateResponse = () => json(status({ state: "conflict", reason: "foreign-edit" }));
  await mountClient();
  expect(toggleSwitch().disabled).toBe(true);
});

test("unsafe locks the switch instead of guessing", async () => {
  stateResponse = () => json(status({ state: "unsafe", reason: "unparseable" }));
  await mountClient();
  expect(toggleSwitch().disabled).toBe(true);
});

test("a restore point the server would accept is offered, not disabled", async () => {
  /*
   * `undoable: false` on a non-expired row is the ordinary case — an older
   * operation, or a file edited since. The server answers those with
   * `drift_requires_confirm` and accepts an explicit confirmation, so
   * disabling the control made that confirmation unreachable.
   */
  journalRows = [{
    opId: "op-old",
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-02T09:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored",
    undoable: false,
  }];
  await mountClient();

  const restore = buttonByText("Restore this point…");
  expect(restore).toBeDefined();
  expect(restore!.disabled).toBe(false);
});

test("the newest undoable row is offered as Undo", async () => {
  journalRows = [{
    opId: "op-new",
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-02T10:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored",
    undoable: true,
  }];
  await mountClient();
  expect(buttonByText("Undo")).toBeDefined();
});

test("an expired snapshot offers nothing, because the bytes are gone", async () => {
  journalRows = [{
    opId: "op-gone",
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-02T08:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "expired",
    undoable: false,
  }];
  await mountClient();
  expect(buttonByText("Restore this point…")).toBeUndefined();
  expect(buttonByText("Undo")).toBeUndefined();
  expect(container.innerHTML).toContain("Backup expired");
});

test("a residual write tells the user the file may be half-written and where the backup is", async () => {
  /*
   * `residual` means compensation itself failed. It is the single most
   * important field in a refusal and nothing rendered it: the user was told
   * the change failed and left believing their file was untouched.
   */
  putResponse = () => json({
    error: "integration mutation failed",
    code: "integration_mutation_failed",
    clientId: "hermes",
    state: "current",
    reason: "write_failed",
    message: "the journal could not be written",
    snapshotPath: "/tmp/store/snapshots/hermes/op-1",
    residual: true,
  }, 500);
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  const text = container.textContent ?? "";
  expect(text).toContain("intermediate state");
  expect(text).toContain("/tmp/store/snapshots/hermes/op-1");
  expect(text).toContain("the journal could not be written");
});

test("a refusal routes by reason, not by the state it happened in", async () => {
  // `write_failed` while the file reads `conflict`: mapping on state would
  // tell the user to resolve a conflict that is not what went wrong.
  putResponse = () => json({
    error: "integration mutation failed",
    code: "integration_mutation_failed",
    clientId: "hermes",
    state: "conflict",
    reason: "write_failed",
    message: "disk full",
  }, 500);
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  const text = container.textContent ?? "";
  expect(text).toContain("disk full");
  expect(text).not.toContain("changed after opencodex wrote it");
});

test("a hidden panel makes no request at all", async () => {
  await mountClient(false);
  // Panels stay mounted while hidden to preserve drafts; `active` is the only
  // thing keeping them from polling behind the tab the user is looking at.
  expect(requests).toEqual([]);
});

async function mountOverview(): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: IntegrationsOverview }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/IntegrationsOverview"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <IntegrationsOverview apiBase={apiBase} active />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

test("the overview does not claim nothing is installed while it is still loading", async () => {
  /*
   * `clients` defaults to an empty array, so branching on its length first
   * told a mid-load user that no client was installed — a conclusion that can
   * only be drawn from a settled response.
   */
  let release: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  stateResponse = () => json({ clients: [] });
  const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: undefined });
    await gate;
    if (url.includes("/journal")) return json({ operations: [] });
    return json({ clients: [status({ installed: false, state: "absent" })] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: slowFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: slowFetch });

  await mountOverview();
  expect(container.textContent ?? "").not.toContain("No installed clients were detected");

  release!();
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  // Settled, and genuinely nothing installed: NOW the conclusion is fair.
  expect(container.textContent ?? "").toContain("No installed clients were detected");
});

test("bulk disable confirms the result with the server before claiming success", async () => {
  /*
   * The resource layer's `refresh()` is fire-and-forget, so awaiting it proves
   * nothing. If the PUTs report success but the clients are still applied, the
   * success Notice would sit above cards that contradict it.
   */
  // The component calls the bare `confirm`, which resolves on globalThis.
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: () => true });
  let applied = true;
  const bulkFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/journal")) return json({ operations: [] });
    if (method === "PUT") {
      // The server answers OK but the block is still on disk.
      return json({ ok: true, clientId: "hermes", changed: false, state: "current", message: "ok" });
    }
    return json({ clients: [status({ state: applied ? "current" : "absent" })] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: bulkFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: bulkFetch });

  await mountOverview();
  const disableAll = buttonByText("Disable all…");
  expect(disableAll).toBeDefined();
  await act(async () => { disableAll!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });

  const text = container.textContent ?? "";
  expect(text).not.toContain("Applied client integrations were disabled.");
  expect(text).toContain("may be stale");

});

test("bulk disable does report success once the server agrees", async () => {
  /*
   * The other half of the claim. Without it, "withholds success" could be
   * satisfied by a component that never reports success at all.
   */
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: () => true });
  let applied = true;
  const bulkFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/journal")) return json({ operations: [] });
    if (method === "PUT") {
      applied = false;
      return json({ ok: true, clientId: "hermes", changed: true, state: "absent", message: "ok" });
    }
    return json({ clients: [status({ state: applied ? "current" : "absent" })] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: bulkFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: bulkFetch });

  await mountOverview();
  const disableAll = buttonByText("Disable all…");
  expect(disableAll).toBeDefined();
  await act(async () => { disableAll!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });

  const text = container.textContent ?? "";
  expect(text).toContain("Applied client integrations were disabled.");
  expect(text).not.toContain("may be stale");
});

test("a drifted restore asks a second time instead of failing", async () => {
  /*
   * The server refuses a drifted restore unless `confirmDrift` is set. That
   * refusal is the only moment the user is told their newer edits are about to
   * be replaced, so it must escalate the dialog rather than surface as an error.
   */
  const posts: unknown[] = [];
  const restoreFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    posts.push(body);
    if ((body as { confirmDrift?: boolean })?.confirmDrift) {
      return json({ ok: true, clientId: "hermes", changed: true, state: "current", message: "restored" });
    }
    return json({
      error: "restore requires drift confirmation",
      code: "integration_drift_confirmation_required",
      clientId: "hermes",
      state: "conflict",
      reason: "drift_requires_confirm",
      message: "this file changed after that operation",
    }, 409);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: restoreFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: restoreFetch });

  const [{ createRoot }, { LanguageProvider }, { default: RestoreDialog }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/RestoreDialog"),
  ]);
  const row = {
    opId: "op-drift",
    clientId: "hermes" as const,
    kind: "apply" as const,
    at: "2026-08-02T09:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored" as const,
    undoable: false,
  };
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <RestoreDialog apiBase={apiBase} row={row} onClose={() => {}} onRestored={() => {}} />
      </LanguageProvider>,
    );
  });

  await act(async () => { buttonByText("Restore")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  // First submit asked without confirmation and the dialog escalated.
  expect((posts[0] as { confirmDrift?: boolean }).confirmDrift).toBe(false);
  expect(container.textContent ?? "").toContain("Newer edits were detected");

  const confirm = buttonByText("Back up newer edits and restore");
  expect(confirm).toBeDefined();
  await act(async () => { confirm!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });
  expect((posts[1] as { confirmDrift?: boolean }).confirmDrift).toBe(true);
});

test("a card toggles its own client without a trip to the sub-page", async () => {
  // Same rule as the client page: off means disable, for `stale` too.
  stateResponse = () => json({ clients: [status({ state: "stale" })] });
  await mountOverview();

  const sw = switchFor("hermes");
  expect(sw).toBeDefined();
  expect(sw!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { sw!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  const put = requests.find(request => request.method === "PUT");
  expect(put?.url).toContain("/api/client-integrations/hermes");
  expect(put?.body).toEqual({ enabled: false });
});

test("a card cannot toggle a client whose config is in conflict", async () => {
  stateResponse = () => json({ clients: [status({ state: "conflict", reason: "foreign-edit" })] });
  await mountOverview();
  const sw = switchFor("hermes");
  expect(sw?.disabled).toBe(true);
});

test("a card body navigates to its own client's tab", async () => {
  /*
   * The card LOOKS like the target, so that is what a user clicks. It used to
   * do nothing: only the small ghost button below it navigated. The card is
   * still not a single button — it holds a switch — so the title carries the
   * navigation and stretches over the card, and this test drives that title.
   */
  stateResponse = () => json({ clients: [status({ state: "current" })] });
  await mountOverview();

  const link = container.querySelector(
    ".integration-card[data-client='hermes'] .integration-card-link",
  ) as unknown as HTMLButtonElement | null;
  expect(link).not.toBeNull();
  await act(async () => { link!.click(); });
  expect(testWindow.location.hash).toBe("#integrations/hermes");
});

test("every reachable client gets a card, not just the file six", async () => {
  /*
   * The overview read one route and counted six clients, so a user with
   * Claude Code connected and a Grok fence written was told nothing was
   * applied while three integrations were live one tab away.
   */
  stateResponse = () => json({ clients: [status({ state: "absent" })] });
  await mountOverview();

  const clientIds = Array.from(container.querySelectorAll(".integration-card"))
    .map(card => (card as unknown as HTMLElement).getAttribute("data-client"));
  expect(clientIds).toContain("codex");
  // Keys deliberately absent: a credential is not a client card. It renders as
  // its own row above the grid instead.
  expect(clientIds).not.toContain("keys");
  expect(container.querySelector(".integration-cards [data-client='keys']")).toBeNull();
  expect(container.querySelector(".integration-api-keys-row")).not.toBeNull();
  expect(clientIds).toContain("claude");
  expect(clientIds).toContain("claudeDesktop");
  expect(clientIds).toContain("grok");
  expect(clientIds).toContain("hermes");

  /*
   * Switches belong to the clients this build can toggle in place, and that set
   * grew: the file client had the only one until Codex and Grok gained theirs.
   * Naming the owners keeps the assertion about WHICH cards can toggle rather
   * than about how many happen to today.
   */
  const switchOwners = Array.from(container.querySelectorAll(".integration-cards [data-client]"))
    .filter(card => Array.from(card.querySelectorAll("button"))
      .some(button => (button as HTMLButtonElement).className.includes("switch")))
    .map(card => card.getAttribute("data-client"));
  expect(switchOwners).toContain("hermes");
  expect(switchOwners).toContain("codex");
  expect(switchOwners).toContain("claudeDesktop");

  // Claude Desktop opens Claude's nested route, not a tab of its own.
  const desktopLink = container.querySelector(
    ".integration-card[data-client='claudeDesktop'] .integration-card-link",
  ) as unknown as HTMLButtonElement | null;
  await act(async () => { desktopLink!.click(); });
  expect(testWindow.location.hash).toBe("#integrations/claude/desktop");
});

test("a source that cannot be read is unknown, never 'not applied'", async () => {
  /*
   * The five extra reads settle independently. Painting a failed one as
   * `absent` would be the same lie this whole surface exists to remove, so
   * they resolve to a muted unknown badge and are counted in neither total.
   */
  stateResponse = () => json({ clients: [status({ state: "current" })] });
  failExtraSources = true;
  await mountOverview();

  for (const id of ["codex", "claude", "claudeDesktop", "grok"]) {
    const badge = container.querySelector(
      `.integration-card[data-client='${id}'] .badge`,
    ) as unknown as HTMLElement | null;
    expect(badge?.getAttribute("data-integration-state")).toBe("unknown");
  }
  // The keys row says the same thing in credential words: a failed read is
  // "unavailable", never "no keys issued".
  const keysRow = container.querySelector(".integration-api-keys-row") as unknown as HTMLElement | null;
  expect(keysRow?.getAttribute("data-key-state")).toBe("unavailable");
  // The file client still reports its real state.
  const hermes = container.querySelector(
    ".integration-card[data-client='hermes'] .badge",
  ) as unknown as HTMLElement | null;
  expect(hermes?.getAttribute("data-integration-state")).toBe("current");
});

test("a loopback-only refusal is localized, not the server's English message", async () => {
  /*
   * Pi, Kimi and Gajae have nowhere to put the admission header a remote bind
   * needs, so applying one against a non-loopback bind refuses. The writer's
   * `message` is English prose written for a server log, and every other
   * refusal deliberately passes it through — it names the user's own file.
   * This one carries no per-file detail, so a Korean or Japanese user was
   * reading English for a fixed policy explanation.
   */
  const { describeRefusal } = await import("../src/pages/integrations/refusal-copy");
  const { IntegrationApiError } = await import("../src/pages/integrations/integration-api");
  const { DICTS } = await import("../src/i18n/shared");

  const serverEnglish = "kimi has nowhere to put the admission header a non-loopback bind requires";
  const refusal = new IntegrationApiError(500, {
    error: "integration mutation failed",
    code: "integration_mutation_failed",
    clientId: "kimi",
    state: "absent",
    reason: "non_loopback",
    message: serverEnglish,
  });

  for (const locale of ["ko", "ja", "de", "zh", "ru"] as const) {
    const dict = DICTS[locale];
    const t = ((key: string, vars?: Record<string, string>) => {
      let text = (dict as Record<string, string>)[key] ?? key;
      for (const [name, value] of Object.entries(vars ?? {})) {
        text = text.replaceAll(`{${name}}`, value);
      }
      return text;
    }) as Parameters<typeof describeRefusal>[0];

    const shown = describeRefusal(t, refusal);
    // The localized sentence replaces the English one rather than sitting
    // beside it — the formatter's `message ||` short-circuit meant a mapped
    // key alone would never have evaluated.
    expect(shown).not.toContain(serverEnglish);
    expect(shown).toBe((dict as Record<string, string>)["integrations.error.nonLoopback"]!.replaceAll("{client}", "kimi"));
  }

  // English still reads naturally, and still names the client.
  const english = describeRefusal(((key: string, vars?: Record<string, string>) => {
    let text = (DICTS.en as Record<string, string>)[key] ?? key;
    for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, value);
    return text;
  }) as Parameters<typeof describeRefusal>[0], refusal);
  expect(english).toContain("kimi");
});
