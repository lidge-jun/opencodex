import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AsideProfileList, AsideProfileState } from "../../src/integrations/aside-profiles";
import type { IntegrationJournalRow } from "../src/pages/integrations/integration-api";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT",
] as const;
const apiBase = "http://aside-profiles-test.invalid";
const profilesPath = "/api/client-integrations/aside/profiles";
const syncPath = "/api/client-integrations/aside/sync";
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
type RequestRecord = { path: string; method: string; body: unknown };
let requests: RequestRecord[];
let profiles: AsideProfileState[];
let journal: IntegrationJournalRow[];
let listResponse: () => Response;
let mutationResponse: (request: RequestRecord) => Response;

function profile(profileId: number, overrides: Partial<AsideProfileState> = {}): AsideProfileState {
  return {
    clientId: "aside", profileId, current: false, enabled: true,
    state: "current", installed: true,
    configPath: `/tmp/aside-fixture/u/${profileId}/models.json`,
    snapshotCount: 1, retentionDegraded: false, ...overrides,
  };
}

function list(overrides: Partial<AsideProfileList> = {}): AsideProfileList {
  return {
    clientId: "aside", state: "stale", installed: profiles.length > 0,
    configPath: "/tmp/aside-fixture/u", snapshotCount: profiles.length, retentionDegraded: false,
    profiles, total: profiles.length, enabledCount: profiles.filter(row => row.enabled).length,
    appliedCount: profiles.filter(row => row.state === "current" || row.state === "stale").length,
    allEnabled: profiles.length > 0 && profiles.every(row => row.enabled), ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function success(profileId?: number) {
  return { ok: true, clientId: "aside", changed: true, state: "current", message: "updated", results: [], ...(profileId === undefined ? {} : { profileId }) };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/#integrations/aside" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  profiles = [
    profile(0, { name: "Work", current: true }),
    profile(2, { name: "Personal", enabled: false, state: "absent" }),
    profile(7, { state: "stale" }),
  ];
  requests = [];
  journal = [];
  listResponse = () => json(list());
  mutationResponse = request => {
    const scopedId = request.path.match(/\/profiles\/(\d+)/)?.[1];
    return json(success(scopedId === undefined ? undefined : Number(scopedId)));
  };
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const request = {
      path: url.pathname + url.search,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    if (request.method !== "GET") return mutationResponse(request);
    if (url.pathname === profilesPath) return listResponse();
    const scoped = url.pathname.match(/^\/api\/client-integrations\/aside\/profiles\/(\d+)(\/journal)?$/);
    if (scoped) {
      const row = profiles.find(item => item.profileId === Number(scoped[1]));
      if (scoped[2]) return json({ operations: journal.filter(item => item.configPath === row?.configPath) });
      if (row) return json(row);
    }
    return json({ error: `Unexpected request: ${request.path}` }, 404);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => { mounted.unmount(); });
    root = null;
  }
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(active = true): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: AsideProfilesPage }] = await Promise.all([
    import("react-dom/client"), import("../src/i18n/provider"),
    import("../src/pages/integrations/AsideProfilesPage"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><AsideProfilesPage apiBase={apiBase} active={active} /></LanguageProvider>);
  });
}

function findButton(name: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(button =>
    (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name,
  );
}

function button(name: string, scope: ParentNode = container): HTMLButtonElement {
  const found = findButton(name, scope);
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

// Poll observable state under act; never assume a fixed delay means the request settled.
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`State did not settle: ${container.textContent}`);
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
  }
}

async function click(name: string, scope: ParentNode = container): Promise<void> {
  await act(async () => { button(name, scope).click(); });
}

async function ready(): Promise<void> {
  await mount();
  await waitFor(() => Boolean(findButton("Sync Work")));
}

function listReads(): number {
  return requests.filter(request => request.method === "GET" && request.path === profilesPath).length;
}

function writes(): RequestRecord[] {
  return requests.filter(request => request.method !== "GET");
}

test("three profiles show desired switches, actual badges, current marker and a mixed global switch", async () => {
  await ready();
  expect(button("Sync all profiles").getAttribute("aria-pressed")).toBe("mixed");
  expect(button("Sync Work").getAttribute("aria-pressed")).toBe("true");
  expect(button("Sync Personal").getAttribute("aria-pressed")).toBe("false");
  expect(button("Sync Profile 7").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelectorAll("button[aria-pressed]").length).toBe(4);
  for (const text of ["2 of 3 profiles applied", "Current profile", "Not applied", "Applied"]) {
    expect(container.textContent).toContain(text);
  }
  expect(writes()).toEqual([]);
});

test("the mixed global switch enables all profiles through the bulk endpoint", async () => {
  await ready();
  mutationResponse = () => {
    profiles = profiles.map(row => ({ ...row, enabled: true, state: "current" }));
    return json(success());
  };
  const before = listReads();
  await click("Sync all profiles");
  await waitFor(() => listReads() > before && button("Sync all profiles").getAttribute("aria-pressed") === "true");
  expect(writes()).toEqual([{ path: profilesPath, method: "PUT", body: { enabled: true } }]);
  expect(container.textContent).toContain("3 of 3 profiles applied");
});

test("an individual toggle uses its exact profile path and body and keeps siblings unchanged", async () => {
  await ready();
  mutationResponse = () => {
    profiles = profiles.map(row => row.profileId === 0 ? { ...row, enabled: false, state: "absent" } : row);
    return json(success(0));
  };
  await click("Sync Work");
  await waitFor(() => button("Sync Work").getAttribute("aria-pressed") === "false");
  expect(writes()).toEqual([{ path: `${profilesPath}/0`, method: "PUT", body: { enabled: false } }]);
  expect(button("Sync Personal").getAttribute("aria-pressed")).toBe("false");
  expect(button("Sync Profile 7").getAttribute("aria-pressed")).toBe("true");
});

test("a partial bulk response refetches saved choices without claiming failed profiles applied", async () => {
  await ready();
  mutationResponse = () => {
    profiles = profiles.map(row => row.profileId === 2
      ? { ...row, enabled: true, state: "conflict", reason: "foreign-edit" }
      : { ...row, state: "current" });
    return json({ ...success(), ok: false, state: "conflict", results: [
      { ...success(), profileId: 0 },
      { ok: false, profileId: 2, clientId: "aside", reason: "conflict", state: "conflict", message: "Profile changed" },
      { ...success(), profileId: 7 },
    ] }, 207);
  };
  const before = listReads();
  await click("Sync all profiles");
  await waitFor(() => listReads() > before && container.textContent?.includes("Conflict") === true);
  expect(button("Sync Personal").getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("2 of 3 profiles applied");
  expect(container.textContent).toContain("Some profiles need attention");
});

test("a refused individual update refetches saved off intent while showing the actual applied state", async () => {
  await ready();
  mutationResponse = () => {
    profiles = profiles.map(row => row.profileId === 0 ? { ...row, enabled: false } : row);
    return json({ error: "Write failed", code: "integration_mutation_failed", clientId: "aside",
      profileId: 0, state: "current", reason: "write_failed", message: "Write failed" }, 500);
  };
  const before = listReads();
  await click("Sync Work");
  await waitFor(() => listReads() > before && button("Sync Work").getAttribute("aria-pressed") === "false");
  expect(container.textContent).toContain("2 of 3 profiles applied");
  expect(container.textContent).toContain("Sync choice saved; file update pending.");
  expect(writes()).toEqual([{ path: `${profilesPath}/0`, method: "PUT", body: { enabled: false } }]);
});

test("Sync now uses server-selected synchronization and preserves a profile that is off", async () => {
  await ready();
  mutationResponse = () => json({ ok: true, clientId: "aside", results: [] });
  const before = listReads();
  await click("Sync now");
  await waitFor(() => listReads() > before && !button("Sync now").disabled);
  expect(writes()).toEqual([{ path: syncPath, method: "POST", body: {} }]);
  expect(button("Sync Personal").getAttribute("aria-pressed")).toBe("false");
  expect(button("Sync all profiles").getAttribute("aria-pressed")).toBe("mixed");
});

test("a successful empty list invites profile creation", async () => {
  profiles = [];
  await mount();
  await waitFor(() => container.textContent?.includes("Open Aside and create a profile to connect it.") === true);
  expect(container.textContent).not.toContain("Could not load Aside profiles");
});

for (const transportFailure of [false, true]) {
  test(`${transportFailure ? "HTTP failure" : "error DTO with an empty list"} shows an error instead of the empty invitation`, async () => {
    profiles = [];
    listResponse = () => json(list({ state: "unsafe", installed: false,
      error: "Cannot discover profiles", retentionDegraded: true }), transportFailure ? 500 : 200);
    await mount();
    await waitFor(() => container.textContent?.includes("Could not load Aside profiles") === true);
    expect(container.textContent).not.toContain("Open Aside and create a profile to connect it.");
    expect(writes()).toEqual([]);
  });
}

test("an inactive page does not fetch profiles or nested details", async () => {
  await mount(false);
  expect(requests).toEqual([]);
});

test("details keep state, journal and restore scoped to the selected profile, then return to the list", async () => {
  journal = [{ opId: "aside-profile-2-op", clientId: "aside", profileId: 2, kind: "disable",
    at: "2026-09-06T00:00:00Z", configPath: profiles[1]!.configPath,
    snapshot: "stored", undoable: true, deletable: false }];
  await ready();
  await click("Manage Personal");
  await waitFor(() => Boolean(findButton("Undo")));
  expect(requests.some(request => request.path === `${profilesPath}/2` && request.method === "GET")).toBe(true);
  expect(requests.some(request => request.path === `${profilesPath}/2/journal` && request.method === "GET")).toBe(true);
  expect(container.textContent).toContain("/tmp/aside-fixture/u/2/models.json");
  expect(container.textContent).not.toContain("/tmp/aside-fixture/u/0/models.json");
  await click("Undo");
  await waitFor(() => Boolean(container.querySelector("dialog[open]")));
  await click("Restore", container.querySelector("dialog[open]")!);
  await waitFor(() => !container.querySelector("dialog[open]"));
  expect(writes()).toEqual([{ path: `${profilesPath}/2/restore`, method: "POST",
    body: { opId: "aside-profile-2-op", confirmDrift: false } }]);
  await click("All Aside profiles");
  await waitFor(() => Boolean(findButton("Sync Work")));
  expect(button("Sync Personal").getAttribute("aria-pressed")).toBe("false");
  expect(requests.some(request => request.path === "/api/client-integrations/aside"
    || request.path.startsWith("/api/client-integrations/journal")
    || request.path === "/api/client-integrations/restore")).toBe(false);
});

for (const withSnapshot of [true, false]) {
  test(`bulk 207 keeps a profile's refusal and residual warning ${withSnapshot ? "with" : "without"} a snapshot`, async () => {
    await ready();
    const snapshotPath = "/tmp/aside-fixture/recovery/profile-2-before.json";
    mutationResponse = () => {
      profiles = profiles.map(row => ({ ...row, enabled: true }));
      return json({ ...success(), ok: false, results: [
        success(0),
        { ok: false, clientId: "aside", profileId: 2, state: "absent", reason: "write_failed",
          message: "Personal file could not be replaced", residual: true,
          ...(withSnapshot ? { snapshotPath } : {}) },
        success(7),
      ] }, 207);
    };
    const before = listReads();
    await click("Sync all profiles");
    await waitFor(() => listReads() > before && !button("Sync all profiles").disabled);
    const failedRow = button("Manage Personal").closest(".aside-profile-row")!;
    expect(failedRow.textContent).toContain("Personal file could not be replaced");
    if (withSnapshot) {
      expect(failedRow.textContent).toContain("The file may be in an intermediate state:");
      expect(failedRow.textContent).toContain(`Restore it from ${snapshotPath}.`);
    } else {
      expect(failedRow.textContent).toContain("Automatic recovery did not finish. Check the client configuration before retrying.");
      expect(failedRow.textContent).not.toContain("Restore it from");
    }
    expect(button("Manage Work").closest(".aside-profile-row")!.textContent).not.toContain("Personal file could not be replaced");
    expect(button("Sync Personal").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("2 of 3 profiles applied");
    expect(writes()).toEqual([{ path: profilesPath, method: "PUT", body: { enabled: true } }]);
  });
}

test("Sync now preserves distinct refusal reasons on the affected profiles after refetch", async () => {
  await ready();
  mutationResponse = () => json({ ok: false, clientId: "aside", results: [
    { client: "aside", profileId: 0, ok: false, reason: "Work file changed outside opencodex" },
    { client: "aside", profileId: 7, ok: false, reason: "Profile 7 file cannot be read" },
  ] }, 207);
  const before = listReads();
  await click("Sync now");
  await waitFor(() => listReads() > before && !button("Sync now").disabled);
  const work = button("Manage Work").closest(".aside-profile-row")!;
  const unnamed = button("Manage Profile 7").closest(".aside-profile-row")!;
  const personal = button("Manage Personal").closest(".aside-profile-row")!;
  expect(work.textContent).toContain("Work file changed outside opencodex");
  expect(work.textContent).not.toContain("Profile 7 file cannot be read");
  expect(unnamed.textContent).toContain("Profile 7 file cannot be read");
  expect(unnamed.textContent).not.toContain("Work file changed outside opencodex");
  expect(personal.textContent).not.toContain("Work file changed outside opencodex");
  expect(personal.textContent).not.toContain("Profile 7 file cannot be read");
  expect(button("Sync Personal").getAttribute("aria-pressed")).toBe("false");
  expect(writes()).toEqual([{ path: syncPath, method: "POST", body: {} }]);
});

test("a failed Aside restore keeps the error dialog open but refetches persisted desired state", async () => {
  journal = [{ opId: "aside-profile-2-failed-restore", clientId: "aside", profileId: 2, kind: "disable",
    at: "2026-09-06T00:00:00Z", configPath: profiles[1]!.configPath,
    snapshot: "stored", undoable: true, deletable: false }];
  await ready();
  await click("Manage Personal");
  await waitFor(() => Boolean(findButton("Undo")));
  expect(button("Apply").getAttribute("aria-pressed")).toBe("false");
  const stateReads = () => requests.filter(request => request.method === "GET" && request.path === `${profilesPath}/2`).length;
  const before = stateReads();
  mutationResponse = () => {
    // The server persists intent before restoring bytes; the byte write can still fail.
    profiles = profiles.map(row => row.profileId === 2 ? { ...row, enabled: true } : row);
    return json({ error: "Restore write failed", code: "integration_mutation_failed", clientId: "aside",
      profileId: 2, state: "absent", reason: "write_failed", message: "Personal restore could not finish",
      residual: true }, 500);
  };
  await click("Undo");
  await waitFor(() => Boolean(container.querySelector("dialog[open]")));
  await click("Restore", container.querySelector("dialog[open]")!);
  await waitFor(() => container.querySelector("dialog[open]")?.textContent?.includes("Personal restore could not finish") === true);
  await waitFor(() => stateReads() > before && findButton("Disable")?.getAttribute("aria-pressed") === "true");
  const dialog = container.querySelector("dialog[open]")!;
  expect(dialog.textContent).toContain("Automatic recovery did not finish. Check the client configuration before retrying.");
  expect(button("Restore", dialog).disabled).toBe(false);
  expect(writes()).toEqual([{ path: `${profilesPath}/2/restore`, method: "POST",
    body: { opId: "aside-profile-2-failed-restore", confirmDrift: false } }]);
  await click("Cancel", dialog);
  await waitFor(() => !container.querySelector("dialog[open]"));
  expect(button("Disable").getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("Not applied");
  await click("All Aside profiles");
  await waitFor(() => findButton("Sync Personal")?.getAttribute("aria-pressed") === "true");
});
