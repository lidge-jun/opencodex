import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { clientConnectionSchema } from "../../src/config/schema/leaf-validators";
import { handleConnectCommand } from "../../src/cli/connect";
import { readSecretBytes } from "../../src/cli/runtime-api";
import { connectClient, routingTarget } from "../../src/client/connect";
import { readServiceApiTokenState } from "../../src/lib/service-secrets";
import { isLinkConnection } from "../../src/client/state";

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
    input.emit("data", Buffer.alloc(4097, 0x61));
    await expect(pending).rejects.toThrow("exceeds 4096 bytes");
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
