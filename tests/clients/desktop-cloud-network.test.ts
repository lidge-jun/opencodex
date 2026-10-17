import { describe, expect, mock, spyOn, test } from "bun:test";
import { cloudNetworkArguments, handleChatgptNetworkCommand } from "../../src/cli/chatgpt-network-command";
import { handleChatgptCommand } from "../../src/cli/chatgpt-command";
import { maybeAutoRestoreCodexShim } from "../../src/cli/codex-shim-autorestore";
import { cloudHelperLaunchArgv, cloudHelperPlist, bundleCloudHelperSource } from "../../src/chatgpt/cloud-network/install";

describe("integrated cloud network CLI", () => {
  test("public and privileged namespaces never run unrelated shim repair", () => {
    const unexpected = mock(() => { throw new Error("unexpected shim/config access"); });
    for (const args of [["chatgpt", "network", "enable"], ["chatgpt", "network", "bad"],
      ["internal", "chatgpt-cloud-network", "serve"], ["internal", "chatgpt-cloud-network", "install"]]) {
      maybeAutoRestoreCodexShim(args[0], args, { env: {}, readConfig: unexpected, restore: unexpected, warn: unexpected });
    }
    expect(unexpected).not.toHaveBeenCalled();
  });

  test("formal commands accept no separate app, proxy, hosts path or listener port", () => {
    for (const action of ["status", "enable", "disable", "recover", "install", "uninstall"]) expect(cloudNetworkArguments([action]).action).toBe(action);
    expect(cloudNetworkArguments(["install", "--yes"]).yes).toBe(true);
    for (const args of [[], ["activate"], ["deactivate"], ["sandbox"], ["enable", "--proxy-port", "8123"],
      ["status", "--app", "/Applications/Other.app"], ["enable", "--port", "443"],
      ["recover", "--hosts", "/tmp/hosts"], ["enable", "--yes"], ["install", "--yes", "--yes"]]) {
      expect(() => cloudNetworkArguments(args)).toThrow("Usage");
    }
  });

  test("help and non-macOS refusal have no installation or runtime side effects", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await handleChatgptCommand(["network", "help"], "linux")).toBe(0);
      expect(log.mock.calls.flat().join(" ")).toContain("built into OpenCodex");
      expect(await handleChatgptCommand(["network", "sandbox", "--help"], "linux")).toBe(64);
      expect(log.mock.calls.flat().join(" ")).not.toContain("hosts.fixture");
      expect(await handleChatgptNetworkCommand(["install", "--yes"], "linux")).toBe(1);
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  test("live actions use the existing management client and report refused activation", async () => {
    const calls: string[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const deps = { baseUrl: "http://127.0.0.1:1", fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return Response.json({ ok: true, network: { state: "active", applicationHandshake: "unverified" } });
    }) as typeof fetch };
    try {
      for (const action of ["status", "enable", "disable", "recover"]) expect(await handleChatgptNetworkCommand([action], "darwin", deps)).toBe(0);
      expect(calls).toEqual(["GET /api/chatgpt-network/status", "POST /api/chatgpt-network/enable", "POST /api/chatgpt-network/disable", "POST /api/chatgpt-network/recover"]);
      expect(await handleChatgptNetworkCommand(["enable"], "darwin", { ...deps,
        fetchImpl: (async () => Response.json({ error: "helper missing" }, { status: 409 })) as typeof fetch })).toBe(1);
      expect(error.mock.calls.flat().join(" ")).toContain("helper missing");
      expect(await handleChatgptNetworkCommand(["enable"], "darwin", { findLiveProxy: async () => null })).toBe(1);
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});

test("source and packaged helper launch plans use only the installed root-owned copy", async () => {
  const root = "/Library/Application Support/OpenCodex/cloud-network";
  expect(cloudHelperLaunchArgv(root, true)).toEqual([`${root}/runtime`, "internal", "chatgpt-cloud-network", "serve"]);
  expect(cloudHelperLaunchArgv(root, false)).toEqual([`${root}/runtime`, `${root}/helper.js`]);
  const plist = cloudHelperPlist(cloudHelperLaunchArgv(root, false));
  expect(plist).toContain("<key>KeepAlive</key><true/>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).not.toContain("com.opencodex.proxy");
  const bundle = await bundleCloudHelperSource();
  expect(bundle).toContain("runSystemCloudHelper");
  expect(bundle).not.toContain("loadConfig");
});
