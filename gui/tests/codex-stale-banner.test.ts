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

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing source anchor: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing source terminator: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end + endMarker.length);
}

function appServerReadEffect(source: string): string {
  const marker = source.indexOf("appServerReadBase.current = apiBase;");
  expect(marker, "missing app-server base adoption").toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf("useEffect(() => {", marker);
  expect(start, "base adoption must belong to an effect").toBeGreaterThanOrEqual(0);
  const dependencyStart = source.indexOf("\n  }, [", marker);
  expect(dependencyStart, "missing app-server effect dependencies").toBeGreaterThan(marker);
  const end = source.indexOf("]);", dependencyStart);
  expect(end, "unterminated app-server effect").toBeGreaterThan(dependencyStart);
  return source.slice(start, end + 3);
}

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
    const effect = appServerReadEffect(src);
    const cancel = sourceSection(src, "const cancelAppServerRead = useCallback(", "}, []);");
    const read = sourceSection(src, "const reloadAppServerState = useCallback(", "}, [apiBase, cancelAppServerRead]);");
    expect(effect.match(/reloadAppServerState\(\)/g)).toHaveLength(1);
    expect(effect).toContain("return cancelAppServerRead;");
    expect(cancel).toContain("appServerReadGeneration.current++");
    expect(cancel).toContain("appServerRead.current?.controller.abort()");
    expect(cancel).toContain("appServerRead.current?.clear()");
    expect(cancel).toContain("appServerRead.current = null");
    expect(read).toContain("cancelAppServerRead();");
    expect(read).toContain("await fetchCodexAppServerState(apiBase, { signal: bounded.signal })");
    expect(read).toContain("generation !== appServerReadGeneration.current");
    expect(read).toContain("appServerReadBase.current !== apiBase");
    expect(read).toContain("!appServerMounted.current");
    const settlement = sourceSection(read, "finally {", "if (appServerRead.current === bounded)");
    expect(settlement).toContain("bounded.clear()");
    expect(effect).not.toMatch(/\bset(?:Interval|Timeout)\s*\(/);
    expect(read).not.toMatch(/\bset(?:Interval|Timeout)\s*\(/);
    expect(src).not.toContain("setInterval(() => reloadAppServerState");
  });

  test("the head action and the banner share one controller", () => {
    expect(src).toContain("useCodexRestart(apiBase, {");
    expect(src).toContain("controller={{ restarting: codexRestarting, restart: handleCodexRestart }}");
    const controller = sourceSection(src, "useCodexRestart(apiBase, {", "\n  });");
    expect(controller).toMatch(/onSettled:\s*\(\)\s*=>\s*\{\s*void reloadAppServerState\(\);\s*\}/);
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
    const effect = appServerReadEffect(MODELS);
    expect(effect).toContain("void reloadAppServerState();");
    expect(effect).toContain("return cancelAppServerRead;");
    const dependencies = effect.slice(effect.lastIndexOf("}, [") + 4, effect.lastIndexOf("]"))
      .split(",").map(value => value.trim());
    expect(dependencies).toEqual(["apiBase", "cancelAppServerRead", "reloadAppServerState", "restartEpoch"]);
  });

  test("the epoch is the only cross-surface coupling, not a shared controller", () => {
    // Two controllers is deliberate: the backend is single-flight, so what was
    // missing is invalidation rather than mutual exclusion.
    expect(APP_SRC).toContain("useCodexRestart(sharedBase, {");
    expect(MODELS).toContain("useCodexRestart(apiBase, {");
  });
});
