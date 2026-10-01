import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  chatgptUnblockShimPath,
  startChatgptUnblock,
} from "../../src/chatgpt/desktop-unblock/runtime";
import { CHATGPT_INTERCEPT_HOST } from "../../src/chatgpt/desktop-unblock/listener";
import type { OcxConfig } from "../../src/types";

function config(overrides: Partial<NonNullable<OcxConfig["chatgptDesktop"]>> = {}): OcxConfig {
  return { chatgptDesktop: { unblockSend: true, ...overrides } } as OcxConfig;
}

describe("chatgpt unblock runtime ports and mode", () => {
  test("the entry port is one after the origin port", () => {
    expect(chatgptUnblockPort(config(), 10100)).toBe(10300);
    expect(chatgptUnblockEntryPort(config(), 10100)).toBe(10300 + CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET);
  });

  test("an origin port at 65535 wraps the entry port to 65534 instead of leaving the range", () => {
    expect(chatgptUnblockPort(config({ port: 65535 }), 10100)).toBe(65535);
    expect(chatgptUnblockEntryPort(config({ port: 65535 }), 10100)).toBe(65534);
  });

  test("pacFallback implies unblockSend and is off by default", () => {
    expect(chatgptPacFallbackEnabled(config())).toBe(false);
    expect(chatgptPacFallbackEnabled(config({ pacFallback: true }))).toBe(true);
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

/**
 * A free origin/entry port pair away from the defaults (10300/10301 belong to a local
 * opencodex on the default public port).
 */
function freePortPair(): number {
  for (;;) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const origin = probe.port;
    probe.stop(true);
    if (origin >= 65535) continue;
    try {
      Bun.listen({ hostname: "127.0.0.1", port: origin + 1, socket: { data() {} } }).stop(true);
      return origin;
    } catch {
      // the entry half is taken; try another pair
    }
  }
}

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

  test("a system PAC too large for the launch switch falls back to the proxy chain", () => {
    // The switch is base64 inside one argv entry; past ARG_MAX `open` fails after the app quit.
    const bigger = `${systemPac}\n// ${"x".repeat(3_000)}`;
    const pac = chooseChatgptUnblockPac(10301, chain, bigger, 2_000);
    expect(pac.route).toBe("system-pac-too-large");
    expect(pac.text).not.toContain(bigger);
    expect(pac.text).toContain("PROXY 127.0.0.1:7892");
    expect(chatgptUnblockPacArgFor(pac.text).length).toBeLessThanOrEqual(2_000);
  });

  test("the default limit refuses a whitelist-sized PAC and keeps the switch well under ARG_MAX", () => {
    const large = `function FindProxyForURL(url, host) { ${"if (dnsDomainIs(host, '.example.test')) return 'DIRECT';\n".repeat(12_000)} return "PROXY 127.0.0.1:7892"; }`;
    expect(large.length).toBeGreaterThan(600 * 1024);
    const pac = chooseChatgptUnblockPac(10301, chain, large);
    expect(pac.route).toBe("system-pac-too-large");
    expect(chatgptUnblockPacArgFor(pac.text).length).toBeLessThanOrEqual(CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES);
    expect(CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES).toBeLessThan(1024 * 1024);
  });

  test("without a system PAC the route says whether one was configured", () => {
    expect(chooseChatgptUnblockPac(10301, chain, null).route).toBe("system-pac-unreadable");
    expect(chooseChatgptUnblockPac(10301, { ...chain, autoConfig: false, autoConfigUrl: null }, null).route).toBe("system-proxy");
  });
});

describe("chatgpt unblock PAC-mode startup", () => {
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

  test("an app-server launcher write failure releases the listeners", async () => {
    const origin = freePortPair();
    // A directory where the launcher goes makes the write fail after the listeners bound.
    mkdirSync(chatgptUnblockShimPath(dir));
    await expect(startChatgptUnblock({ config: config({ pacFallback: true, appServerShim: true, port: origin }), publicPort: 0, configDir: dir })).rejects.toThrow();
    expect(await accepts(origin)).toBe(false);
    expect(await accepts(origin + 1)).toBe(false);
  });
});
