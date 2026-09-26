import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { handleDisconnectCommand } from "../../src/cli/connect";
import { connectClient } from "../../src/client/connect";
import { teardownClientLink } from "../../src/client/link-teardown";
import { clientLinkStatePath, writeClientLinkState } from "../../src/client/link-state";
import { quoteRemote, remoteOcxArgv } from "../../src/link/ssh-argv";
import { createTempHome } from "../helpers/temp-home";

const linkId = "lnk_0123456789abcdef";
const key = `ocx_data_${"a".repeat(40)}`;
const knownHostsFile = "/tmp/opencodex-link-known-hosts";

function sidecar() {
  return {
    linkId,
    alias: "home.example.test",
    hubHostKeyFingerprint: "SHA256:ABCDEFGHIJKLMNOP",
    peerListenerPort: 20100,
    tunnelPort: 34567,
  };
}

test("teardown revokes the matching link once and returns tunnel state", async () => {
  const calls: Array<{ argv: readonly string[]; timeoutMs?: number }> = [];
  const result = await teardownClientLink({
    readSidecar: () => sidecar(),
    connectedLinkId: () => linkId,
    reapOrphanTunnel: async () => ({ tunnel: "owned" }),
    runner: {
      run: async (argv, options) => {
        calls.push({ argv, timeoutMs: options?.timeoutMs });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    knownHostsFile,
  });
  expect(result).toEqual({ linkId, homeRevoke: "revoked", tunnel: { tunnel: "owned" } });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.timeoutMs).toBe(30_000);
  expect(calls[0]?.argv).toContain("home.example.test");
  // The revoke runs through the remote PATH prelude, never as a bare `ocx`.
  expect(calls[0]?.argv.at(-1)).toBe(quoteRemote(remoteOcxArgv(["link", "revoke", "--link-id", linkId])));
});

test("teardown reports revoke failure and leaves a mismatched sidecar alone", async () => {
  let calls = 0;
  const failed = await teardownClientLink({
    readSidecar: () => sidecar(),
    connectedLinkId: () => linkId,
    reapOrphanTunnel: async () => ({ tunnel: "absent" }),
    runner: {
      run: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "" };
      },
    },
    knownHostsFile,
  });
  expect(failed).toEqual({ linkId, homeRevoke: "failed", tunnel: { tunnel: "absent" } });

  const mismatch = await teardownClientLink({
    readSidecar: () => sidecar(),
    connectedLinkId: () => "lnk_fedcba9876543210",
    reapOrphanTunnel: async () => ({ tunnel: "reaped" }),
    runner: { run: async () => { calls += 1; return { code: 0, stdout: "", stderr: "" }; } },
    knownHostsFile,
  });
  expect(mismatch).toEqual({ linkId: null, homeRevoke: "not_applicable", tunnel: { tunnel: "reaped" } });
  expect(calls).toBe(1);
});

test("disconnect output reports an unresolved tunnel", async () => {
  const home = createTempHome("ocx-client-link-teardown-");
  try {
    const config = getDefaultConfig();
    config.port = 10100;
    saveConfig(config);
    mkdirSync(home.codexHome, { recursive: true });
    writeFileSync(home.path(".codex", "config.toml"), "model_provider = \"openai\"\n");
    await connectClient({
      serverUrl: "http://127.0.0.1:34567",
      managementUrl: "http://127.0.0.1:34567",
      managementTransport: "direct",
      transport: "link",
      link: { tunnelPort: 34567, linkId },
      credential: { kind: "link", apiKeyId: "key-1", key },
      selectedClients: ["codex"],
      noSync: true,
    }, {
      fetchImpl: async input => String(input).endsWith("/readyz")
        ? Response.json({ status: "ready", protocol: 1, minimumClientProtocol: 1, managementUrl: "http://127.0.0.1:34567" })
        : Response.json({ models: [] }),
      catalogCompatibility: { supportedEfforts: () => new Set() },
      lifecycleLockDeps: { lockPath: home.path("lifecycle.sqlite") },
    });
    writeClientLinkState(sidecar(), clientLinkStatePath(home.configDir));
    const logs = spyOn(console, "log").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let exit = -1;
    let output = "";
    try {
      exit = await handleDisconnectCommand([], {
        lifecycleLockDeps: { lockPath: home.path("lifecycle.sqlite") },
        linkTeardownDeps: {
          reapOrphanTunnel: async () => ({ tunnel: "unresolved", pid: 4242 }),
          runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
          knownHostsFile,
        },
      });
      output = logs.mock.calls.flat().join("\n");
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
    expect(exit).toBe(0);
    expect(output).toContain(
      "A link tunnel (pid 4242) may still be running; stop it if it is.",
    );
    expect(output).toContain(
      `Home revoke failed; run ocx link revoke --link-id ${linkId} on the home.`,
    );
    expect(existsSync(clientLinkStatePath(home.configDir))).toBe(false);
  } finally {
    home.remove();
  }
});

test("an unreadable sidecar skips the revoke but still reports the manual revoke for a link client", async () => {
  let calls = 0;
  const order: string[] = [];
  const runner = { run: async () => { calls += 1; return { code: 0, stdout: "", stderr: "" }; } };
  const unreadable = () => { order.push("sidecar"); throw new Error("client-link.json is not valid JSON"); };
  const linked = await teardownClientLink({
    readSidecar: unreadable,
    connectedLinkId: () => linkId,
    reapOrphanTunnel: async () => { order.push("reap"); return { tunnel: "absent" }; },
    runner,
    knownHostsFile,
  });
  expect(linked).toEqual({ linkId, homeRevoke: "failed", tunnel: { tunnel: "absent" } });
  expect(order).toEqual(["reap", "sidecar"]);
  const standalone = await teardownClientLink({
    readSidecar: unreadable,
    connectedLinkId: () => null,
    reapOrphanTunnel: async () => ({ tunnel: "absent" }),
    runner,
    knownHostsFile,
  });
  expect(standalone).toEqual({ linkId: null, homeRevoke: "not_applicable", tunnel: { tunnel: "absent" } });
  expect(calls).toBe(0);
});
