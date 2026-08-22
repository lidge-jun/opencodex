/**
 * Models-tab staleness surface: the fetch helper's conservatism and the banner's
 * render/refresh contract.
 *
 * The banner is where a user forms the belief that the picker is wrong, so the
 * cases that matter most are the ones where it must stay silent.
 */
import { describe, expect, test } from "bun:test";
import { fetchCodexAppServerState } from "../src/codex-app-server-state";

const BANNER_SRC = await Bun.file(new URL("../src/components/codex-stale-banner.tsx", import.meta.url)).text();
const MODELS_SRC = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
const APP_TSX_SRC = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchCodexAppServerState", () => {
  test("passes a well-formed reading through", async () => {
    const outcome = await fetchCodexAppServerState("", {
      fetchFn: (async () => response({ state: "stale", runningCount: 2 })) as typeof fetch,
    });

    expect(outcome).toEqual({ state: "stale", runningCount: 2 });
  });

  test("keeps every classifier verdict distinct", async () => {
    for (const state of ["fresh", "stale", "not_running", "unknown"] as const) {
      const outcome = await fetchCodexAppServerState("", {
        fetchFn: (async () => response({ state, runningCount: 0 })) as typeof fetch,
      });
      expect(outcome.state).toBe(state);
    }
  });

  test("a non-2xx reading renders nothing rather than guessing", async () => {
    const outcome = await fetchCodexAppServerState("", {
      fetchFn: (async () => response({ state: "stale", runningCount: 1 }, 500)) as typeof fetch,
    });

    expect(outcome).toEqual({ state: null, runningCount: 0 });
  });

  test("a malformed body renders nothing", async () => {
    const outcome = await fetchCodexAppServerState("", {
      fetchFn: (async () => response({ state: "exploded", runningCount: 1 })) as typeof fetch,
    });

    expect(outcome.state).toBeNull();
  });

  test("a negative running count is rejected", async () => {
    const outcome = await fetchCodexAppServerState("", {
      fetchFn: (async () => response({ state: "stale", runningCount: -1 })) as typeof fetch,
    });

    expect(outcome.state).toBeNull();
  });

  test("an aborted request resolves instead of throwing", async () => {
    // Unmount aborts the in-flight read; an unhandled rejection here would surface
    // as a console error on every navigation away from the models page.
    const outcome = await fetchCodexAppServerState("", {
      fetchFn: (async () => {
        throw new DOMException("aborted", "AbortError");
      }) as typeof fetch,
    });

    expect(outcome).toEqual({ state: null, runningCount: 0 });
  });

  test("reads the codex-app-server path", async () => {
    let seen = "";
    await fetchCodexAppServerState("http://127.0.0.1:10100", {
      fetchFn: (async (input: string | URL | Request) => {
        seen = String(input);
        return response({ state: "fresh", runningCount: 0 });
      }) as unknown as typeof fetch,
    });

    expect(seen).toBe("http://127.0.0.1:10100/api/system/codex-app-server");
  });
});

/*
 * The banner's render and refresh behavior is covered by real DOM tests in
 * codex-stale-banner-dom.test.tsx. Source-text assertions could not see the
 * defect where a page-head restart left the banner on screen, so they were
 * replaced rather than kept alongside.
 */


describe("Models page wiring", () => {
  const src = MODELS_SRC;

  test("uses appServerState, never shadowing the existing catalogState", () => {
    // Models.tsx already binds catalogState to the /api/catalog resource state.
    expect(src).toContain("appServerState");
    expect(src).toContain("const catalogState = catalogResource.state;");
  });

  test("reads the state once on mount, not on a timer", () => {
    expect(src).toContain("reloadAppServerState");
    const block = src.slice(src.indexOf("reloadAppServerState(controller.signal)"));
    expect(block.slice(0, 200)).toContain("controller.abort()");
    expect(src).not.toContain("setInterval(() => reloadAppServerState");
  });

  test("the head action and the banner share one controller", () => {
    expect(src).toContain("useCodexRestart(apiBase, {");
    expect(src).toContain("controller={{ restarting: codexRestarting, restart: handleCodexRestart }}");
    expect(src).toContain("onSettled: () => reloadAppServerState()");
  });

  test("the banner sits above the tab strip so every sub-tab shows it", () => {
    expect(src.indexOf("<CodexStaleBanner")).toBeLessThan(src.indexOf("<ModelsTabStrip"));
  });

  test("the action is not inside the tablist", () => {
    // Every child of ModelsTabStrip is role="tab"; a mutation button there breaks
    // the ARIA contract.
    const head = src.slice(src.indexOf('className="page-head"'), src.indexOf("<ModelsTabStrip"));
    expect(head).toContain("page-head-actions");
  });
});

describe("cross-surface invalidation", () => {
  const APP_SRC = APP_TSX_SRC;
  const MODELS = MODELS_SRC;

  test("the sidebar restart bumps an epoch App owns", () => {
    // The sidebar control is present on every page, including Models, and it has
    // its own controller. Without this the models banner survives a successful
    // restart started from the sidebar.
    expect(APP_SRC).toContain("codexRestartEpoch");
    expect(APP_SRC).toContain("onSettled: () => setCodexRestartEpoch(epoch => epoch + 1)");
  });

  test("the epoch reaches Models as a prop", () => {
    expect(APP_SRC).toContain("restartEpoch={codexRestartEpoch}");
    expect(MODELS).toContain("restartEpoch = 0");
  });

  test("Models re-reads staleness when the epoch changes", () => {
    const effect = MODELS.slice(MODELS.indexOf("reloadAppServerState(controller.signal)"));
    expect(effect.slice(0, 220)).toContain("[reloadAppServerState, restartEpoch]");
  });

  test("the epoch is the only cross-surface coupling, not a shared controller", () => {
    // Two controllers is deliberate: the backend is single-flight, so what was
    // missing is invalidation rather than mutual exclusion.
    expect(APP_SRC).toContain("useCodexRestart(API_BASE, {");
    expect(MODELS).toContain("useCodexRestart(apiBase, {");
  });
});
