import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatgptUnblockEnabled, chatgptUnblockPort, chatgptUnblockResolverArg, startChatgptUnblock,
} from "../../src/chatgpt/desktop-unblock/runtime";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function config(chatgptDesktop: OcxConfig["chatgptDesktop"] = { unblockSend: true }): OcxConfig {
  return { chatgptDesktop } as OcxConfig;
}

describe("ChatGPT intercept without PAC or a duplicate shim", () => {
  test("stable offset, explicit port and resolver switch", () => {
    expect(chatgptUnblockPort(config(), 10100)).toBe(10300);
    expect(chatgptUnblockPort(config({ port: 65535 }), 10100)).toBe(65535);
    expect(() => chatgptUnblockPort(config(), 65336)).toThrow("out of range");
    expect(chatgptUnblockResolverArg(10300)).toBe("--host-resolver-rules=MAP chatgpt.com 127.0.0.1:10300");
  });
  test("shim alone never starts the intercept; client role disables it", async () => {
    expect(chatgptUnblockEnabled(config({ appServerShim: true }))).toBe(false);
    expect(chatgptUnblockEnabled({ ...config(), runtimeRole: "client" })).toBe(false);
    expect(chatgptUnblockEnabled(config())).toBe(process.platform === "darwin");
    expect(await startChatgptUnblock({ config: config({ appServerShim: true }), publicPort: 10100 })).toBeNull();
  });
  test.skipIf(process.platform !== "darwin")("resolver mode binds only its TLS listener and stops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-runtime-"));
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    let handle: Awaited<ReturnType<typeof startChatgptUnblock>> = null;
    try {
      handle = await startChatgptUnblock({ config: config({ unblockSend: true, port }), publicPort: 10100, configDir: dir });
      expect(handle).not.toBeNull();
      expect(handle!.listener.port).toBe(port);
      expect(existsSync(handle!.caCertPath)).toBe(true);
      expect(existsSync(join(dir, "chatgpt-unblock.pac"))).toBe(false);
      expect(existsSync(join(dir, "chatgpt-codex-shim.sh"))).toBe(false);
      await handle!.stop();
      handle = null;
      const rebound = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      rebound.stop(true);
    } finally {
      await handle?.stop();
      removeTreeWithRetry(dir);
    }
  });
});
