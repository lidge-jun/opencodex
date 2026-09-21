import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, saveConfig } from "../../src/config";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { providerEditorConfigDTO } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import {
  providerCatalogCapabilityConfigError,
  withProviderCatalogCapabilityDTO,
} from "../../src/server/management/provider-capability-config";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(60_000);

test("synthetic-max config survives provider POST, PATCH replay, projection, and full overwrite", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "ocx-management-provider-synthetic-max-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;

  const live: OcxConfig = {
    port: 0,
    defaultProvider: "relay",
    providers: {
      relay: {
        adapter: "openai-chat",
        baseUrl: "https://relay.example.test/v1",
        liveModels: false,
        models: ["old", "new"],
        modelSuppressSyntheticMax: { old: true },
      },
    },
  };
  saveConfig(live);
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  const request = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://localhost${path}`);
    return (await handleManagementAPI(new Request(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), url, live, { createManagementConvergeCodex: catalogConvergenceFactory() }))!;
  };

  try {
    expect(providerCatalogCapabilityConfigError("relay", {
      modelSuppressSyntheticMax: { old: "yes" },
    })).toContain("modelSuppressSyntheticMax.old must be a boolean");
    const projected = withProviderCatalogCapabilityDTO(
      { providers: { relay: { adapter: "openai-chat" } } },
      live,
    ) as { providers: { relay: Record<string, unknown> } };
    expect(projected.providers.relay.modelSuppressSyntheticMax).toEqual({ old: true });

    const listed = await request("GET", "/api/providers");
    expect(listed.status).toBe(200);
    expect((await listed.json() as Array<Record<string, unknown>>)
      .find(provider => provider.name === "relay")?.modelSuppressSyntheticMax).toEqual({ old: true });

    const patched = await request("PATCH", "/api/providers?name=relay", {
      modelSuppressSyntheticMax: { old: null, new: true },
    });
    expect(patched.status).toBe(200);
    expect(live.providers.relay?.modelSuppressSyntheticMax).toEqual({ new: true });
    expect(loadConfig().providers.relay?.modelSuppressSyntheticMax).toEqual({ new: true });

    expect((await request("PATCH", "/api/providers?name=relay", {
      modelSuppressSyntheticMax: { new: "yes" },
    })).status).toBe(400);
    expect(loadConfig().providers.relay?.modelSuppressSyntheticMax).toEqual({ new: true });

    const posted = await request("POST", "/api/providers", {
      name: "second",
      provider: {
        adapter: "openai-chat",
        baseUrl: "https://second.example.test/v1",
        liveModels: false,
        modelSuppressSyntheticMax: { alpha: true },
      },
    });
    expect(posted.status).toBe(200);
    expect(loadConfig().providers.second?.modelSuppressSyntheticMax).toEqual({ alpha: true });
    expect((await request("POST", "/api/providers", {
      name: "invalid",
      provider: {
        adapter: "openai-chat",
        baseUrl: "https://invalid.example.test/v1",
        modelSuppressSyntheticMax: { alpha: 1 },
      },
    })).status).toBe(400);

    const baseline = providerEditorConfigDTO(loadConfig());
    const next = structuredClone(baseline);
    next.providers.relay!.modelSuppressSyntheticMax = { overwritten: true };
    const overwritten = await request("PUT", "/api/providers", { baseline, next });
    expect(overwritten.status).toBe(200);
    expect(live.providers.relay?.modelSuppressSyntheticMax).toEqual({ overwritten: true });
    expect(loadConfig().providers.relay?.modelSuppressSyntheticMax).toEqual({ overwritten: true });
  } finally {
    resolved.mockRestore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (existsSync(testDir)) removeTreeWithRetry(testDir);
  }
});
