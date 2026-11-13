import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { materializeRouteIntent } from "../../src/integrations/route-intent";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { ROUTE_CLIENT_IDS, type HomeRouteIntentDocument } from "../../src/link/route-intent";
import type { OcxConfig } from "../../src/types";

let home: TempHome;
beforeEach(() => { home = createTempHome("route-overwrite-scope-"); });
afterEach(() => home.remove());

test("a Pi takeover cannot grant takeover of another enabled integration", async () => {
  const document = { version: 1, home: { name: "test-home", version: "1" },
    clients: Object.fromEntries(ROUTE_CLIENT_IDS.map(client => [client, { enabled: client === "pi" || client === "opencode" }])),
    sources: Object.fromEntries(ROUTE_CLIENT_IDS.map(client => [client, "default"])) } as HomeRouteIntentDocument;
  const deviceHome = home.path("device");
  const files = {} as Record<"pi" | "opencode", string>;
  for (const client of ["pi", "opencode"] as const) {
    const spec = INTEGRATION_CLIENTS[client];
    files[client] = spec.configPath({}, deviceHome);
    mkdirSync(spec.detectDir({}, deviceHome), { recursive: true }); mkdirSync(dirname(files[client]), { recursive: true });
  }
  const input = { config: { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig, document,
    models: [{ namespaced: "child/model", provider: "child", id: "model" }], home: deviceHome, env: {},
    store: createIntegrationStateStore(home.path("store")), statePath: home.path("route-state") };
  await materializeRouteIntent(input);
  for (const client of ["pi", "opencode"] as const) {
    const parsed = JSON.parse(readFileSync(files[client], "utf8"));
    (parsed.providers ?? parsed.provider).opencodex.baseUrl = "https://foreign.example.test/v1";
    writeFileSync(files[client], JSON.stringify(parsed));
  }
  const otherBefore = readFileSync(files.opencode, "utf8");
  const result = await materializeRouteIntent({ ...input, overwriteConflict: true, overwriteClient: "pi" });
  expect(result.outcomes.find(row => row.client === "pi")?.outcome).toBe("current");
  expect(result.outcomes.find(row => row.client === "opencode")?.outcome).toBe("conflict");
  expect(readFileSync(files.opencode, "utf8")).toBe(otherBefore);
});
