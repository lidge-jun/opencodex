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

/**
 * Mount again inside ONE test, against a fresh fixture.
 *
 * `useDataSurface` caches by `apiBase`, so a second mount on the same base
 * replays the first response and the new `stateResponse` has no effect. Rotating
 * the base is what makes a state sweep in a single test possible at all.
 */
async function remountClient(client: "hermes" | "dsh" = "hermes"): Promise<void> {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  mountCount += 1;
  apiBase = `http://ocx-test-${mountCount}.invalid`;
  await mountClient(true, client);
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

/*
 * The overwrite escape hatch.
 *
 * Conflict was a dead end before it existed: the switch locks and the only way
 * forward was hand-editing the file. These pin the two halves of the deal --
 * the button appears for exactly one state, and it costs a confirmation.
 */
test("a conflict offers an overwrite, and no other state does", async () => {
  for (const state of ["absent", "current", "stale", "unsafe"] as const) {
    stateResponse = () => json(status({ state }));
    await remountClient();
    expect(buttonByText("Replace")).toBeUndefined();
  }

  stateResponse = () => json(status({ state: "conflict", reason: "unowned-key" }));
  await remountClient();
  expect(buttonByText("Replace")).toBeDefined();
});

test("a client with no config on disk is never offered an overwrite", async () => {
  // installed:false means there is nothing to replace; the server refuses it as
  // not_installed, so offering the button would only produce an error dialog.
  stateResponse = () => json(status({ state: "conflict", reason: "unowned-key", installed: false }));
  await mountClient();
  expect(buttonByText("Replace")).toBeUndefined();
});

test("the overwrite button mutates nothing until the dialog is confirmed", async () => {
  stateResponse = () => json(status({ state: "conflict", reason: "unowned-key" }));
  await mountClient();

  await act(async () => { buttonByText("Replace")!.click(); });
  // Opening the dialog is not the operation.
  expect(requests.some(request => request.method === "PUT")).toBe(false);

  // The dialog names the file the user is about to lose a block from, and says
  // the change is recoverable.
  const dialog = container.querySelector(".integration-consequence-dialog")!;
  expect(dialog.textContent).toContain("/tmp/home/.hermes/config.yaml");
  expect(dialog.textContent).toContain("rollback list");

  const confirm = Array.from(dialog.querySelectorAll("button")).find(
    button => (button.textContent ?? "").trim() === "Replace",
  ) as HTMLButtonElement;
  await act(async () => { confirm.click(); });

  const put = requests.find(request => request.method === "PUT");
  expect(put?.body).toEqual({ enabled: true, overwriteConflict: true });
});

test("a foreign edit and an unowned block get different dialog copy", async () => {
  stateResponse = () => json(status({ state: "conflict", reason: "foreign-edit" }));
  await remountClient();
  await act(async () => { buttonByText("Replace")!.click(); });
  // The user's own edit is what is discarded, and the copy has to say so.
  expect(container.querySelector(".integration-consequence-dialog")!.textContent)
    .toContain("Your edit inside the opencodex block");

  stateResponse = () => json(status({ state: "conflict", reason: "unowned-key" }));
  await remountClient();
  await act(async () => { buttonByText("Replace")!.click(); });
  expect(container.querySelector(".integration-consequence-dialog")!.textContent)
    .toContain("A block we did not write");
});

test("the dialog's config path can break mid-string, so it cannot overflow a phone", async () => {
  /*
   * The dialog is 370px wide at a 390px viewport and the path it names is a long
   * unbroken token -- a real one is `~/.zcode/v2/config.json` and worse. Without a
   * break opportunity inside the word that token overflows its own container,
   * which is how the one piece of information the user needs (WHICH file) ends up
   * off screen.
   *
   * happy-dom does no layout, so measured geometry is not available here; what is
   * checkable is that the path renders inside an element the stylesheet allows to
   * break. Rendered geometry was measured separately at 390px in both themes
   * (dialog 370px wide at left:10, code element 212px, no overflow).
   */
  // A synthetic home, not a real one: privacy:scan rejects a committed /Users/<name>/.
  const longPath = "/home/dev/Library/Application Support/SomeVendor/deeply/nested/config.json";
  stateResponse = () => json(status({
    state: "conflict",
    reason: "unowned-key",
    configPath: longPath,
  }));
  await remountClient();
  await act(async () => { buttonByText("Replace")!.click(); });

  const dialog = container.querySelector(".integration-consequence-dialog")!;
  const code = dialog.querySelector("code");
  // A <code> element, not bare text: `.integration-consequence-body code` is what
  // carries `overflow-wrap: anywhere`.
  expect(code).not.toBeNull();
  expect(code!.textContent).toBe(longPath);
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

/**
 * #3059: a successful restore starts an asynchronous history refresh before closing
 * the dialog. That means normal focus restoration first finds the trigger still in
 * the tree, and only later does the refresh consume its snapshot and remove the
 * trigger. The region must receive focus on the successful close, before that later
 * removal can send focus to <body>.
 */
test("a successful restore keeps focus on the stable region after refresh removes its trigger", async () => {
  const [{ createRoot }, { LanguageProvider }, { default: RestoreDialog }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/RestoreDialog"),
  ]);

  // The shape RollbackHistory renders: a stable region holding the row trigger.
  const region = testWindow.document.createElement("section");
  const trigger = testWindow.document.createElement("button");
  region.appendChild(trigger);
  testWindow.document.body.appendChild(region);
  trigger.focus();
  expect(testWindow.document.activeElement).toBe(trigger);

  const row = {
    opId: "op-consumed",
    clientId: "hermes" as const,
    kind: "apply" as const,
    at: "2026-08-02T09:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored" as const,
    undoable: false,
  };
  let resolveRestore: ((response: Response) => void) | undefined;
  const restoreFetch = ((input: RequestInfo | URL) => {
    if (String(input).includes("/restore")) {
      return new Promise<Response>(resolve => { resolveRestore = resolve; });
    }
    return Promise.resolve(json({ operations: [] }));
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: restoreFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: restoreFetch });

  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <RestoreDialog
          apiBase={apiBase}
          row={row}
          onRestored={() => {}}
          onClose={() => {
            root!.unmount();
            root = null;
          }}
        />
      </LanguageProvider>,
    );
  });

  await act(async () => { buttonByText("Restore")!.click(); });
  expect(resolveRestore).toBeDefined();

  // Restore succeeds and closes while the trigger is still connected.
  await act(async () => { resolveRestore!(json({ ok: true })); });
  expect(trigger.isConnected).toBe(true);
  expect(testWindow.document.activeElement).toBe(region);

  // The asynchronous history refresh then consumes the snapshot and its trigger.
  trigger.remove();
  expect(testWindow.document.activeElement).toBe(region);
  expect(testWindow.document.activeElement).not.toBe(testWindow.document.body);
  region.remove();
});

test("focus returns to the trigger itself when it survived", async () => {
  const [{ createRoot }, { LanguageProvider }, { default: RestoreDialog }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/RestoreDialog"),
  ]);

  const region = testWindow.document.createElement("section");
  const trigger = testWindow.document.createElement("button");
  region.appendChild(trigger);
  testWindow.document.body.appendChild(region);
  trigger.focus();

  const row = {
    opId: "op-kept",
    clientId: "hermes" as const,
    kind: "apply" as const,
    at: "2026-08-02T09:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored" as const,
    undoable: true,
  };
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <RestoreDialog apiBase={apiBase} row={row} onClose={() => {}} onRestored={() => {}} />
      </LanguageProvider>,
    );
  });
  await act(async () => { root!.unmount(); root = null; });

  // The fallback must not preempt a trigger that is still there.
  expect(testWindow.document.activeElement).toBe(trigger);
  region.remove();
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
test("a populated overview journal collapses instead of flooding the page", async () => {
  /*
   * The overview already carries a summary strip, a credential row and fifteen
   * cards. It also rendered every row the journal returned — up to the route's
   * fifty — as individually bordered strips below them, which is what buried
   * the one control a user reaches for after a mistake.
   */
  journalRows = Array.from({ length: 30 }, (_, index) => ({
    opId: `op-${index}`,
    clientId: "hermes",
    kind: "apply" as const,
    at: new Date(Date.UTC(2026, 7, 31, 10, 0, 0) - index * 60_000).toISOString(),
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored" as const,
    undoable: index === 0,
  }));
  await mountOverview();

  const outside = Array.from(container.querySelectorAll(".integration-history-row"))
    .filter(node => !(node as unknown as HTMLElement).closest(".integration-history-older"));
  expect(outside).toHaveLength(1);
  // The newest operation's Undo stays a click away, not a disclosure away.
  expect(buttonByText("Undo")).toBeDefined();
  const details = container.querySelector(".integration-history-older") as unknown as HTMLDetailsElement;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  // The cross-client chronology is still THERE, just folded.
  await act(async () => { details.open = true; });
  expect(container.querySelectorAll(".integration-history-older .integration-history-row").length).toBeGreaterThan(1);
});

/*
 * Adding a file client means editing three hand-maintained lists that no type
 * relates to each other: CLIENTS in client-config-clients.ts, INTEGRATION_TABS,
 * and FILE_CLIENTS. Miss one and the client half-ships -- it exports from the
 * API tab but has no Integrations tab to toggle from, or it owns a tab that
 * renders a page for a client the file surface does not recognize. Both compile,
 * and both look complete from whichever half you happen to open.
 *
 * Aside is the reason this exists: it needed all three, and nothing would have
 * failed if it had landed in two.
 */
test("every export client has both an Integrations tab and a file-surface entry", async () => {
  const { CLIENTS } = await import("../src/components/apikeys-workspace/client-config-clients");
  const { TABS, FILE_CLIENTS } = await import("../src/pages/integrations/integration-tabs");

  const tabIds = new Set(TABS.map(tab => tab.id as string));
  const missing = CLIENTS.filter(id => !tabIds.has(id) || !FILE_CLIENTS.has(id as never));
  expect(missing).toEqual([]);

  // And no tab claims a client that does not exist, which would render a page
  // for an id the config surface cannot answer for.
  const clientIds = new Set<string>(CLIENTS);
  const orphaned = [...FILE_CLIENTS].filter(id => !clientIds.has(id));
  expect(orphaned).toEqual([]);
});

/*
 * The mark has to reach every surface, not just the API tab it started on. Three
 * of them are checked here; the fourth is client-config-panel.test.tsx.
 *
 * These assert on the rendered DOM rather than on the map, because the map being
 * right and the component never being called is exactly the failure a map-only
 * test cannot see -- and it is the failure that would ship, since the marks were
 * correct in data long before any surface drew them.
 */
test("a client page header draws its client's mark", async () => {
  stateResponse = () => json(status({
    clientId: "dsh",
    configPath: "/tmp/home/.dsh/settings.yaml",
  }));
  await mountClient(true, "dsh");

  const head = container.querySelector(".integration-client-head")!;
  const mark = head.querySelector<HTMLElement>(".client-mark");
  expect(mark, "the client page header should carry a mark").not.toBeNull();
  // dsh is single-ink but its ink is DeepSeek blue, so it renders as an image.
  expect(mark!.querySelector("img")?.getAttribute("src")).toBe("/provider-icons/deepseek-harness.svg");
  // Decoration beside a heading that already names the client.
  expect(mark!.getAttribute("aria-hidden")).toBe("true");
});

test("every overview card draws a mark, and none of them names itself", async () => {
  await mountOverview();

  const cards = [...container.querySelectorAll(".integration-card")];
  expect(cards.length).toBeGreaterThan(4);
  const bare = cards
    .filter(card => card.querySelector(".client-mark") === null)
    .map(card => card.getAttribute("data-client"));
  expect(bare).toEqual([]);

  // A mark next to a visible label must not join the accessible name, or a
  // screen reader says the client twice.
  for (const mark of container.querySelectorAll(".client-mark")) {
    expect(mark.getAttribute("aria-hidden")).toBe("true");
  }
  for (const img of container.querySelectorAll(".client-mark img")) {
    expect(img.getAttribute("alt")).toBe("");
  }

  // The card head is space-between; the mark must sit with the title rather than
  // after the badge, so it is the first child.
  const head = cards[0]!.querySelector(".integration-card-head")!;
  expect(head.firstElementChild?.classList.contains("client-mark")).toBe(true);
});

test("the tab strip marks every client tab and leaves the two non-client tabs bare", async () => {
  const [{ createRoot }, { LanguageProvider }, { default: Integrations }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/Integrations"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Integrations apiBase={apiBase} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });

  const tabs = [...container.querySelectorAll<HTMLElement>(".page-tab")];
  expect(tabs.length).toBeGreaterThan(10);
  const marked = tabs.filter(tab => tab.querySelector(".client-mark") !== null);
  // overview and keys carry no client, so they carry no mark.
  expect(tabs.length - marked.length).toBe(2);

  const codexTab = tabs.find(tab => tab.id === "integrations-tab-codex")!;
  expect(codexTab.querySelector(".client-mark img")?.getAttribute("src")).toBe("/provider-icons/openai.svg");
  // The label lost its "CLI": the mark carries that identity now, and the row
  // covers the app and SDK too.
  expect(codexTab.textContent).toBe("Codex");
});
