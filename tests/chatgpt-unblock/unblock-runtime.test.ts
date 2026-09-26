import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET,
  chatgptPacFallbackEnabled,
  chatgptUnblockEntryPort,
  chatgptUnblockPacArg,
  chatgptUnblockPacPath,
  chatgptUnblockPort,
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

  test("the PAC argument names a file:// URL inside the config dir", () => {
    expect(chatgptUnblockPacArg("/Users/x/.opencodex")).toBe("--proxy-pac-url=file:///Users/x/.opencodex/chatgpt-unblock.pac");
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
});
