import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { bindClientListener, startClientRuntime } from "../../src/client/runtime";
import type { OcxClientConnectionConfig } from "../../src/types";

function linkClientState(): OcxClientConnectionConfig {
  const token = `ocx_data_${"c".repeat(40)}`;
  return {
    serverUrl: "http://127.0.0.1:34567",
    managementUrl: "http://127.0.0.1:34567",
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" },
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "key-1",
    tokenFingerprint: serviceApiTokenFingerprint(token),
    protocolVersion: 1,
    connectedAt: "2026-09-25T00:00:00.000Z",
  };
}

function servePlain(port: number): Server<unknown> {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("bound") });
}

test("link runtime refuses a busy configured port instead of selecting an ephemeral port", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-client-link-runtime-"));
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("held") });
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const config = getDefaultConfig();
    config.port = holder.port!;
    config.runtimeRole = "client";
    config.client = linkClientState();
    saveConfig(config);
    // A port held past the whole budget still fails with the same message; the budget is short here.
    await expect(startClientRuntime({ block: false }, { portWaitMs: 300 }))
      .rejects.toThrow(`link mode needs port ${holder.port}`);
  } finally {
    holder.stop(true);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

describe("link runtime waits for its configured port like a hard-pinned start", () => {
  test("a port its restarting parent releases after the short prefer-retry still binds", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("parent") });
    const port = holder.port!;
    // Longer than the 750ms prefer-retry that used to be the whole budget.
    const release = setTimeout(() => holder.stop(true), 1_500);
    let bound: Server<unknown> | undefined;
    const started = Date.now();
    try {
      const result = await bindClientListener({
        state: linkClientState(),
        linkMode: true,
        preferred: port,
        explicitPort: false,
        configuredPort: port,
      }, {
        portWaitMs: 10_000,
        startListener: p => (bound = servePlain(p!)),
      });
      expect(result.port).toBe(port);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    } finally {
      clearTimeout(release);
      holder.stop(true);
      bound?.stop(true);
    }
  });

  test("a bind that loses the port after the probe is retried", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port!;
    probe.stop(true);
    let calls = 0;
    let bound: Server<unknown> | undefined;
    try {
      const result = await bindClientListener({
        state: linkClientState(),
        linkMode: true,
        preferred: port,
        explicitPort: true,
        configuredPort: port,
      }, {
        portWaitMs: 5_000,
        startListener: p => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error(`Failed to start server. Is port ${p} in use?`), { code: "EADDRINUSE" });
          return (bound = servePlain(p!));
        },
      });
      expect(calls).toBe(2);
      expect(result.port).toBe(port);
    } finally {
      bound?.stop(true);
    }
  });

  test("a hub-transport client keeps its single bind attempt", async () => {
    let calls = 0;
    const attempt = bindClientListener({
      state: { ...linkClientState(), transport: undefined, link: undefined },
      linkMode: false,
      preferred: 0,
      explicitPort: false,
      configuredPort: 0,
    }, {
      startListener: () => {
        calls += 1;
        throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      },
    });
    await expect(attempt).rejects.toThrow("in use");
    expect(calls).toBe(1);
  });
});
