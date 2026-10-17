import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as destinationPolicy from "../../src/lib/destination-policy";
import * as stateStores from "../../src/lib/state-store-registrations";
import * as mutationLock from "../../src/config/mutation-lock";
import { clearModelCache } from "../../src/codex/model-cache";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import { handleOauthAccountRoutes } from "../../src/server/management/oauth-account-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const canonical = {
  adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward", codexAccountMode: "direct",
} as const;
const base = { adapter: "openai-chat", baseUrl: "https://relay.example.test/v1", liveModels: false } as const;
let home: string;
let previousHome: string | undefined;
let destination: ReturnType<typeof spyOn<typeof destinationPolicy, "providerDestinationResolvedError">>;
let reconcile: ReturnType<typeof spyOn<typeof stateStores, "reconcileLiveStateStores">>;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-account-pause-management-"));
  process.env.OPENCODEX_HOME = home;
  destination = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  reconcile = spyOn(stateStores, "reconcileLiveStateStores").mockReturnValue({ storesVisited: 0, rowsRemoved: 0 });
});
afterEach(() => {
  destination.mockRestore();
  reconcile.mockRestore();
  clearModelCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function harness(policy?: OcxProviderConfig["accountAutoPause"]) {
  const config: OcxConfig = { port: 10100, defaultProvider: "relay", providers: {
    relay: { ...base, ...(policy === undefined ? {} : { accountAutoPause: policy }) },
  } };
  const path = join(home, "saved.json");
  writeFileSync(path, JSON.stringify(config));
  async function request(method: "POST" | "PUT", body: unknown, pathname = "/api/providers") {
    const url = new URL(pathname, "http://127.0.0.1");
    const context: ManagementContext = {
      req: new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      url, config, version: "test", trustedLoopbackIngress: true, guiSessionIssuance: null,
      deps: { saveConfigPreservingClaudeCode: saved => writeFileSync(path, JSON.stringify(saved)) },
      convergeCodexCatalog: async () => ({ status: "committed", changed: false, degraded: false, notices: [] }),
      syncClaudeAgentDefsBestEffort: async () => {},
    };
    return pathname.endsWith("/pause") ? handleOauthAccountRoutes(context) : handleProviderRoutes(context);
  }
  return { config, path, request, post: (fields: Record<string, unknown> = {}) =>
    request("POST", { name: "relay", provider: { ...base, ...fields } }),
    storedPolicy: () => (JSON.parse(readFileSync(path, "utf8")) as OcxConfig).providers.relay!.accountAutoPause };
}

describe("account auto-pause management", () => {
  test.each([{}, { enabled: false }, { enabled: true, consecutiveFailures: 7 }])(
    "POST omission retains stored policy %j and explicit policy replaces it", async policy => {
      const h = harness(policy);
      expect((await h.post({ note: "unrelated edit" }))?.status).toBe(200);
      expect(h.config.providers.relay!.accountAutoPause).toEqual(policy);
      expect(h.storedPolicy()).toEqual(policy);
      expect((await h.post({ accountAutoPause: { enabled: false, consecutiveFailures: 3 } }))?.status).toBe(200);
      expect(h.storedPolicy()).toEqual({ enabled: false, consecutiveFailures: 3 });
    });

  test.each([undefined, { enabled: false }, { enabled: true, consecutiveFailures: 9 }]
    .flatMap(latest => [false, true].map(submitted => ({ latest, submitted }))))(
    "publication uses latest omission or explicit replacement: %j", async ({ latest, submitted }) => {
      const h = harness({ enabled: true, consecutiveFailures: 4 });
      const lock = mutationLock.withConfigMutationLockSync;
      let entered = false;
      const probe = spyOn(mutationLock, "withConfigMutationLockSync").mockImplementation((fn, dir) => lock(() => {
        entered = true;
        if (latest === undefined) delete h.config.providers.relay!.accountAutoPause;
        else h.config.providers.relay!.accountAutoPause = { ...latest };
        return fn();
      }, dir));
      try {
        const replacement = { enabled: false, consecutiveFailures: 2 };
        expect((await h.post(submitted ? { accountAutoPause: replacement } : {}))?.status).toBe(200);
        expect(entered).toBe(true);
        expect(h.storedPolicy()).toEqual(submitted ? replacement : latest);
        expect(h.config.providers.relay!.accountAutoPause).toEqual(submitted ? replacement : latest);
      } finally { probe.mockRestore(); }
    });

  test("canonical OpenAI accepts valid auto-pause overlays while transport stays canonical", () => {
    for (const policy of [{}, { enabled: false }, { enabled: true, consecutiveFailures: 100 }]) {
      expect(providerManagementConfigError("openai", { ...canonical, accountAutoPause: policy })).toBeNull();
    }
    expect(providerManagementConfigError("openai", { ...canonical, baseUrl: "https://other.example.test/v1",
      accountAutoPause: { enabled: true } })).not.toBeNull();
  });

  test("canonical OpenAI policy survives POST and invalid policy cannot publish", async () => {
    const h = harness();
    const policy = { enabled: true, consecutiveFailures: 6 };
    expect((await h.request("POST", { name: "openai", provider: { ...canonical, accountAutoPause: policy } }))?.status).toBe(200);
    expect(h.config.providers.openai!.accountAutoPause).toEqual(policy);
    const before = readFileSync(h.path, "utf8");
    expect((JSON.parse(before) as OcxConfig).providers.openai!.accountAutoPause).toEqual(policy);
    for (const accountAutoPause of [null, { enabled: "true" }, { unexpected: true }]) {
      expect((await h.request("POST", { name: "openai", provider: { ...canonical, accountAutoPause } }))?.status).toBe(400);
      expect(readFileSync(h.path, "utf8")).toBe(before);
      expect(h.config.providers.openai!.accountAutoPause).toEqual(policy);
    }
  });

  test.each([null, [], true, { enabled: "true" }, { consecutiveFailures: 0 }, { consecutiveFailures: 101 },
    { consecutiveFailures: 1.5 }, { unknown: "private-value-fixture" }].map(policy => ({ policy })))("invalid policy rejected: %j", ({ policy }) => {
    for (const [name, provider] of [["relay", base], ["openai", canonical]] as const) {
      for (const allowOperatorOverlays of [false, true]) {
        const error = providerManagementConfigError(name, { ...provider, accountAutoPause: policy }, { allowOperatorOverlays });
        expect(error).toContain("accountAutoPause");
        expect(error).not.toContain("private-value-fixture");
      }
    }
  });

  test.each([null, [], true, "body"].map(body => ({ body })))("pause endpoint rejects non-object JSON %j", async ({ body }) => {
    const h = harness();
    const before = readFileSync(h.path, "utf8");
    expect((await h.request("PUT", body, "/api/providers/keys/pause"))?.status).toBe(400);
    expect(readFileSync(h.path, "utf8")).toBe(before);
  });
});
