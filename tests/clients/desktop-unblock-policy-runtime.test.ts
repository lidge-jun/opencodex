import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

// Each process has its own module mocks. No real system proxy, certificate store,
// app, or account is consulted; PAC execution is the real isolated evaluator.
function exercise(mode: boolean, kind: string, failingStop = false): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "ocx-policy-runtime-"));
  const modulePath = (name: string) => JSON.stringify(repoPath("src/chatgpt/desktop-unblock", `${name}.ts`));
  const source = `
    import { mock } from "bun:test";
    import { existsSync } from "node:fs";
    import { join } from "node:path";
    const originalPac = await import(${modulePath("pac")});
    let reads = 0, loads = 0, originStops = 0, entryStops = 0, options;
    const kind = ${JSON.stringify(kind)};
    const hasPac = kind === "pac" || kind === "syntax" || kind === "unreadable";
    mock.module(${modulePath("pac")}, () => ({ ...originalPac,
      systemProxyChain() {
        reads++;
        if (kind === "read-error") throw new Error("fixture proxy read failure");
        return { autoConfig: hasPac, autoConfigUrl: hasPac ? "file:///fixture.pac" : null,
          entries: kind === "static" ? ["PROXY 127.0.0.1:12345", "SOCKS5 127.0.0.1:23456"] : [] };
      },
      async loadSystemPac() {
        loads++;
        if (kind === "unreadable") return null;
        return kind === "syntax" ? "function {" : 'function FindProxyForURL(url, host) { return url.indexOf("wss:") === 0 ? "DIRECT" : "PROXY 127.0.0.1:12345"; }';
      },
    }));
    mock.module(${JSON.stringify(repoPath("src/claude/intercept/local-ca.ts"))}, () => ({
      ensureLocalInterceptCaForStartup: async () => ({}), issueLocalInterceptLeaf: () => ({}),
      claudeInterceptCaCertPath: dir => join(dir, "fixture-ca.pem"),
    }));
    mock.module(${modulePath("listener")}, () => ({ CHATGPT_INTERCEPT_HOST: "chatgpt.com",
      startChatgptUnblockListener(value) {
        options = value;
        if (value.isReady()) throw new Error("listener admitted traffic during startup");
        return { port: value.port, async stop() { originStops++; } };
      },
    }));
    mock.module(${modulePath("entry-proxy")}, () => ({
      async startChatgptUnblockEntryProxy(value) {
        return { port: value.port, async stop() { entryStops++; ${failingStop ? 'throw new Error("fixture entry stop failure");' : ""} } };
      },
    }));
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { startChatgptUnblock } = await import(${modulePath("runtime")});
    let error = "", routes, wsRoutes, ready = false, policyClosed = false, stopError = "";
    try {
      const handle = await startChatgptUnblock({ config: { chatgptDesktop: { unblockSend: true, pacFallback: ${mode}, port: 12300 } }, publicPort: 0, configDir: ${JSON.stringify(dir)} });
      ready = options.isReady();
      const policy = options.routePolicy();
      if (policy) {
        routes = await policy.resolve("https://chatgpt.com/conversation?private=value");
        wsRoutes = await policy.resolve("wss://chatgpt.com/voice");
      }
      try { await handle.stop(); } catch (value) { stopError = String(value); }
      if (policy) {
        try { await policy.resolve("https://chatgpt.com/"); }
        catch { policyClosed = true; }
      }
    } catch (value) { error = String(value); }
    console.log(JSON.stringify({ reads, loads, originStops, entryStops, error, stopError, routes, wsRoutes, ready, policyClosed,
      stoppedReady: options.isReady(), aborted: options.wsUpstream.signal.aborted,
      pacExists: existsSync(join(${JSON.stringify(dir)}, "chatgpt-unblock.pac")),
      markerExists: existsSync(join(${JSON.stringify(dir)}, "chatgpt-unblock.ready")),
    }));
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", timeout: 15_000, env: { ...process.env, OPENCODEX_HOME: dir } });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const pacFallback of [false, true]) {
  const mode = pacFallback ? "PAC launch" : "resolver launch";
  test(`${mode} shares one captured PAC policy across HTTP and WebSocket schemes`, () => {
    const value = exercise(pacFallback, "pac");
    expect(value).toMatchObject({ reads: 1, loads: 1, error: "", ready: true, stoppedReady: false,
      originStops: 1, entryStops: Number(pacFallback), policyClosed: true, aborted: true,
      routes: ["http://127.0.0.1:12345"], wsRoutes: [null], pacExists: pacFallback, markerExists: true });
  });

  test(`${mode} preserves a static system chain without a synthetic DIRECT`, () => {
    expect(exercise(pacFallback, "static")).toMatchObject({ reads: 1, loads: 0, error: "",
      routes: ["http://127.0.0.1:12345", "socks5://127.0.0.1:23456"], policyClosed: true, aborted: true });
  });

  test(`${mode} retains existing outbound selection only when no system policy exists`, () => {
    const value = exercise(pacFallback, "none");
    expect(value).toMatchObject({ reads: 1, loads: 0, error: "", ready: true, policyClosed: false });
    expect(value.routes).toBeUndefined();
  });

  for (const kind of ["syntax", "read-error", "unreadable"]) {
    test(`${mode} closes listeners before readiness on ${kind}`, () => {
      const value = exercise(pacFallback, kind);
      expect(value.error).not.toBe("");
      expect(value).toMatchObject({ ready: false, stoppedReady: false, originStops: 1,
        entryStops: Number(pacFallback), aborted: true, pacExists: false, markerExists: false });
    });
  }
}

test("an entry shutdown error still aborts policy transports and closes the origin", () => {
  expect(exercise(true, "pac", true)).toMatchObject({ stopError: "Error: fixture entry stop failure",
    policyClosed: true, aborted: true, originStops: 1, entryStops: 1, stoppedReady: false });
});
