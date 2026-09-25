import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { clientConnectionSchema } from "../../src/config/schema/leaf-validators";
import { handleConnectCommand, handleDisconnectCommand } from "../../src/cli/connect";
import { readSecretBytes } from "../../src/cli/runtime-api";
import { connectClient, routingTarget } from "../../src/client/connect";
import { readServiceApiTokenState } from "../../src/lib/service-secrets";
import { isLinkConnection, readClientConnectionState } from "../../src/client/state";
import { DEFAULT_CATALOG_PATH } from "../../src/codex/paths";

const linkId = "lnk_0123456789abcdef";
const key = `ocx_data_${"a".repeat(40)}`;

function client(overrides: Record<string, unknown> = {}) {
  return {
    serverUrl: "http://127.0.0.1:34567",
    managementUrl: "http://127.0.0.1:34567",
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort: 34567, linkId },
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "key-1",
    tokenFingerprint: "a".repeat(64),
    protocolVersion: 1,
    connectedAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("client link connection contracts", () => {
  test("validates the link field chain and rejects incompatible transport combinations", () => {
    expect(clientConnectionSchema.safeParse(client()).success).toBe(true);
    expect(clientConnectionSchema.safeParse(client({ transport: "hub" })).success).toBe(false);
    expect(clientConnectionSchema.safeParse(client({ managementTransport: "relay" })).success).toBe(false);
    expect(clientConnectionSchema.safeParse(client({ link: { tunnelPort: 1023, linkId } })).success).toBe(false);
    expect(clientConnectionSchema.safeParse(client({ serverUrl: "https://127.0.0.1:34567" })).success).toBe(false);
  });

  test("uses the local configured port for Codex while retaining link mode identity", () => {
    const target = routingTarget("http://127.0.0.1:34567", 10100);
    expect(target.baseUrl).toBe("http://localhost:10100/v1");
    expect(target.requiresAdmissionToken).toBe(true);
    expect(isLinkConnection(client() as never)).toBe(true);
    expect(isLinkConnection(undefined)).toBe(false);
  });

  test("bounds raw stdin bytes at 4 KiB", async () => {
    const input = new EventEmitter() as EventEmitter & { readableEnded?: boolean };
    input.readableEnded = false;
    const pending = readSecretBytes({ stdinImpl: input as never, stdinTimeoutMs: 1000 }, "link credential");
    const chunk = Buffer.alloc(4097, 0x61);
    input.emit("data", chunk);
    await expect(pending).rejects.toThrow("exceeds 4096 bytes");
    expect(chunk.every(byte => byte === 0)).toBe(true);
  });

  test("zeroes a Buffer source after successful secret parsing", async () => {
    const input = new EventEmitter() as EventEmitter & { readableEnded?: boolean };
    input.readableEnded = false;
    const chunk = Buffer.from("secret");
    const pending = readSecretBytes({ stdinImpl: input as never, stdinTimeoutMs: 1000 }, "link credential");
    input.emit("data", chunk);
    input.emit("end");
    await expect(pending).resolves.toEqual(new TextEncoder().encode("secret"));
    expect(chunk.every(byte => byte === 0)).toBe(true);
  });

  async function withLinkHome(run: (home: string, codexHome: string) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "ocx-client-link-contract-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-client-link-contract-codex-"));
    const previousHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = codexHome;
    try {
      const config = getDefaultConfig();
      config.port = 10100;
      saveConfig(config);
      await run(home, codexHome);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  }

  function linkOptions() {
    return {
      serverUrl: "http://127.0.0.1:34567",
      managementUrl: "http://127.0.0.1:34567",
      managementTransport: "direct" as const,
      transport: "link" as const,
      link: { tunnelPort: 34567, linkId },
      credential: { kind: "link" as const, apiKeyId: "key-1", key },
      selectedClients: ["claude" as const],
      noSync: true,
    };
  }

  test("readiness failure removes the pending link token and leaves config.client unset", async () => {
    await withLinkHome(async home => {
      await expect(connectClient(linkOptions(), {
        fetchImpl: async () => Response.json({
          service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
          status: "pending", protocol: 1, minimumClientProtocol: 1,
          managementUrl: "http://127.0.0.1:34567",
        }, { status: 503 }),
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
      })).rejects.toThrow("hub is not ready");
      expect(readServiceApiTokenState()).toEqual({ kind: "absent" });
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
    });
  });

  test("catalog failure removes the pending link token and leaves config.client unset", async () => {
    await withLinkHome(async home => {
      await expect(connectClient(linkOptions(), {
        fetchImpl: async input => String(input).endsWith("/readyz")
          ? Response.json({
            service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
            status: "ready", protocol: 1, minimumClientProtocol: 1,
            managementUrl: "http://127.0.0.1:34567",
          })
          : new Response("catalog failed", { status: 503 }),
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
      })).rejects.toThrow("Hub catalog request failed");
      expect(readServiceApiTokenState()).toEqual({ kind: "absent" });
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
    });
  });

  test("link disconnect restores the prior catalog, clears config.client, and omits the key", async () => {
    await withLinkHome(async home => {
      writeFileSync(DEFAULT_CATALOG_PATH, '{"models":[{"id":"prior"}]}\n');
      const connection = await connectClient(linkOptions(), {
        fetchImpl: async input => String(input).endsWith("/readyz")
          ? Response.json({
            service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
            status: "ready", protocol: 1, minimumClientProtocol: 1,
            managementUrl: "http://127.0.0.1:34567",
          })
          : Response.json({ models: [] }),
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
      });
      expect(connection.transport).toBe("link");
      const logs = spyOn(console, "log").mockImplementation(() => {});
      try {
        await handleDisconnectCommand([], { lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") } });
      } finally {
        logs.mockRestore();
      }
      expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe('{"models":[{"id":"prior"}]}\n');
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
      expect(readServiceApiTokenState()).toEqual({ kind: "absent" });
      expect(existsSync(join(home, "service-api-token"))).toBe(false);
      expect(logs.mock.calls.flat().join(" ")).not.toContain(key);
    });
  });

  test("does not echo malformed link keys from stdin", async () => {
    const input = new EventEmitter() as EventEmitter & { readableEnded?: boolean };
    input.readableEnded = false;
    const secret = `ocx_data_${"b".repeat(40)}`;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const pending = handleConnectCommand([
      "--link", "--key-stdin", "--tunnel-port", "34567", "--link-id", linkId,
    ], { stdinImpl: input as never, stdinTimeoutMs: 1000 });
    input.emit("data", Buffer.from(`{\"apiKeyId\":\"key-1\",\"key\":\"${secret}\"`));
    input.emit("end");
    expect(await pending).toBe(2);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(secret);
    errors.mockRestore();
  });

  test("connects through the link credential strategy without issuing a hub key", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-client-link-connect-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-client-link-codex-"));
    const previousHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = codexHome;
    try {
      const config = getDefaultConfig();
      config.port = 10100;
      saveConfig(config);
      writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n');
      const calls: Array<{ url: string; key?: string }> = [];
      const fetchImpl: typeof fetch = async (input, init = {}) => {
        const headers = new Headers(init.headers);
        const url = String(input);
        calls.push({ url, key: headers.get("x-opencodex-api-key") ?? undefined });
        if (url.endsWith("/readyz")) {
          return Response.json({
            service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
            status: "ready", protocol: 1, minimumClientProtocol: 1,
            managementUrl: "http://127.0.0.1:34567",
          });
        }
        if (url.endsWith("/v1/catalog")) return Response.json({ models: [] });
        throw new Error(`unexpected link request ${url}`);
      };
      const connection = await connectClient({
        serverUrl: "http://127.0.0.1:34567",
        managementUrl: "http://127.0.0.1:34567",
        managementTransport: "direct",
        transport: "link",
        link: { tunnelPort: 34567, linkId },
        credential: { kind: "link", apiKeyId: "key-1", key },
        selectedClients: ["claude"],
        noSync: true,
      }, {
        fetchImpl,
        catalogCompatibility: { supportedEfforts: () => new Set() },
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
      });
      expect(connection.transport).toBe("link");
      expect(connection.link).toEqual({ tunnelPort: 34567, linkId });
      expect(connection.serverUrl).toBe("http://127.0.0.1:34567");
      expect(readServiceApiTokenState()).toMatchObject({ kind: "present", token: key });
      expect(calls.map(call => call.url)).toEqual([
        "http://127.0.0.1:34567/readyz",
        "http://127.0.0.1:34567/v1/catalog",
      ]);
      expect(calls[0]?.key).toBe(key);
      expect(calls[1]?.key).toBe(key);
      expect(calls.some(call => call.url.includes("/api/keys"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
