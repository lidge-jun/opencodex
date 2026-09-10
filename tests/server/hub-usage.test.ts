import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { handleHubUsage } from "../../src/server/hub-usage";
import * as aggregates from "../../src/server/management/usage-aggregate-cache";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";

const KEYS = ["usage-client-A", "usage-client-B"];
const envKeys = ["OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
let saved: Record<string, string | undefined>;
let home: string;
let codex: IsolatedCodexHome;
let server: ReturnType<typeof startServer> | undefined;

function config() {
  return { ...getDefaultConfig(), port: 0, hostname: "127.0.0.1", runtimeRole: "hub" as const,
    providers: {}, apiKeys: KEYS.map((key, i) => ({ id: `client-${i}`, name: `Client ${i}`, key, createdAt: "2026-01-01" })) };
}

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  home = mkdtempSync(join(tmpdir(), "ocx-hub-usage-"));
  codex = installIsolatedCodexHome();
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_API_AUTH_TOKEN = "usage-environment-key";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = `ocx_admin_${"a".repeat(43)}`;
  aggregates.resetUsageAggregateCacheForTests();
  saveConfig(config());
  const rows = ["client-0", "client-1"].map((apiKeyId, i) => ({
    timestamp: Date.now(), requestId: `request-${i}`, provider: "fixture", model: `model-${i}`,
    surface: "codex", apiKeyId, admissionKind: "configured", accountLogLabel: "oabcdef",
    status: 200, durationMs: 1, usageStatus: "reported", usage: { inputTokens: 2, outputTokens: 1 }, totalTokens: 3,
  }));
  writeFileSync(join(home, "usage.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
});

afterEach(async () => {
  await server?.stop(true); server = undefined;
  aggregates.resetUsageAggregateCacheForTests();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  codex.restore(); removeTreeWithRetry(home);
});

test("loopback hub reads only the explicitly authenticated key and strips account attribution", async () => {
  const unscoped = await aggregates.getUsageAggregate();
  expect(unscoped.accumulator.summarize("all", Date.now(), "codex").accounts.map(row => row.accountLogLabel)).toContain("oabcdef");
  server = startServer(0);
  for (let i = 0; i < KEYS.length; i++) {
    const response = await fetch(new URL("/v1/usage?range=all", server.url), { headers: { "x-opencodex-api-key": KEYS[i]! } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ source: "hub", scope: "client", summary: { requests: 1, totalTokens: 3 } });
    expect(body.models.map((row: { model: string }) => row.model)).toEqual([`model-${i}`]);
    expect(JSON.stringify(body)).not.toContain("oabcdef");
    expect(body).not.toHaveProperty("accounts");
    expect(body.filter).not.toHaveProperty("apiKeyId");
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

test("absent, environment, admin and unknown credentials cannot obtain usage on loopback", async () => {
  server = startServer(0);
  for (const key of ["", "usage-environment-key", process.env.OPENCODEX_ADMIN_AUTH_TOKEN!, "bad-key"]) {
    const response = await fetch(new URL("/v1/usage", server.url), { headers: { "x-opencodex-api-key": key } });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }
});

test("caller-selected identity, unknown or duplicate options and invalid bounds are rejected", async () => {
  server = startServer(0);
  for (const query of ["apiKeyId=client-1", "other=1", "range=all&range=today", "range=bad", "surface=bad", "since=10", "since=20&until=10"]) {
    const response = await fetch(new URL(`/v1/usage?${query}`, server.url), { headers: { "x-opencodex-api-key": KEYS[0]! } });
    expect(response.status).toBe(400);
    await response.body?.cancel();
  }
});

test("custom bounds and provider/model filters preserve the authenticated scope", async () => {
  server = startServer(0);
  const until = Date.now() + 1000;
  const query = `range=all&surface=codex&provider=fixture&model=model-1&since=0&until=${until}`;
  const response = await fetch(new URL(`/v1/usage?${query}`, server.url), { headers: { "x-opencodex-api-key": KEYS[0]! } });
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ customWindow: true, since: 0, until, summary: { requests: 0 }, filter: { matched: false } });
});

test("a key revoked while aggregation is suspended cannot receive the result", async () => {
  const current = config();
  const aggregate = await aggregates.getFilteredUsageAggregate({ apiKeyId: "client-0" });
  let release!: (value: typeof aggregate) => void;
  const blocked = new Promise<typeof aggregate>(resolve => { release = resolve; });
  const scan = spyOn(aggregates, "getFilteredUsageAggregate").mockReturnValue(blocked);
  try {
    const pending = handleHubUsage(new Request("http://127.0.0.1/v1/usage", { headers: { "x-opencodex-api-key": KEYS[0]! } }), current, current);
    expect(scan).toHaveBeenCalledTimes(1);
    current.apiKeys = current.apiKeys.slice(1);
    release(aggregate);
    expect((await pending).status).toBe(401);
  } finally { scan.mockRestore(); }
});

test("padded authenticated IDs cannot be normalized into another key's filter", async () => {
  const current = config();
  current.apiKeys[0]!.id = " client-1 ";
  const response = await handleHubUsage(new Request("http://127.0.0.1/v1/usage", { headers: { "x-opencodex-api-key": KEYS[0]! } }), current, current);
  expect(response.status).toBe(403);
});
