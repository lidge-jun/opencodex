import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { materializeRouteIntent, cleanupRouteIntent, effectiveRouteIntent, readRouteIntentReceipt, setLocalRouteIntentOff } from "../../src/integrations/route-intent";
import { ROUTE_CLIENT_IDS, routeIntentDigest, type HomeRouteIntentDocument } from "../../src/link/route-intent";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import type { RouteIntentApplyInput } from "../../src/integrations/route-intent-contract";
import { readRouteIntentReceiptStrict, writeRouteIntentReceipt } from "../../src/integrations/route-intent-state";
import type { OcxConfig } from "../../src/types";

let root: string;
let input: RouteIntentApplyInput;
function document(): HomeRouteIntentDocument {
  return { version: 1, home: { name: "fixture-home", version: "1" },
    clients: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, { enabled: id === "pi" }])) as HomeRouteIntentDocument["clients"],
    sources: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, "default"])) as HomeRouteIntentDocument["sources"] };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-route-intent-"));
  const home = join(root, "home"); mkdirSync(home);
  input = { config: { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig,
    document: document(), models: [{ namespaced: "child/model", provider: "child", id: "model" }],
    home, env: {}, store: createIntegrationStateStore(join(root, "integrations")), statePath: join(root, "route-state") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function installPi() {
  const spec = INTEGRATION_CLIENTS.pi;
  mkdirSync(spec.detectDir(input.env, input.home), { recursive: true });
  const path = spec.configPath(input.env, input.home); mkdirSync(dirname(path), { recursive: true }); return path;
}
const outcome = (receipt: Awaited<ReturnType<typeof materializeRouteIntent>>, id = "pi") => receipt.outcomes.find(row => row.client === id)!;

test("materializes the local roster and port, refreshes it, and cleans only owned keys", async () => {
  const path = installPi();
  writeFileSync(path, JSON.stringify({ unrelated: "keep" }));
  const first = await materializeRouteIntent(input);
  expect(outcome(first).outcome).toBe("current");
  expect(readFileSync(path, "utf8")).toContain("18274");
  expect(readFileSync(path, "utf8")).toContain("child/model");
  input.models = [{ namespaced: "child/new", provider: "child", id: "new" }];
  await materializeRouteIntent(input);
  expect(readFileSync(path, "utf8")).toContain("child/new");
  expect(readFileSync(path, "utf8")).not.toContain("child/model");
  const edited = JSON.parse(readFileSync(path, "utf8")); edited.after = "survive"; writeFileSync(path, JSON.stringify(edited));
  expect((await cleanupRouteIntent(input)).find(row => row.client === "pi")?.outcome).toBe("current");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ unrelated: "keep", after: "survive" });
});
test("missing clients are not installed and cannot produce an applied digest", async () => {
  const receipt = await materializeRouteIntent(input);
  expect(outcome(receipt).outcome).toBe("not_installed");
  expect(receipt.appliedRouteIntentDigest).toBeNull();
  expect(readRouteIntentReceipt(input.statePath)?.appliedRouteIntentDigest).toBeNull();
});
test("conflicts refuse unless this operation explicitly overwrites; permission is not saved", async () => {
  const path = installPi();
  writeFileSync(path, JSON.stringify({ providers: { opencodex: { baseUrl: "https://foreign.test", models: [] } } }));
  const before = readFileSync(path, "utf8");
  expect(outcome(await materializeRouteIntent(input)).outcome).toBe("conflict");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(outcome(await materializeRouteIntent({ ...input, overwriteConflict: true })).outcome).toBe("current");
  writeFileSync(path, before);
  expect(outcome(await materializeRouteIntent(input)).outcome).toBe("conflict");
});
test("persistent local off overrides fetched Home intent, inherit removes it", async () => {
  installPi(); await materializeRouteIntent(input);
  setLocalRouteIntentOff("pi", true, input.statePath);
  expect(effectiveRouteIntent(input.document, input.statePath).sources.pi).toBe("local");
  expect(effectiveRouteIntent(input.document, input.statePath).selectedClients).not.toContain("pi");
  expect(outcome(await materializeRouteIntent(input)).outcome).toBe("current");
  setLocalRouteIntentOff("pi", false, input.statePath);
  expect(effectiveRouteIntent(input.document, input.statePath).sources.pi).toBe("default");
  expect(outcome(await materializeRouteIntent(input)).outcome).toBe("current");
});
test("connection fence rejects a writer before touching client files and clears prior success", async () => {
  const path = installPi(); await materializeRouteIntent(input);
  expect(readRouteIntentReceipt(input.statePath)?.appliedRouteIntentDigest).toBe(routeIntentDigest(input.document));
  const before = readFileSync(path, "utf8");
  input.models = [{ namespaced: "child/new", provider: "child", id: "new" }];
  input.beforeWrite = () => { throw new Error("client_connection_changed"); };
  await expect(materializeRouteIntent(input)).rejects.toThrow("client_connection_changed");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readRouteIntentReceipt(input.statePath)?.appliedRouteIntentDigest).toBeNull();
});

test("review: local off rejects unreadable receipts before publishing an override", () => {
  mkdirSync(join(input.statePath!, "receipt.json"), { recursive: true });
  expect(() => setLocalRouteIntentOff("pi", true, input.statePath)).toThrow("unreadable");
  expect(() => readFileSync(join(input.statePath!, "local-off.json"))).toThrow();
});

test("review: local off rejects malformed receipts and preserves the previous override", () => {
  setLocalRouteIntentOff("pi", true, input.statePath);
  const before = readFileSync(join(input.statePath!, "local-off.json"), "utf8");
  writeFileSync(join(input.statePath!, "receipt.json"), JSON.stringify({ version: 1 }));
  expect(() => setLocalRouteIntentOff("pi", false, input.statePath)).toThrow("malformed");
  expect(readFileSync(join(input.statePath!, "local-off.json"), "utf8")).toBe(before);
});

test("review: unmanaged Aside off needs no account manifest", async () => {
  installPi();
  mkdirSync(join(input.home!, ".aside"), { recursive: true });
  const receipt = await materializeRouteIntent(input);
  expect(outcome(receipt, "aside").outcome).toBe("current");
  expect(receipt.appliedRouteIntentDigest).toBe(routeIntentDigest(input.document));
});

test("review: orphaned Aside profile ownership cannot claim clean disconnect", async () => {
  const { aside, four } = installAside();
  expect(outcome(await materializeRouteIntent(input), "aside").outcome).toBe("current");
  const before = readFileSync(four, "utf8");
  writeFileSync(join(aside, "accounts.json"), JSON.stringify({ currentAccountId: 0,
    accounts: [{ id: 0, userId: "local-beta" }] }));
  const cleaned = await cleanupRouteIntent(input);
  expect(cleaned.find(row => row.client === "aside")?.outcome).toBe("failed");
  expect(readFileSync(four, "utf8")).toBe(before);
  expect(createIntegrationStateStore(join(input.store!.root, "aside-profiles", "4")).readRecordsStrict().aside).toBeDefined();
  expect(readRouteIntentReceipt(input.statePath)?.appliedRouteIntentDigest).toBeNull();
});

test("review: missing Aside installation with retained ownership cannot claim clean", async () => {
  const { aside } = installAside();
  expect(outcome(await materializeRouteIntent(input), "aside").outcome).toBe("current");
  rmSync(aside, { recursive: true });
  expect((await cleanupRouteIntent(input)).find(row => row.client === "aside")?.outcome).toBe("failed");
});

function installAside() {
  const aside = join(input.home!, ".aside");
  for (const id of [0, 4]) mkdirSync(join(aside, "u", String(id)), { recursive: true });
  writeFileSync(join(aside, "accounts.json"), JSON.stringify({ currentAccountId: 0,
    accounts: [{ id: 0, userId: "local-beta" }, { id: 4, userId: "local-alpha" }] }));
  input.document.clients.pi.enabled = false;
  input.document.clients.aside = { enabled: true, accounts: "all" };
  return { aside, zero: join(aside, "u", "0", "models.json"), four: join(aside, "u", "4", "models.json") };
}
test("Aside all applies each local profile, then userId selection removes excluded owned profiles", async () => {
  const { zero, four } = installAside();
  input.config.apiKeys = [{ id: "fixture", name: "fixture", key: "ocx_data_do_not_copy_to_aside" }] as OcxConfig["apiKeys"];
  const all = await materializeRouteIntent(input);
  expect(outcome(all, "aside").outcome).toBe("current");
  for (const path of [zero, four]) {
    expect(readFileSync(path, "utf8")).toContain("child/model");
    expect(readFileSync(path, "utf8")).toContain("18274");
    expect(readFileSync(path, "utf8")).toContain("opencodex-loopback");
    expect(readFileSync(path, "utf8")).not.toContain("do_not_copy");
  }
  input.document.clients.aside.accounts = ["local-alpha"];
  const selected = await materializeRouteIntent(input);
  expect(outcome(selected, "aside").target).toBe("u4");
  expect(JSON.parse(readFileSync(zero, "utf8"))).toEqual({});
  expect(readFileSync(four, "utf8")).toContain("child/model");
  input.models = [{ namespaced: "child/new", provider: "child", id: "new" }];
  await materializeRouteIntent(input);
  expect(readFileSync(four, "utf8")).toContain("child/new");
  input.document.clients.aside.accounts = "none";
  await materializeRouteIntent(input);
  expect(JSON.parse(readFileSync(four, "utf8"))).toEqual({});
});
test("Aside account userId never falls back to the numeric local slot", async () => {
  installAside(); input.document.clients.aside.accounts = ["4"];
  expect(outcome(await materializeRouteIntent(input), "aside").outcome).toBe("not_installed");
});
test("Aside refuses a manifest replaced between enumeration and userId mapping", async () => {
  const { aside, zero, four } = installAside();
  const store = input.store!;
  let replaced = false;
  input.store = { ...store, listOperations: (...args) => {
    if (args[0] === "aside" && !replaced) {
      replaced = true;
      writeFileSync(join(aside, "accounts.json"), JSON.stringify({ currentAccountId: 0,
        accounts: [{ id: 0, userId: "local-alpha" }, { id: 4, userId: "local-beta" }] }));
    }
    return store.listOperations(...args);
  } };
  input.document.clients.aside.accounts = ["local-alpha"];
  expect(outcome(await materializeRouteIntent(input), "aside").outcome).toBe("failed");
  expect(replaced).toBe(true);
  expect(() => readFileSync(zero)).toThrow(); expect(() => readFileSync(four)).toThrow();
});
test("receipt reader accepts a bounded roster above 1 MiB and rejects overbound publication", async () => {
  const receipt = await materializeRouteIntent(input);
  const displayName = "x".repeat(2 * 1024 * 1024);
  receipt.models = [{ namespaced: "child/model", provider: "child", id: "model", displayName }];
  writeRouteIntentReceipt(receipt, input.statePath);
  expect(readRouteIntentReceiptStrict(input.statePath)?.models?.[0]?.displayName?.length).toBe(2 * 1024 * 1024);
  const before = readFileSync(join(input.statePath!, "receipt.json"), "utf8");
  expect(() => writeRouteIntentReceipt({ ...receipt, models: [{ namespaced: "child/model", provider: "child", id: "model", displayName: "x".repeat(16 * 1024 * 1024) }] }, input.statePath)).toThrow("too large");
  expect(readFileSync(join(input.statePath!, "receipt.json"), "utf8")).toBe(before);
});
