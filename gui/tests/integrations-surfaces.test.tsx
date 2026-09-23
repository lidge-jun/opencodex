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
type RecordedRequest = { url: string; method: string; body: unknown };

let requests: RecordedRequest[] = [];
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
  deletable?: boolean;
};

let stateResponse: () => Response;
let journalRows: JournalRow[];
let putResponse: (request: RecordedRequest) => Response;
let codexRoutingResponse: () => Response;
let codexDesiredEnabled = true;
let deleteResponse: () => Response;
let previewResponse: (body: Record<string, unknown>, signal?: AbortSignal | null) => Response | Promise<Response>;
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

function asideStatus(overrides: Record<string, unknown> = {}) {
  return status({ clientId: "aside", configPath: "/tmp/aside/profiles.json", ...overrides });
}

function previewPlan(operation: "apply" | "overwrite" | "disable" | "restore", overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientId: "hermes",
    operation,
    state: operation === "apply" ? "absent" : "current",
    foreignEdit: "none",
    changes: operation === "disable"
      ? [{ kind: "remove", path: "providers.opencodex" }, { kind: "snapshot", path: "$snapshot" }, { kind: "ownership", path: "$ownership" }, { kind: "journal", path: "$journal" }]
      : [{ kind: "replace", path: "providers.opencodex" }, { kind: "snapshot", path: "$snapshot" }, { kind: "ownership", path: "$ownership" }, { kind: "journal", path: "$journal" }],
    fingerprint: `p1:${({ apply: "1", overwrite: "2", disable: "3", restore: "4" } as const)[operation].repeat(32)}`,
    canApply: true,
    willChange: true,
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
  codexRoutingResponse = () => json({ routingInjected: false, status: "native", recommendedCommand: null });
  codexDesiredEnabled = true;
  deleteResponse = () => json({ ok: true, clientId: "hermes", opId: "op-old", snapshotRemoved: true });
  previewResponse = body => {
    const clientId = body.clientId ?? "hermes";
    return json(previewPlan((body.operation as "apply" | "overwrite" | "disable") ?? "apply", {
      clientId,
      ...(clientId === "pi" ? { fingerprint: `p1:${"5".repeat(32)}` } : {}),
    }));
  };
  failExtraSources = false;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const request = {
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    if (url.endsWith("/api/client-integrations/restore/preview")) return json(previewPlan("restore"));
    if (url.endsWith("/api/client-integrations/preview")) {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      return previewResponse(body, init?.signal);
    }
    if (url.includes("/journal") && method === "DELETE") return deleteResponse();
    if (url.includes("/journal")) return json({ operations: journalRows });
    if (url.includes("/api/startup-health")) {
      return failExtraSources
        ? json({ error: "nope" }, 500)
        : codexRoutingResponse();
    }
    if (url.includes("/api/keys")) {
      return failExtraSources ? json({ error: "nope" }, 500) : json({ keys: [] });
    }
    if (url.includes("/api/claude-desktop/status")) {
      return failExtraSources
        ? json({ error: "nope" }, 500)
        : json({ desiredEnabled: true, installed: true, observedKind: "standard", applied: false, stale: false, activeProfile: null, appliedAt: null });
    }
    if (method === "PUT" && url.endsWith("/api/native-integrations/codex")) {
      const body = init?.body ? JSON.parse(String(init.body)) as { enabled?: unknown } : {};
      codexDesiredEnabled = body.enabled === true;
      codexRoutingResponse = () => json({
        routingInjected: codexDesiredEnabled,
        status: "native",
        recommendedCommand: null,
      });
      return json({
        ok: true,
        clientId: "codex",
        changed: true,
        state: codexDesiredEnabled ? "current" : "absent",
        message: codexDesiredEnabled ? "enabled" : "disabled",
        desiredEnabled: codexDesiredEnabled,
      });
    }
    if (method === "GET" && url.includes("/api/native-integrations")) {
      return failExtraSources
        ? json({ error: "nope" }, 500)
        : json({ clients: [{
          clientId: "codex",
          state: codexDesiredEnabled ? "current" : "absent",
          installed: true,
          configPath: "/tmp/codex/config.toml",
          desiredEnabled: codexDesiredEnabled,
          disableBlocked: null,
        }, {
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
    if (method === "PUT") return putResponse(request);
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
  // The tab strip ran out of room, so the tab and the page heading both read the short
  // form; the full product name still lives on the API Keys page (api.clientConfig.clientDsh).
  expect(text).toContain("DSH");
  expect(text).not.toContain("DeepSeek Harness (DSH)");
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

async function confirmDialog(label: string): Promise<void> {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
  const dialog = container.querySelector("dialog[open]")!;
  const confirm = Array.from(dialog.querySelectorAll("button")).find(
    button => (button.textContent ?? "").trim() === label,
  ) as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
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
  await confirmDialog("Disable");

  const put = requests.find(request => request.method === "PUT");
  expect(put?.body).toEqual({ enabled: false, operation: "disable", planFingerprint: previewPlan("disable").fingerprint });
});

test("updating a stale block is a separate action from the switch", async () => {
  stateResponse = () => json(status({ state: "stale" }));
  await mountClient();

  const update = buttonByText("Update");
  expect(update).toBeDefined();
  await act(async () => { update!.click(); });
  await confirmDialog("Apply");
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({ enabled: true, operation: "apply", planFingerprint: previewPlan("apply").fingerprint });
});

test("an absent integration applies", async () => {
  stateResponse = () => json(status({ state: "absent" }));
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  await confirmDialog("Apply");
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({ enabled: true, operation: "apply", planFingerprint: previewPlan("apply").fingerprint });
});

test("a hostile preview fails closed without leaking payload data into the page", async () => {
  const canary = "private-preview-canary-9f31";
  stateResponse = () => json(status({ state: "absent" }));
  previewResponse = body => json({
    ...previewPlan("apply", { clientId: body.clientId ?? "hermes" }),
    rawValue: canary,
    message: canary,
  });
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  expect(container.textContent).toContain("The change plan could not be loaded. Nothing was changed.");
  expect(container.textContent).not.toContain(canary);
  expect(requests.some(request => request.method === "PUT")).toBe(false);
});

test("closing a loading preview aborts it and fences a late response", async () => {
  stateResponse = () => json(status({ state: "absent" }));
  let previewSignal: AbortSignal | null | undefined;
  let resolvePreview: ((response: Response) => void) | undefined;
  previewResponse = (_body, signal) => {
    previewSignal = signal;
    return new Promise<Response>(resolve => { resolvePreview = resolve; });
  };
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  const dialog = container.querySelector("dialog[open]")!;
  const close = Array.from(dialog.querySelectorAll("button")).find(button => button.textContent?.trim() === "Close") as HTMLButtonElement;
  expect(close.disabled).toBe(false);
  await act(async () => { close.click(); });
  expect(previewSignal?.aborted).toBe(true);
  expect(container.querySelector("dialog[open]")).toBeNull();

  await act(async () => {
    resolvePreview!(json(previewPlan("apply")));
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  });
  expect(container.querySelector("dialog[open]")).toBeNull();
  expect(container.textContent).not.toContain("Server change plan");
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
  expect(put?.body).toEqual({ enabled: true, overwriteConflict: true, operation: "overwrite", planFingerprint: previewPlan("overwrite").fingerprint });
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

test("the client page reconciles a journal row another tab already deleted", async () => {
  journalRows = [{
    opId: "op-stale",
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-02T08:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "expired",
    undoable: false,
    deletable: true,
  }];
  deleteResponse = () => {
    journalRows = [];
    return json({
      error: "integration operation not found",
      code: "integration_operation_not_found",
      opId: "op-stale",
    }, 404);
  };
  await mountClient();

  await act(async () => { buttonByText("Delete")!.click(); });
  expect(container.querySelector(".integration-consequence-dialog")).not.toBeNull();
  await act(async () => { buttonByText("Delete entry")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });

  expect(container.querySelector(".integration-consequence-dialog")).toBeNull();
  expect(buttonByText("Delete")).toBeUndefined();
  expect(requests.filter(request => request.method === "DELETE")).toHaveLength(1);
  expect(requests.filter(request => request.method === "GET" && request.url.includes("/journal")).length).toBeGreaterThanOrEqual(2);
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
  await confirmDialog("Disable");
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
  await confirmDialog("Disable");
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

test("the overview reconciles a journal row another tab already deleted", async () => {
  stateResponse = () => json({ clients: [status()] });
  journalRows = [{
    opId: "op-stale-overview",
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-02T08:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "expired",
    undoable: false,
    deletable: true,
  }];
  deleteResponse = () => {
    journalRows = [];
    return json({
      error: "integration operation not found",
      code: "integration_operation_not_found",
      opId: "op-stale-overview",
    }, 404);
  };
  await mountOverview();

  await act(async () => { buttonByText("Delete")!.click(); });
  expect(container.querySelector(".integration-consequence-dialog")).not.toBeNull();
  await act(async () => { buttonByText("Delete entry")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });

  expect(container.querySelector(".integration-consequence-dialog")).toBeNull();
  expect(buttonByText("Delete")).toBeUndefined();
  expect(requests.filter(request => request.method === "DELETE")).toHaveLength(1);
  expect(requests.filter(request => request.method === "GET" && request.url.includes("/journal")).length).toBeGreaterThanOrEqual(2);
});

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

test("a failed first read does not claim nothing is installed either", async () => {
  /*
   * A failed-cold read carries no data, so it is not an answer: the error
   * notice must stand alone, without the "nothing detected" panel, and the
   * file clients stay as unknown rows rather than a server-side omission.
   */
  stateResponse = () => json({ error: "nope" }, 500);
  await mountOverview();

  const text = container.textContent ?? "";
  expect(text).toContain("Could not load integration state.");
  expect(text).not.toContain("No installed clients were detected");
  expect(text).toContain("Hermes");
});

test("the aggregate Aside overview toggle stays unbound", async () => {
  let applied = true;
  stateResponse = () => json({ clients: [asideStatus({ state: applied ? "current" : "absent" })] });
  previewResponse = body => body.clientId === "aside"
    ? json({ error: "aggregate Aside previews require a profile", code: "invalid_aside_profile" }, 400)
    : json(previewPlan("disable", { clientId: body.clientId }));
  putResponse = request => {
    const body = request.body as Record<string, unknown>;
    if (body.operation !== undefined || body.planFingerprint !== undefined) {
      return json({ error: "a confirmed plan applies to one profile", code: "invalid_aside_profile" }, 400);
    }
    applied = body.enabled === true;
    return json({ ok: true, results: [{ profileId: 7, ok: true, state: applied ? "current" : "absent" }] });
  };

  await mountOverview();
  await act(async () => { switchFor("aside")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });

  expect(requests.filter(request => request.url.endsWith("/api/client-integrations/preview"))).toHaveLength(0);
  const puts = requests.filter(request => request.method === "PUT" && request.url.endsWith("/api/client-integrations/aside/profiles"));
  expect(puts).toHaveLength(1);
  expect(puts[0]?.body).toEqual({ enabled: false });
});

test("aggregate Aside overview failures stay on the card without an unhandled rejection", async () => {
  stateResponse = () => json({ clients: [asideStatus()] });
  putResponse = request => {
    const body = request.body as Record<string, unknown>;
    if (body.operation !== undefined || body.planFingerprint !== undefined) {
      return json({ error: "a confirmed plan applies to one profile", code: "invalid_aside_profile" }, 400);
    }
    return json({
      ok: false,
      message: "one profile failed",
      results: [{ profileId: 7, ok: false, reason: "write_failed", message: "disk full" }],
    }, 207);
  };
  let unhandled = 0;
  testWindow.addEventListener("unhandledrejection", () => { unhandled += 1; });

  await mountOverview();
  await act(async () => { switchFor("aside")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });

  const card = container.querySelector('[data-client="aside"]')!;
  expect(card.querySelectorAll(".notice-err")).toHaveLength(1);
  expect(card.textContent).toContain("disk full");
  expect(switchFor("aside")?.disabled).toBe(false);
  expect(unhandled).toBe(0);

  await act(async () => { switchFor("aside")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });
  expect(requests.filter(request => request.method === "PUT" && request.url.endsWith("/api/client-integrations/aside/profiles"))).toHaveLength(2);
  expect(unhandled).toBe(0);
});

test("Aside-only and mixed bulk disable keep aggregate Aside unbound", async () => {
  let clients = [asideStatus()];
  stateResponse = () => json({ clients });
  previewResponse = body => body.clientId === "aside"
    ? json({ error: "aggregate Aside previews require a profile", code: "invalid_aside_profile" }, 400)
    : json(previewPlan("disable", {
        clientId: body.clientId,
        fingerprint: body.clientId === "pi" ? `p1:${"5".repeat(32)}` : `p1:${"3".repeat(32)}`,
      }));
  putResponse = request => {
    const body = request.body as Record<string, unknown>;
    if (request.url.endsWith("/api/client-integrations/aside/profiles")) {
      if (body.operation !== undefined || body.planFingerprint !== undefined) {
        return json({ error: "a confirmed plan applies to one profile", code: "invalid_aside_profile" }, 400);
      }
      clients = clients.filter(client => client.clientId !== "aside");
      return json({ ok: true, results: [{ profileId: 7, ok: true, state: "absent" }] });
    }
    clients = clients.filter(client => client.clientId !== "pi");
    return json({ ok: true, clientId: "pi", changed: true, state: "absent", message: "disabled" });
  };

  await mountOverview();
  await act(async () => { buttonByText("Disable all…")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  expect(buttonByText("Disable all")?.disabled).toBe(false);
  await act(async () => { buttonByText("Disable all")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });
  expect(requests.filter(request => request.url.endsWith("/api/client-integrations/preview"))).toHaveLength(0);
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({ enabled: false });

  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  mountCount += 1;
  apiBase = `http://ocx-test-${mountCount}.invalid`;
  requests = [];
  clients = [asideStatus(), status({ clientId: "pi", configPath: "/tmp/pi.json" })];
  await mountOverview();
  await act(async () => { buttonByText("Disable all…")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  await act(async () => { buttonByText("Disable all")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });

  expect(requests.filter(request => request.url.endsWith("/api/client-integrations/preview")).map(request => request.body)).toEqual([
    { clientId: "pi", operation: "disable" },
  ]);
  expect(requests.filter(request => request.method === "PUT").map(request => request.body)).toEqual([
    { enabled: false },
    { enabled: false, operation: "disable", planFingerprint: `p1:${"5".repeat(32)}` },
  ]);
});

test("bulk confirmation is disabled when every planned target is refused", async () => {
  stateResponse = () => json({ clients: [status()] });
  previewResponse = body => json(previewPlan("disable", {
    clientId: body.clientId,
    canApply: false,
    willChange: false,
    changes: [],
    refusalReason: "unsafe",
  }));
  await mountOverview();
  await act(async () => { buttonByText("Disable all…")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });

  expect(buttonByText("Disable all")?.disabled).toBe(true);
  expect(requests.filter(request => request.method === "PUT")).toHaveLength(0);
});

test("bulk stale plans require reconfirmation without repeating completed disables", async () => {
  const applied = new Set(["hermes", "pi", "dsh"]);
  stateResponse = () => json({ clients: [
    status({ clientId: "hermes", state: applied.has("hermes") ? "current" : "absent" }),
    status({ clientId: "pi", configPath: "/tmp/pi.json", state: applied.has("pi") ? "current" : "absent" }),
    status({ clientId: "dsh", configPath: "/tmp/dsh.yaml", state: applied.has("dsh") ? "current" : "absent" }),
  ] });
  previewResponse = body => json(previewPlan("disable", {
    clientId: body.clientId,
    fingerprint: `p1:${body.clientId === "pi" ? "5".repeat(32) : body.clientId === "dsh" ? "6".repeat(32) : "3".repeat(32)}`,
    ...(body.clientId === "dsh" ? { canApply: false, willChange: false, changes: [], refusalReason: "unsafe" } : {}),
  }));
  let piAttempts = 0;
  putResponse = request => {
    const clientId = request.url.split("/").pop()!;
    if (clientId === "pi" && piAttempts++ === 0) {
      return json({
        code: "integration_preview_stale",
        plan: previewPlan("disable", { clientId: "pi", fingerprint: `p1:${"9".repeat(32)}` }),
      }, 409);
    }
    applied.delete(clientId);
    return json({ ok: true, clientId, changed: true, state: "absent", message: "disabled" });
  };

  await mountOverview();
  await act(async () => { buttonByText("Disable all…")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  await act(async () => { buttonByText("Disable all")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });

  expect(container.textContent).toContain("Review the updated plan");
  expect(requests.filter(request => request.method === "PUT" && request.url.endsWith("/hermes"))).toHaveLength(1);
  expect(requests.filter(request => request.method === "PUT" && request.url.endsWith("/pi"))).toHaveLength(1);
  expect(requests.filter(request => request.method === "PUT" && request.url.endsWith("/dsh"))).toHaveLength(0);

  const staleDialog = container.querySelector("dialog")!;
  const reconfirm = Array.from(staleDialog.querySelectorAll("button")).find(
    button => (button.textContent ?? "").trim() === "Disable all",
  ) as HTMLButtonElement;
  const close = Array.from(staleDialog.querySelectorAll("button")).find(
    button => (button.textContent ?? "").trim() === "Close",
  ) as HTMLButtonElement;
  expect(staleDialog.getAttribute("aria-busy")).toBe("false");
  expect(reconfirm.disabled).toBe(false);
  expect(close.disabled).toBe(false);

  await act(async () => { reconfirm.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });
  const hermesPuts = requests.filter(request => request.method === "PUT" && request.url.endsWith("/hermes"));
  const piPuts = requests.filter(request => request.method === "PUT" && request.url.endsWith("/pi"));
  expect(hermesPuts).toHaveLength(1);
  expect(piPuts).toHaveLength(2);
  expect(piPuts[1]?.body).toEqual({ enabled: false, operation: "disable", planFingerprint: `p1:${"9".repeat(32)}` });
  expect(container.querySelector("dialog")).toBeNull();
  expect(container.textContent).toContain("dsh");
});

test("overview stale replacement does not persist a card failure", async () => {
  stateResponse = () => json({ clients: [status()] });
  putResponse = () => json({
    code: "integration_preview_stale",
    plan: previewPlan("disable", { fingerprint: `p1:${"9".repeat(32)}` }),
  }, 409);
  await mountOverview();
  await act(async () => { switchFor("hermes")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  await confirmDialog("Disable");
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });

  expect(container.querySelector('[data-client="hermes"] .notice')).toBeNull();
  expect(container.querySelector("dialog")?.textContent).toContain("Review the updated plan");
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
    if (url.endsWith("/api/client-integrations/preview")) return json(previewPlan("disable"));
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
  await act(async () => { buttonByText("Disable all")!.click(); });
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
    if (url.endsWith("/api/client-integrations/preview")) return json(previewPlan("disable"));
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
  await act(async () => { buttonByText("Disable all")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });

  const text = container.textContent ?? "";
  expect(text).toContain("Applied client integrations were disabled.");
  expect(text).not.toContain("may be stale");
});

test("bulk disable keeps one preview fingerprint per client", async () => {
  stateResponse = () => json({ clients: [
    status({ clientId: "hermes", configPath: "/tmp/hermes.yaml" }),
    status({ clientId: "pi", configPath: "/tmp/pi.json" }),
  ] });
  await mountOverview();
  await act(async () => { buttonByText("Disable all…")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
  await act(async () => { buttonByText("Disable all")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 40)); });

  const previews = requests.filter(request => request.url.endsWith("/api/client-integrations/preview"));
  expect(previews.map(request => request.body)).toEqual([
    { clientId: "hermes", operation: "disable" },
    { clientId: "pi", operation: "disable" },
  ]);
  const puts = requests.filter(request => request.method === "PUT");
  expect(puts.map(request => request.body)).toEqual([
    { enabled: false, operation: "disable", planFingerprint: previewPlan("disable").fingerprint },
    { enabled: false, operation: "disable", planFingerprint: `p1:${"5".repeat(32)}` },
  ]);
});

test("a drifted restore previews confirmation before its first mutation", async () => {
  /*
   * The server refuses a drifted restore unless `confirmDrift` is set. That
   * refusal is the only moment the user is told their newer edits are about to
   * be replaced, so it must escalate the dialog rather than surface as an error.
   */
  const posts: unknown[] = [];
  const restoreFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    posts.push(body);
    if (String(input).endsWith("/restore/preview")) {
      const confirmed = (body as { confirmDrift?: boolean })?.confirmDrift === true;
      return json(previewPlan("restore", confirmed ? { foreignEdit: "drift", fingerprint: `p1:${"7".repeat(32)}` } : {
        foreignEdit: "drift", canApply: false, willChange: false, changes: [], refusalReason: "drift_requires_confirm",
        fingerprint: `p1:${"6".repeat(32)}`,
      }));
    }
    if ((body as { confirmDrift?: boolean })?.confirmDrift) {
      return json({ ok: true, clientId: "hermes", changed: true, state: "current", message: "restored" });
    }
    return json({ error: "unexpected unconfirmed restore" }, 409);
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

  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  // Both preview calls happen before the first mutation.
  expect((posts[0] as { confirmDrift?: boolean }).confirmDrift).toBe(false);
  expect((posts[1] as { confirmDrift?: boolean }).confirmDrift).toBe(true);
  expect(container.textContent ?? "").toContain("Newer edits were detected");

  const confirm = buttonByText("Back up newer edits and restore");
  expect(confirm).toBeDefined();
  await act(async () => { confirm!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });
  expect((posts[2] as { confirmDrift?: boolean }).confirmDrift).toBe(true);
  expect((posts[2] as { planFingerprint?: string }).planFingerprint).toBe(`p1:${"7".repeat(32)}`);
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
    if (String(input).endsWith("/restore/preview")) return Promise.resolve(json(previewPlan("restore")));
    if (String(input).endsWith("/restore")) {
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

  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });
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
  await act(async () => { buttonByText("Disable")!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  const put = requests.find(request => request.method === "PUT");
  expect(put?.url).toContain("/api/client-integrations/hermes");
  expect(put?.body).toEqual({ enabled: false, operation: "disable", planFingerprint: previewPlan("disable").fingerprint });
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

test("Codex disable uses Codex consequences and refreshes observed routing", async () => {
  codexRoutingResponse = () => json({ routingInjected: true, status: "native", recommendedCommand: null });
  await mountOverview();

  const sw = switchFor("codex");
  expect(sw?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { sw!.click(); });

  // Opening the consequence gate must not mutate anything, and it must name
  // the Codex file and the effects of restoring native Codex.
  expect(requests.some(request => request.method === "PUT")).toBe(false);
  const dialog = container.querySelector(".integration-consequence-dialog")!;
  expect(dialog.textContent).toContain("Disable the Codex integration?");
  expect(dialog.textContent).toContain("/tmp/codex/config.toml");
  expect(dialog.textContent).toContain("/v1/responses");
  expect(dialog.textContent).not.toContain("Grok Build");

  const confirm = Array.from(dialog.querySelectorAll("button")).find(
    button => (button.textContent ?? "").trim() === "Disable",
  ) as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 50)); });

  const put = requests.find(request => request.method === "PUT");
  expect(put?.url).toContain("/api/native-integrations/codex");
  expect(put?.body).toEqual({ enabled: false });
  // The mock changes startup-health only after the mutation. This assertion
  // therefore proves the Codex observed resource, not merely the native toggle,
  // was refreshed.
  expect(switchFor("codex")?.getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector(".integration-card[data-client='codex'] .badge")
    ?.getAttribute("data-integration-state")).toBe("absent");
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
