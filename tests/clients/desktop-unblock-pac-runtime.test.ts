import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET,
  chatgptPacFallbackEnabled,
  chatgptUnblockEntryPort,
  chatgptUnblockPacArg,
  chatgptUnblockPacPath,
  chatgptUnblockPort,
  CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES,
  chatgptUnblockPacArgFor,
  chooseChatgptUnblockPac,
  startChatgptUnblock,
} from "../../src/chatgpt/desktop-unblock/runtime";
import { CHATGPT_INTERCEPT_HOST } from "../../src/chatgpt/desktop-unblock/listener";
import { chatgptUnblockReadyPath } from "../../src/chatgpt/desktop-unblock/runtime";
import type { OcxConfig } from "../../src/types";
import { repoPath } from "../helpers/repo-root";
import { freeLoopbackPortPair as freePortPair } from "../helpers/free-loopback-port-pair";

function config(overrides: Partial<NonNullable<OcxConfig["chatgptDesktop"]>> = {}): OcxConfig {
  return { chatgptDesktop: { unblockSend: true, ...overrides } } as OcxConfig;
}

describe("loopback port-pair allocation", () => {
  const collision = () => Object.assign(new Error("occupied"), { code: "EADDRINUSE" });

  test("retries a neighboring collision while keeping the origin reserved until cleanup", () => {
    const calls: number[] = [], stopped: number[] = [];
    const port = freePortPair(requested => {
      calls.push(requested);
      if (requested === 12001) {
        expect(stopped).toEqual([]);
        throw collision();
      }
      if (requested === 13001) expect(stopped).toEqual([12000]);
      const port = requested || (calls.length === 1 ? 12000 : 13000);
      return { port, stop(force) { expect(force).toBe(true); stopped.push(port); } };
    });
    expect(port).toBe(13000);
    expect(calls).toEqual([0, 12001, 0, 13001]);
    expect(stopped).toEqual([12000, 13001, 13000]);
  });

  test("retries an ephemeral bind collision and a range-boundary probe", () => {
    const calls: number[] = [], stopped: number[] = [];
    expect(freePortPair(requested => {
      calls.push(requested);
      if (calls.length === 1) throw collision();
      const port = requested || (calls.length === 2 ? 65535 : 12000);
      return { port, stop() { stopped.push(port); } };
    })).toBe(12000);
    expect(calls).toEqual([0, 0, 0, 12001]);
    expect(stopped).toEqual([65535, 12001, 12000]);
  });

  for (const failedBind of [1, 2]) {
    test(`propagates an unexpected error from bind ${failedBind} without retrying`, () => {
      const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
      let calls = 0, stops = 0;
      expect(() => freePortPair(() => {
        if (++calls === failedBind) throw failure;
        return { port: 12000, stop() { stops++; } };
      })).toThrow(failure);
      expect(calls).toBe(failedBind);
      expect(stops).toBe(failedBind - 1);
    });
  }

  test("bounds repeated collisions and preserves the last failure", () => {
    const failure = collision();
    let calls = 0, stops = 0;
    let caught: unknown;
    try {
      freePortPair(requested => {
        calls++;
        if (requested) throw failure;
        return { port: 12000, stop() { stops++; } };
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("after 100 attempts");
    expect((caught as Error).cause).toBe(failure);
    expect(calls).toBe(200);
    expect(stops).toBe(100);
  });

  test("does not retry cleanup errors, and still releases the other probe", () => {
    const failure = collision();
    const stopped: number[] = [];
    let calls = 0;
    expect(() => freePortPair(requested => {
      calls++;
      const port = requested || 12000;
      return { port, stop() { stopped.push(port); if (requested) throw failure; } };
    })).toThrow(failure);
    expect(calls).toBe(2);
    expect(stopped).toEqual([12001, 12000]);
  });
});

describe("chatgpt unblock runtime ports and mode", () => {
  test("the entry port is one after the origin port", () => {
    expect(chatgptUnblockPort(config(), 10100)).toBe(10300);
    expect(chatgptUnblockEntryPort(config(), 10100)).toBe(10300 + CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET);
  });

  test("an origin port at 65535 wraps the entry port to 65534 instead of leaving the range", () => {
    expect(chatgptUnblockPort(config({ port: 65535 }), 10100)).toBe(65535);
    expect(chatgptUnblockEntryPort(config({ port: 65535 }), 10100)).toBe(65534);
  });

  test("pacFallback requires unblockSend and is off by default", () => {
    expect(chatgptPacFallbackEnabled(config())).toBe(false);
    // The intercept itself is macOS only, and PAC mode requires it.
    expect(chatgptPacFallbackEnabled(config({ pacFallback: true }))).toBe(process.platform === "darwin");
    expect(chatgptPacFallbackEnabled({ chatgptDesktop: { pacFallback: true } } as OcxConfig)).toBe(false);
    expect(chatgptPacFallbackEnabled({ chatgptDesktop: { unblockSend: true, pacFallback: true }, runtimeRole: "client" } as OcxConfig)).toBe(false);
  });

  test("the PAC argument carries the script inline as a data: URL", () => {
    // A file:// PAC is ignored by the ChatGPT app (it dials directly, bypassing intercept and
    // VPN), and an http:// one would need opencodex alive to be fetched.
    const dir = mkdtempSync(join(tmpdir(), "ocx-pac-arg-"));
    try {
      const text = "function FindProxyForURL(u, h) { return \"DIRECT\"; }\n";
      writeFileSync(chatgptUnblockPacPath(dir), text);
      const arg = chatgptUnblockPacArg(dir);
      expect(arg).toBe(`--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(text).toString("base64")}`);
      expect(Buffer.from(arg.split("base64,")[1]!, "base64").toString("utf8")).toBe(text);
      // No file yet: the bare prefix, which matches no real command line.
      rmSync(chatgptUnblockPacPath(dir));
      expect(chatgptUnblockPacArg(dir)).toBe("--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(chatgptUnblockPacPath("/cfg")).toBe(join("/cfg", "chatgpt-unblock.pac"));
  });

});

/** Whether something accepts TCP connections on a loopback port right now. */
function accepts(port: number): Promise<boolean> {
  return new Promise(resolve => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { open(socket) { socket.end(); resolve(true); }, data() {}, error() { resolve(false); }, connectError() { resolve(false); } },
    }).catch(() => resolve(false));
  });
}

describe("chatgpt unblock PAC choice", () => {
  const chain = { entries: ["PROXY 127.0.0.1:7892"], autoConfig: true, autoConfigUrl: "http://127.0.0.1:7892/proxy.pac" };
  const systemPac = 'function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:7892"; }';

  test("a system PAC that fits the launch switch is embedded", () => {
    const pac = chooseChatgptUnblockPac(10301, chain, systemPac);
    expect(pac.route).toBe("system-pac");
    expect(pac.text).toContain(systemPac);
  });

  test("a system PAC too large for the launch switch fails instead of replacing its route", () => {
    const bigger = `${systemPac}\n// ${"x".repeat(3_000)}`;
    expect(() => chooseChatgptUnblockPac(10301, chain, bigger, 2_000)).toThrow("The system PAC is too large");
  });

  test("the default limit refuses a whitelist-sized PAC rather than adding DIRECT", () => {
    const large = `function FindProxyForURL(url, host) { ${"if (dnsDomainIs(host, '.example.test')) return 'DIRECT';\n".repeat(12_000)} return "PROXY 127.0.0.1:7892"; }`;
    expect(large.length).toBeGreaterThan(600 * 1024);
    expect(() => chooseChatgptUnblockPac(10301, chain, large)).toThrow("The system PAC is too large");
    expect(CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES).toBeLessThan(1024 * 1024);
  });

  test("an unreadable configured PAC fails even when static proxies are available", () => {
    expect(() => chooseChatgptUnblockPac(10301, chain, null)).toThrow("The configured system PAC could not be read");
    expect(() => chooseChatgptUnblockPac(10301, { ...chain, entries: [], autoConfigUrl: null }, null)).toThrow();
  });

  test("no system PAC retains only the configured static proxy route", () => {
    const pac = chooseChatgptUnblockPac(10301, { ...chain, autoConfig: false, autoConfigUrl: null }, null);
    expect(pac.route).toBe("system-proxy");
    expect(pac.text).not.toContain("DIRECT");
  });

});

describe.skipIf(process.platform === "win32")("chatgpt unblock PAC startup route failures", () => {
  for (const route of ["scutil-failed", "pac-unreadable", "pac-too-large"]) {
    test(`${route} releases both listeners and publishes no PAC or readiness marker`, () => {
      const dir = mkdtempSync(join(tmpdir(), "ocx-pac-route-failure-"));
      try {
        const pacPath = join(dir, "system.pac");
        if (route === "pac-too-large") writeFileSync(pacPath, `function FindProxyForURL(u, h) { return "DIRECT"; }\n//${"x".repeat(500_000)}`);
        const scutil = route === "scutil-failed" ? "exit 1" : `printf '%s\\n' '<dictionary> {' 'ProxyAutoConfigEnable : 1' 'ProxyAutoConfigURLString : ${pathToFileURL(pacPath).href}' '}'`;
        writeFileSync(join(dir, "scutil"), `#!/bin/sh\n${scutil}\n`, { mode: 0o755 });
        // Platform dispatch is emulated only inside this isolated process. Every path and
        // command is a temporary fixture; no macOS proxy or trust setting is accessed.
        const source = `
          import { freeLoopbackPortPair as freePortPair } from ${JSON.stringify(repoPath("tests/helpers/free-loopback-port-pair.ts"))};
          import { startChatgptUnblock } from ${JSON.stringify(repoPath("src", "chatgpt", "desktop-unblock", "runtime.ts"))};
          Object.defineProperty(process, "platform", { value: "darwin" });
          const port = freePortPair();
          let error = "";
          try {
            const handle = await startChatgptUnblock({ config: { chatgptDesktop: { unblockSend: true, pacFallback: true, port } }, publicPort: 0, configDir: ${JSON.stringify(dir)} });
            await handle?.stop();
          } catch (value) { error = String(value); }
          for (const target of [port, port + 1]) {
            // Successful rebind proves cleanup without relying on TCP timing.
            Bun.listen({ hostname: "127.0.0.1", port: target, socket: { data() {} } }).stop(true);
          }
          console.log(JSON.stringify({ error }));
        `;
        const result = spawnSync(process.execPath, ["-e", source], { env: { ...process.env, PATH: dir, OPENCODEX_HOME: dir }, encoding: "utf8", timeout: 10_000 });
        expect(result.status).toBe(0);
        const expected = route === "scutil-failed" ? "Cannot read the system proxy configuration" : route === "pac-unreadable" ? "The configured system PAC could not be read" : "The system PAC is too large";
        expect(result.stdout).toContain(expected);
        expect(existsSync(chatgptUnblockPacPath(dir))).toBe(false);
        expect(existsSync(chatgptUnblockReadyPath(dir))).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe.skipIf(process.platform === "win32")("chatgpt unblock startup readiness", () => {
  test("a stale PAC and ready marker cannot make an unfinished startup launchable", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-pac-readiness-"));
    try {
      writeFileSync(chatgptUnblockPacPath(dir), "stale PAC from an earlier run");
      writeFileSync(chatgptUnblockReadyPath(dir), "stale readiness marker");
      const source = `
        import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { freeLoopbackPortPair as freePortPair } from ${JSON.stringify(repoPath("tests/helpers/free-loopback-port-pair.ts"))};
        import { startChatgptUnblock } from ${JSON.stringify(repoPath("src", "chatgpt", "desktop-unblock", "runtime.ts"))};
        import { probeChatgptUnblockListener } from ${JSON.stringify(repoPath("src", "chatgpt", "desktop-unblock", "launch-watcher.ts"))};
        Object.defineProperty(process, "platform", { value: "darwin" });
        const dir = ${JSON.stringify(dir)};
        let releasePac, pacRequested;
        const pacBody = new Promise(resolve => { releasePac = resolve; });
        const requested = new Promise(resolve => { pacRequested = resolve; });
        const pacServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
          pacRequested(); return new Response(await pacBody);
        }});
        writeFileSync(join(dir, "scutil"), "#!/bin/sh\\nprintf '%s\\\\n' '<dictionary> {' 'ProxyAutoConfigEnable : 1' 'ProxyAutoConfigURLString : http://127.0.0.1:" + pacServer.port + "/proxy.pac' '}'\\n", { mode: 0o755 });
        const port = freePortPair();
        const starting = startChatgptUnblock({ config: { chatgptDesktop: { unblockSend: true, pacFallback: true, port } }, publicPort: 0, configDir: dir });
        await requested;
        const before = await probeChatgptUnblockListener(port, undefined, undefined, dir);
        releasePac('function FindProxyForURL(u, h) { return "DIRECT"; }');
        const handle = await starting;
        const after = await probeChatgptUnblockListener(port, undefined, undefined, dir);
        await handle.stop(); pacServer.stop(true);
        console.log(JSON.stringify({ before: before.state, after: after.state }));
      `;
      const result = spawnSync(process.execPath, ["-e", source], { env: { ...process.env, PATH: dir, OPENCODEX_HOME: dir }, encoding: "utf8", timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      const states = JSON.parse(result.stdout.trim());
      expect(states.before).not.toBe("ours");
      expect(states.after).toBe("ours");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform !== "darwin")("chatgpt unblock PAC-mode startup", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-pac-runtime-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("resolver-rule mode starts no entry proxy and writes no PAC", async () => {
    const handle = await startChatgptUnblock({ config: config({ port: freePortPair() }), publicPort: 0, configDir: dir });
    expect(handle).not.toBeNull();
    expect(handle!.entryProxy).toBeUndefined();
    expect(handle!.pacRoute).toBeUndefined();
    expect(existsSync(chatgptUnblockPacPath(dir))).toBe(false);
    await handle!.stop();
  });

  test("PAC mode binds the entry listener and writes a PAC pointing chatgpt.com at it", async () => {
    const origin = freePortPair();
    const handle = await startChatgptUnblock({ config: config({ pacFallback: true, port: origin }), publicPort: 0, configDir: dir });
    expect(handle).not.toBeNull();
    expect(handle!.entryProxy!.port).toBe(origin + 1);
    expect(handle!.pacRoute).toBeDefined();
    const pac = readFileSync(chatgptUnblockPacPath(dir), "utf8");
    expect(pac).toContain(`if (host == "${CHATGPT_INTERCEPT_HOST}")`);
    expect(pac).toContain(`PROXY 127.0.0.1:${origin + 1}`);
    expect(await accepts(origin + 1)).toBe(true);
    // The readiness marker the watcher wakes on is written after the PAC it relaunches with.
    expect(existsSync(chatgptUnblockReadyPath(dir))).toBe(true);
    await handle!.stop();
    expect(await accepts(origin + 1)).toBe(false);
  });

  test("an entry bind failure fails the start instead of serving an unroutable PAC", async () => {
    const origin = freePortPair();
    const blocker = Bun.listen({ hostname: "127.0.0.1", port: origin + 1, socket: { data() {} } });
    try {
      await expect(startChatgptUnblock({ config: config({ pacFallback: true, port: origin }), publicPort: 0, configDir: dir })).rejects.toThrow();
      expect(await accepts(origin)).toBe(false);
    } finally {
      blocker.stop(true);
    }
  });

  test("a PAC write failure releases both listeners", async () => {
    const origin = freePortPair();
    // A directory where the PAC file goes makes the write fail after both listeners bound.
    mkdirSync(chatgptUnblockPacPath(dir));
    await expect(startChatgptUnblock({ config: config({ pacFallback: true, port: origin }), publicPort: 0, configDir: dir })).rejects.toThrow();
    expect(await accepts(origin)).toBe(false);
    expect(await accepts(origin + 1)).toBe(false);
  });
});
