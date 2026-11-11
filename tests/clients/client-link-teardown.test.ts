// First: in-process connectClient writes the catalog through src/codex/paths, fixed at import.
import { assertCodexHomeOwned } from "../helpers/codex-home-sandbox";
import { expect, spyOn, test } from "bun:test";
import { CODEX_HOME } from "../../src/codex/paths";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { handleDisconnectCommand } from "../../src/cli/connect";
import { connectClient } from "../../src/client/connect";
import { teardownClientLink } from "../../src/client/link-teardown";
import { clientLinkStatePath, writeClientLinkState } from "../../src/client/link-state";
import { quoteRemote, remoteOcxArgv } from "../../src/link/ssh-argv";
import { createTempHome } from "../helpers/temp-home";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { randomUUID } from "node:crypto";

const FIXTURE_TOKEN_FILE = ".ocx-fixture-token";

assertCodexHomeOwned(CODEX_HOME);

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


test("a desktop-remote folder with no state or receipt is named, with the way to clear it", async () => {
  const home = createTempHome("ocx-client-link-desktop-store-");
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
    // Seen on a Child: someone renamed the receipt, leaving the folder with nothing OpenCodex reads.
    mkdirSync(home.path("desktop-remote"), { recursive: true });
    writeFileSync(home.path("desktop-remote", "disconnect.json.stale-20261108"), "{}");
    const logs = spyOn(console, "log").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let exit = -1;
    let output = "";
    try {
      exit = await handleDisconnectCommand([], {
        lifecycleLockDeps: { lockPath: home.path("lifecycle.sqlite") },
        linkTeardownDeps: {
          reapOrphanTunnel: async () => ({ tunnel: "absent" }),
          runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
          knownHostsFile,
        },
      });
      output = errors.mock.calls.flat().join("\n");
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
    expect(exit).not.toBe(0);
    expect(output).toContain("desktop_lifecycle_unsafe");
    expect(output).toContain(realpathSync.native(home.path("desktop-remote")));
    expect(output).toContain("holds no Claude Desktop remote state or disconnect receipt");
    expect(output).toContain("Move that folder aside, then run ocx disconnect again");
  } finally {
    home.remove();
  }
});

/**
 * Scenarios that write the Codex files directly. Those paths are fixed when src/codex/paths loads,
 * so they run in tests/fixtures/client-link-journal-runner.ts, a child whose CODEX_HOME and
 * OPENCODEX_HOME point into this test's own temp home before anything is imported; this process
 * never touches a Codex path, and only that owned home is removed.
 */
async function runJournalScenario(scenario: "catalog-changed" | "standalone-handover" | "foreign-journal") {
  const home = createTempHome("ocx-client-link-journal-");
  try {
    const codex = home.path("codex");
    mkdirSync(codex, { recursive: true });
    mkdirSync(home.path("ocx"), { recursive: true });
    // The runner writes only into a home that carries the one-time token this process hands it.
    const token = randomUUID();
    writeFileSync(home.path(FIXTURE_TOKEN_FILE), token);
    const child = Bun.spawn([process.execPath, fixturePath("client-link-journal-runner.ts")], {
      cwd: repoPath(), stdin: new Blob([scenario]), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home.root, USERPROFILE: home.root, OPENCODEX_HOME: home.path("ocx"), CODEX_HOME: codex, OCX_SERVICE: "", OCX_SERVICE_MANAGED: "0", OCX_FIXTURE_TOKEN: token },
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as { exit?: number; injected?: boolean; before?: unknown; after?: unknown; warnings: string[]; errors: string[] };
  } finally {
    home.remove();
  }
}

test("a catalog changed after connect names what was found and --keep-catalog", async () => {
  const result = await runJournalScenario("catalog-changed");
  expect(result.exit).not.toBe(0);
  const output = result.errors.join("\n");
  expect(output).toContain("client_catalog_ownership_changed");
  expect(output).toContain("matches neither the catalog this connection wrote nor the one recorded before it connected");
  expect(output).toContain("ocx disconnect --keep-catalog");
});

test("connect --link over a standalone injection hands the Codex journal to the committed client", async () => {
  const result = await runJournalScenario("standalone-handover");
  expect(result.injected).toBe(true);
  expect((result.before as { kind: string }).kind).toBe("process");
  expect(result.after).toEqual({ kind: "client", apiKeyId: "key-1" });
});

// Review round 4: a connect over a journal an earlier connection owns must say so, not report a
// clean handover; the routing is restored on the next restart and a sync after it re-applies it.
test("connect over an earlier connection's Codex journal warns with the recovery step", async () => {
  const result = await runJournalScenario("foreign-journal");
  expect(result.after).toEqual({ kind: "client", apiKeyId: "earlier-key" });
  expect(result.warnings.join("\n")).toContain("belongs to an earlier connection");
  expect(result.warnings.join("\n")).toContain("ocx sync --restart-codex");
});


// Coordinator review round 4: run by hand, with HOME pointing at a real home, the runner must
// refuse before any write. A temp folder stands in for that home and is asserted untouched.
test("the journal runner refuses a home its parent did not create, and writes nothing", async () => {
  const home = createTempHome("ocx-client-link-runner-direct-");
  try {
    const realLike = home.path("real-home");
    mkdirSync(join(realLike, ".codex"), { recursive: true });
    mkdirSync(join(realLike, ".opencodex"), { recursive: true });
    writeFileSync(join(realLike, ".codex", "config.toml"), "model_provider = \"real\"\n");
    writeFileSync(join(realLike, ".opencodex", "config.json"), "{\"real\":true}");
    for (const token of [undefined, "forged-token"]) {
      const child = Bun.spawn([process.execPath, fixturePath("client-link-journal-runner.ts")], {
        cwd: repoPath(), stdin: new Blob(["standalone-handover"]), stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: realLike, OPENCODEX_HOME: join(realLike, ".opencodex"), CODEX_HOME: join(realLike, ".codex"), ...(token ? { OCX_FIXTURE_TOKEN: token } : {}) },
      });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr.trim().split("\n")).toEqual(["client-link-journal-runner.ts is a test fixture; run it through tests/clients/client-link-teardown.test.ts."]);
    }
    expect(readdirSync(join(realLike, ".codex"))).toEqual(["config.toml"]);
    expect(readFileSync(join(realLike, ".codex", "config.toml"), "utf8")).toBe("model_provider = \"real\"\n");
    expect(readdirSync(join(realLike, ".opencodex"))).toEqual(["config.json"]);
    expect(readFileSync(join(realLike, ".opencodex", "config.json"), "utf8")).toBe("{\"real\":true}");
  } finally {
    home.remove();
  }
});
