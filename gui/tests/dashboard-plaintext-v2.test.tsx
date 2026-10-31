import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { fetchDashboardMaMode } from "../src/pages/dashboard-core-poll";
import { useDashboardData } from "../src/pages/use-dashboard-data";
import { subagentSurfaceModes } from "../src/subagent-surface";

const signal = () => new AbortController().signal;

test("the ma-mode poll retains 'v2-plaintext' and the capability field", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({
      multiAgentMode: "v2-plaintext",
      supportsPlaintextV2Mode: true,
      plaintextAgentMessagesEnabled: true,
    })) as typeof fetch;
    expect(await fetchDashboardMaMode("", signal())).toEqual({
      maMode: "v2-plaintext",
      advisory: null,
      supportsPlaintextV2: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an older runtime narrows to the three legacy options", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ multiAgentMode: "v2" })) as typeof fetch;
    const poll = await fetchDashboardMaMode("", signal());
    expect(poll).toMatchObject({ maMode: "v2", supportsPlaintextV2: false });
    expect(subagentSurfaceModes(poll.supportsPlaintextV2)).toEqual(["v1", "default", "v2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stored 'v2-plaintext' keeps the fourth option offered on a supporting runtime", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({
      multiAgentMode: "v2-plaintext",
      supportsPlaintextV2Mode: true,
    })) as typeof fetch;
    const poll = await fetchDashboardMaMode("", signal());
    expect(subagentSurfaceModes(poll.supportsPlaintextV2)).toContain("v2-plaintext");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

type Json = Record<string, unknown>;

const DASH_GLOBAL_KEYS = ["window", "document", "navigator", "sessionStorage", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

/** Happy-dom dashboard harness; same shape as dashboard-resource-deadline.test.tsx. */
function setupDashboardDom(fetchImpl: typeof fetch) {
  const previous = new Map(DASH_GLOBAL_KEYS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: win, document: win.document, navigator: win.navigator,
    sessionStorage: win.sessionStorage, localStorage: win.localStorage,
    fetch: fetchImpl, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  clearClientResourceStoresForTests();
  const restore = () => {
    clearClientResourceStoresForTests();
    win.close();
    for (const key of DASH_GLOBAL_KEYS) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { win, restore };
}

async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("dashboard fixture did not settle");
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  }
}

async function mountDashboard(win: Window, apiBase: string) {
  let data: ReturnType<typeof useDashboardData> | undefined;
  function Probe() {
    data = useDashboardData(apiBase);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<LanguageProvider><Probe /></LanguageProvider>); });
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    // Let the store eviction macrotask run so a remount refetches instead of
    // reading a retained snapshot.
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  };
  return { data: () => data!, unmount };
}

/** Fetch stub: v2 GET from a fixture fn, PUT bodies recorded and answered by onPut. */
function dashboardFetch(opts: { v2Get: () => Promise<Response>; onPut?: (body: Json) => Response }) {
  const puts: Json[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Json;
      puts.push(body);
      return opts.onPut ? opts.onPut(body) : Response.json({ ok: true });
    }
    if (path.endsWith("/api/v2")) return opts.v2Get();
    if (path.endsWith("/api/system/health")) return Response.json({ status: "ok", version: "fixture", uptime: 1 });
    if (path.endsWith("/api/providers") || path.endsWith("/api/models")) return Response.json([]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, puts };
}

const SUPPORTING_V2 = { multiAgentMode: "default", supportsPlaintextV2Mode: true };
const VALID_RECEIPT = {
  ok: true,
  multiAgentMode: "v2-plaintext",
  supportsPlaintextV2Mode: true,
  plaintextAgentMessagesEnabled: true,
  enabled: false,
};

test("selecting 'v2-plaintext' stages the consent and dismissing writes nothing", async () => {
  const { fetchImpl, puts } = dashboardFetch({ v2Get: async () => Response.json(SUPPORTING_V2) });
  const { win, restore } = setupDashboardDom(fetchImpl);
  try {
    const dash = await mountDashboard(win, "/d");
    await waitFor(() => dash.data().maMode === "default");
    await act(async () => { await dash.data().switchMaMode("v2-plaintext"); });
    expect(dash.data().pendingMaMode).toBe("v2-plaintext");
    expect(dash.data().maMode).toBe("default");
    expect(puts).toEqual([]);
    await act(async () => { dash.data().dismissMaSurfaceDialog(); });
    expect(dash.data().pendingMaMode).toBeNull();
    expect(puts).toEqual([]);
    expect(dash.data().maMode).toBe("default");
    await dash.unmount();
  } finally {
    restore();
  }
});

test("confirming 'v2-plaintext' sends one PUT with the acknowledgement and applies a valid receipt", async () => {
  const { fetchImpl, puts } = dashboardFetch({
    v2Get: async () => Response.json(SUPPORTING_V2),
    onPut: () => Response.json(VALID_RECEIPT),
  });
  const { win, restore } = setupDashboardDom(fetchImpl);
  try {
    const dash = await mountDashboard(win, "/d");
    await waitFor(() => dash.data().maMode === "default");
    await act(async () => { await dash.data().switchMaMode("v2-plaintext"); });
    await act(async () => { await dash.data().keepMaMode(); });
    expect(puts).toEqual([{ multiAgentMode: "v2-plaintext", plaintextAgentMessagesAcknowledged: true }]);
    expect(dash.data().maMode).toBe("v2-plaintext");
    expect(dash.data().maError).toBeNull();
    // The confirmed receipt proves this apiBase supports the mode until the next poll.
    expect(dash.data().maSupportsPlaintextV2).toBe(true);
    expect(win.sessionStorage.getItem("ocx.dash.maMode.v1:/d")).toBe('"v2-plaintext"');
    await dash.unmount();
  } finally {
    restore();
  }
});

test("a 200 receipt that does not confirm the mode keeps the old selection and surfaces an error", async () => {
  const receipts = [
    // Server applied a different mode than requested.
    { ok: true, multiAgentMode: "v2", supportsPlaintextV2Mode: true, plaintextAgentMessagesEnabled: true, enabled: false },
    // The four state fields without ok:true — matches the CLI receipt invariant.
    { multiAgentMode: "v2-plaintext", supportsPlaintextV2Mode: true, plaintextAgentMessagesEnabled: true, enabled: false },
  ];
  let receiptIndex = 0;
  const { fetchImpl, puts } = dashboardFetch({
    v2Get: async () => Response.json(SUPPORTING_V2),
    onPut: () => Response.json(receipts[Math.min(receiptIndex++, receipts.length - 1)]),
  });
  const { win, restore } = setupDashboardDom(fetchImpl);
  try {
    const dash = await mountDashboard(win, "/d");
    await waitFor(() => dash.data().maMode === "default");
    for (let attempt = 0; attempt < receipts.length; attempt++) {
      await act(async () => { await dash.data().switchMaMode("v2-plaintext"); });
      await act(async () => { await dash.data().keepMaMode(); });
      expect(dash.data().maMode).toBe("default");
      expect(dash.data().maError).toBeTruthy();
      // An unconfirmed write must not seed the cache or reopen the fourth option by itself.
      expect(win.sessionStorage.getItem("ocx.dash.maMode.v1:/d")).toBe('"default"');
    }
    expect(puts).toHaveLength(2);
    await dash.unmount();
  } finally {
    restore();
  }
});

test("a cached 'v2-plaintext' cannot offer the write on a runtime that stopped supporting it", async () => {
  let v2Fixture: Json = { multiAgentMode: "v2-plaintext", supportsPlaintextV2Mode: true, plaintextAgentMessagesEnabled: true };
  const { fetchImpl } = dashboardFetch({ v2Get: async () => Response.json(v2Fixture) });
  const { win, restore } = setupDashboardDom(fetchImpl);
  try {
    const first = await mountDashboard(win, "/d");
    await waitFor(() => first.data().maMode === "v2-plaintext" && first.data().maSupportsPlaintextV2);
    await first.unmount();
    // The session cache now holds 'v2-plaintext'; the endpoint answers like an older
    // runtime (no supportsPlaintextV2Mode). Hold its GET until the cached-only phase
    // is asserted so the poll cannot land early.
    let releaseV2: (() => void) | undefined;
    const held = new Promise<void>(resolve => { releaseV2 = resolve; });
    v2Fixture = { multiAgentMode: "v2" };
    const gated = dashboardFetch({ v2Get: () => held.then(() => Response.json(v2Fixture)) });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: gated.fetchImpl });
    clearClientResourceStoresForTests();
    const second = await mountDashboard(win, "/d");
    // Cached mode still renders, but it is not a support proof for this apiBase.
    expect(second.data().maMode).toBe("v2-plaintext");
    expect(second.data().maSupportsPlaintextV2).toBe(false);
    expect(subagentSurfaceModes(second.data().maSupportsPlaintextV2)).not.toContain("v2-plaintext");
    await act(async () => { releaseV2!(); });
    await waitFor(() => second.data().maMode === "v2");
    expect(second.data().maSupportsPlaintextV2).toBe(false);
    await second.unmount();
  } finally {
    restore();
  }
});
