import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materializeRouteIntent, cleanupRouteIntent } from "../../src/integrations/route-intent";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { ROUTE_CLIENT_IDS, type HomeRouteIntentDocument } from "../../src/link/route-intent";
import type { RouteIntentApplyInput } from "../../src/integrations/route-intent-contract";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { OcxConfig } from "../../src/types";
import { readHomeRouteIntentState } from "../../src/routing/home-route-intent";
import { emptyRouteIntentState } from "../../src/link/route-intent";
import { homeRouteIntentReceipt, readHomeRouteIntentRecord, writeHomeRouteIntentRecord } from "../../src/client/link-home";

let home: TempHome;
let input: RouteIntentApplyInput;
function path(slot: number): string { return home.path("device", ".aside", "u", String(slot), "models.json"); }
function profile(slot: number, userId: string): void {
  mkdirSync(join(path(slot), ".."), { recursive: true });
  writeFileSync(path(slot), JSON.stringify({ preferences: { userId, later: false }, providers: { personal: { apiKey: "fixture-personal" } } }));
}
function manifest(rows: Array<{ id: number; userId: string }>): void {
  writeFileSync(home.path("device", ".aside", "accounts.json"), JSON.stringify({ currentAccountId: rows[0]!.id, accounts: rows }));
}
function read(slot: number) { return JSON.parse(readFileSync(path(slot), "utf8")); }
beforeEach(() => {
  home = createTempHome("route-aside-");
  const document: HomeRouteIntentDocument = { version: 1, home: { name: "fixture-home", version: "1" },
    clients: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, { enabled: id === "aside" }])) as HomeRouteIntentDocument["clients"],
    sources: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, "default"])) as HomeRouteIntentDocument["sources"] };
  input = { config: { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig,
    document, models: [{ namespaced: "child/deepseek/model", provider: "child", id: "deepseek/model" }],
    home: home.path("device"), env: {}, store: createIntegrationStateStore(home.path("integration-store")), statePath: home.path("route-state") };
  profile(0, "other-user"); profile(7, "selected-user");
  manifest([{ id: 0, userId: "other-user" }, { id: 7, userId: "selected-user" }]);
});
afterEach(() => home.remove());

test("Aside selects local userIds instead of Home slot numbers, and refreshes exact served ids", async () => {
  input.document.clients.aside.accounts = ["selected-user"];
  expect((await materializeRouteIntent(input)).outcomes.find(row => row.client === "aside")?.outcome).toBe("current");
  expect(read(0).providers.opencodex).toBeUndefined();
  const block = read(7).providers.opencodex;
  expect(block.baseUrl).toBe("http://127.0.0.1:18274/v1");
  expect(block.apiKey).toBe("opencodex-loopback");
  expect(JSON.stringify(block)).toContain("child/deepseek/model");
  expect(readHomeRouteIntentState(input.config, { home: input.home, store: input.store, state: emptyRouteIntentState() }).defaults.aside)
    .toEqual({ enabled: true, accounts: ["selected-user"] });
  input.models = [{ namespaced: "child/deepseek/new", provider: "child", id: "deepseek/new" }];
  await materializeRouteIntent(input);
  expect(JSON.stringify(read(7).providers.opencodex)).toContain("child/deepseek/new");
  expect(JSON.stringify(read(7).providers.opencodex)).not.toContain('"child/deepseek/model"');
});

test("all writes each local profile, none removes owned blocks and preserves later user edits", async () => {
  input.document.clients.aside.accounts = "all";
  await materializeRouteIntent(input);
  for (const slot of [0, 7]) expect(read(slot).providers.opencodex).toBeDefined();
  const edited = read(7); edited.preferences.later = true; writeFileSync(path(7), JSON.stringify(edited));
  input.document.clients.aside.accounts = "none";
  await materializeRouteIntent(input);
  for (const slot of [0, 7]) {
    expect(read(slot).providers.opencodex).toBeUndefined();
    expect(read(slot).providers.personal.apiKey).toBe("fixture-personal");
  }
  expect(read(7).preferences.later).toBe(true);
});

test("disconnect cleanup removes every owned Aside block and retains later sibling edits", async () => {
  await materializeRouteIntent(input);
  const edited = read(0); edited.preferences.later = true; writeFileSync(path(0), JSON.stringify(edited));
  expect((await cleanupRouteIntent(input)).find(row => row.client === "aside")?.outcome).toBe("current");
  expect(read(0).providers.opencodex).toBeUndefined();
  expect(read(7).providers.opencodex).toBeUndefined();
  expect(read(0).preferences.later).toBe(true);
});

test("legacy Aside ownership follows its recorded path after the current account switches", async () => {
  input.document.clients.aside.accounts = ["selected-user"];
  await materializeRouteIntent(input);
  const profileStore = createIntegrationStateStore(join(input.store!.root, "aside-profiles", "7"));
  input.store!.putRecord(profileStore.readRecordsStrict().aside!);
  // Keep only the legacy root record: a surviving per-profile ownership row could name slot 7 by
  // itself and make this assertion pass even if the root-store recovery below stopped working.
  profileStore.dropRecord("aside");
  // The manifest's current account is slot 0, while the durable owner still names slot 7.
  const migrated = readHomeRouteIntentState(input.config, { home: input.home, store: input.store, state: emptyRouteIntentState() });
  expect(migrated.defaults.aside).toEqual({ enabled: true, accounts: ["selected-user"] });
});

test("aside on --accounts none records no target, so a linked Child can persist its Home receipt", async () => {
  input.linkId = "lnk_0123456789abcdef";
  input.document.clients.aside.accounts = "all";
  await materializeRouteIntent(input);
  input.document.clients.aside.accounts = "none";
  const receipt = await materializeRouteIntent(input);
  const aside = receipt.outcomes.find(row => row.client === "aside")!;
  expect(aside.outcome).toBe("current");
  expect(Object.hasOwn(aside, "target")).toBe(false);
  for (const slot of [0, 7]) expect(read(slot).providers.opencodex).toBeUndefined();
  // The connected persistence step validates these outcomes before it writes the Home record.
  const recordPath = home.path("link", "home-route-intent.json");
  const record = homeRouteIntentReceipt(input.linkId, input.document, receipt.appliedAt, receipt.appliedAt, receipt.outcomes, null);
  expect(() => writeHomeRouteIntentRecord(record, recordPath)).not.toThrow();
  expect(readHomeRouteIntentRecord(input.linkId, recordPath)?.routeClientOutcomes.find(row => row.client === "aside")?.outcome).toBe("current");
});
