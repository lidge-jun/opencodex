import { describe, expect, spyOn, test } from "bun:test";
import { ManagementRequest as Request } from "./management-auth";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { catalogConvergenceFactory } from "./catalog-convergence";

export function config(hostname?: string): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        headers: { "X-Custom": "provider-secret" },
        defaultModel: "gpt-test",
      },
    },
  };
}

export function registerRelativeSendPathTests(TEST_DIR: string): void {
describe("relative send paths at the management write boundary", () => {
  const provider = { adapter: "openai-responses" as const, baseUrl: "https://relay.example.test/v1" };
  const fields = ["responsesPath", "chatCompletionsPath"] as const;

  test.each(fields)("rejects invalid %s values through the shared management validator", field => {
    expect(providerManagementConfigError("relay", provider)).toBeNull();
    expect(providerManagementConfigError("relay", { ...provider, [field]: "/custom/send" })).toBeNull();
    for (const value of ["@other.example.test/send", "https://other.example.test/send", "/send?query=1", "/send#fragment", "", 42, null, {}]) {
      expect(providerManagementConfigError("relay", { ...provider, [field]: value })).toContain(field);
    }
  });

  for (const field of fields) {
    for (const mode of ["create", "replace"]) {
      test(`${mode} rejects invalid ${field} before changing memory or disk`, async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        process.env.OPENCODEX_HOME = TEST_DIR;
        const cfg: OcxConfig = { port: 10100, hostname: "127.0.0.1", defaultProvider: "stable",
          providers: { stable: { ...provider, responsesPath: "/existing", chatCompletionsPath: "/existing-chat" } } };
        saveConfig(cfg);
        const beforeMemory = structuredClone(cfg);
        const beforeDisk = readFileSync(join(TEST_DIR, "config.json"));
        const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
        let refreshes = 0;
        try {
          for (const value of ["@other.example.test/send", "https://other.example.test/send", "/send?query=1", "/send#fragment", "", 42]) {
            const name = mode === "create" ? "new-provider" : "stable";
            const url = new URL("http://127.0.0.1/api/providers");
            const response = await handleManagementAPI(new Request(url, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ name, provider: { ...provider, [field]: value } }),
            }), url, cfg, { createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshes++; }) });
            expect(response?.status).toBe(400);
            expect(await response!.json()).toMatchObject({ error: expect.stringContaining(field) });
            expect(cfg).toEqual(beforeMemory);
            expect(readFileSync(join(TEST_DIR, "config.json"))).toEqual(beforeDisk);
          }
          expect(resolved).not.toHaveBeenCalled();
          expect(refreshes).toBe(0);
        } finally { resolved.mockRestore(); }
      });
    }
  }

  test.each(fields)("PATCH revalidates an existing invalid %s without changing state", async field => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const cfg: OcxConfig = { port: 10100, hostname: "127.0.0.1", defaultProvider: "stable",
      providers: { stable: { ...provider, [field]: "@other.example.test/send" } } };
    // Model a live row accepted before the write-boundary fix. PATCH edits supported
    // transport fields; it does not itself expose a send-path setter.
    saveConfig(cfg);
    const beforeMemory = structuredClone(cfg);
    const beforeDisk = readFileSync(join(TEST_DIR, "config.json"));
    const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    let refreshes = 0;
    try {
      const url = new URL("http://127.0.0.1/api/providers?name=stable");
      const response = await handleManagementAPI(new Request(url, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://replacement.example.test/v1" }),
      }), url, cfg, { createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshes++; }) });
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: expect.stringContaining(field) });
      expect(cfg).toEqual(beforeMemory);
      expect(readFileSync(join(TEST_DIR, "config.json"))).toEqual(beforeDisk);
      expect(resolved).not.toHaveBeenCalled();
      expect(refreshes).toBe(0);
    } finally { resolved.mockRestore(); }
  });

  test("valid relative send paths remain persistable and reloadable", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const cfg: OcxConfig = { port: 10100, hostname: "127.0.0.1", defaultProvider: "stable", providers: { stable: { ...provider } } };
    saveConfig(cfg);
    const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const url = new URL("http://127.0.0.1/api/providers");
      const response = await handleManagementAPI(new Request(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "custom-paths", provider: { ...provider, responsesPath: "/custom/responses", chatCompletionsPath: "/custom/chat" } }),
      }), url, cfg, { createManagementConvergeCodex: catalogConvergenceFactory() });
      expect(response?.status).toBe(200);
      expect(cfg.providers["custom-paths"]?.responsesPath).toBe("/custom/responses");
      expect(loadConfig().providers["custom-paths"]?.chatCompletionsPath).toBe("/custom/chat");
    } finally { resolved.mockRestore(); }
  });
});

}
