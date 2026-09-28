import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { clearAnthropicAccountPoolState, bindAnthropicSessionAffinity, resolveAnthropicAccountForSession, rotateAnthropicAccountOn429 } from "../../../src/oauth/anthropic-routing";
import { parseAnthropicModelRoutes, resolveAnthropicModelRoute } from "../../../src/oauth/anthropic-model-routes";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import { clearResponseStateForTests } from "../../../src/responses/state";
import { handleResponses } from "../../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;
let releaseSpend: () => void;
let originalFetch: typeof fetch;
let sends: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-model-routes-"));
  process.env.OPENCODEX_HOME = home;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("unexpected network send"); }) as typeof fetch;
  releaseSpend = acquireOwnedSpendHome();
  sends = [];
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  clearResponseStateForTests();
});
afterEach(() => {
  releaseSpend();
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  clearResponseStateForTests();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

async function seed(): Promise<string[]> {
  for (let i = 0; i < 3; i++) await saveCredential("anthropic", {
    access: `synthetic-access-${i}`, refresh: `synthetic-refresh-${i}`,
    expires: Date.now() + 3_600_000, accountId: `synthetic-${i}`,
  });
  const ids = getAccountSet("anthropic")!.accounts.map(a => a.id);
  await setActiveAccount("anthropic", ids[0]!);
  return ids;
}
function config(ids: string[], reply: (token: string) => Response): OcxConfig {
  const fetcher = (async (_url, init) => {
    const token = new Headers(init?.headers).get("authorization") ?? new Headers(init?.headers).get("x-api-key") ?? "";
    sends.push(token);
    return reply(token);
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://anthropic-routes.test", authMode: "oauth",
    models: ["claude-sonnet-4-5"], fetch: fetcher,
  };
  return { port: 0, defaultProvider: "anthropic", providers: { anthropic: provider },
    anthropicAccountPool: { enabled: true, routes: [{ name: "sonnet", match: "claude-sonnet-*", accounts: [ids[1]!, ids[2]!] }] } };
}
function post(cfg: OcxConfig) {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", input: "Hi", stream: false }),
  }), cfg, { model: "", provider: "" });
}
function answer() {
  return Response.json({ id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
}

test("bounded first-match globs and invalid rules", () => {
  const ids = ["a", "b", "c"];
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.routes = [
    { name: "exact", match: "claude-sonnet-4-5", accounts: ["a"] },
    { name: "glob", match: "claude-*", accounts: ["b"] },
  ];
  expect(resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision?.name).toBe("exact");
  expect(resolveAnthropicModelRoute(cfg, "claude-haiku-4").decision?.name).toBe("glob");
  expect(resolveAnthropicModelRoute(cfg, "CLAUDE-HAIKU-4").decision).toBeNull();
  expect(parseAnthropicModelRoutes([{ name: "a", match: "*", accounts: ["a", "a"] }]).ok).toBe(false);
  expect(parseAnthropicModelRoutes([{ name: "a", match: "[bad]", accounts: ["a"] }]).ok).toBe(false);
});

test("matched route excludes active outsider before an upstream send", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  const response = await post(cfg);
  expect(response.status).toBe(200);
  expect(sends).toHaveLength(1);
  expect(sends[0]).not.toContain("synthetic-access-0");
  expect(["synthetic-access-1", "synthetic-access-2"].some(token => sends[0]!.includes(token))).toBe(true);
});

test("empty matched route returns named local error and never sends; explicit fallback widens", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.routes = [{ name: "missing", match: "claude-*", accounts: ["removed-account"] }];
  const denied = await post(cfg);
  expect(denied.status).toBe(401);
  expect(await denied.text()).toContain("missing");
  expect(sends).toHaveLength(0);
  cfg.anthropicAccountPool!.routes[0]!.fallback = true;
  const allowed = await post(cfg);
  expect(allowed.status).toBe(200);
  expect(sends).toHaveLength(1);
});

test("route constrains affinity and 429 replacement even when an outsider has better quota", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  setCachedProviderAccountQuotaForTests("anthropic", ids[0]!, { fiveHourPercent: 0 });
  setCachedProviderAccountQuotaForTests("anthropic", ids[1]!, { fiveHourPercent: 90 });
  setCachedProviderAccountQuotaForTests("anthropic", ids[2]!, { fiveHourPercent: 80 });
  const decision = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  const first = resolveAnthropicAccountForSession("session-1", cfg, Date.now(), decision);
  expect(decision.accounts).toContain(first.accountId!);
  const next = rotateAnthropicAccountOn429(cfg, first.accountId!, "30", "session-1", Date.now(), null, decision);
  expect(next).not.toBe(ids[0]);
  expect(decision.accounts).toContain(next!);
});

test("routed 429 retries only a routed sibling and never the eligible outsider", async () => {
  const ids = await seed();
  const cfg = config(ids, token => token.includes("synthetic-access-1")
    ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "limited" } }, { status: 429, headers: { "retry-after": "30" } })
    : answer());
  cfg.anthropicAccountPool!.routes![0]!.accounts = [ids[1]!, ids[2]!];
  const response = await post(cfg);
  expect(response.status).toBe(200);
  expect(sends).toHaveLength(2);
  expect(sends.every(token => !token.includes("synthetic-access-0"))).toBe(true);
});

test("routed 429 without an alternate retains upstream refusal and scoped cooldown", async () => {
  const ids = await seed();
  const cfg = config(ids, () => Response.json({ type: "error", error: { type: "rate_limit_error", message: "limited" } },
    { status: 429, headers: { "retry-after": "30" } }));
  cfg.anthropicAccountPool!.routes![0]!.accounts = [ids[1]!];
  const first = await post(cfg);
  expect(first.status).toBe(429);
  expect(sends).toHaveLength(1);
  const second = await post(cfg);
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).not.toBeNull();
  expect(await second.text()).toContain("sonnet");
  expect(sends).toHaveLength(1);
});

test("malformed enabled routes reject before upstream send", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  (cfg.anthropicAccountPool as { routes?: unknown }).routes = [{ name: "bad", match: "[", accounts: [ids[0]!] }];
  const response = await post(cfg);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("Invalid Anthropic model routes");
  expect(sends).toHaveLength(0);
});


test("an out-of-route affinity and manual active account cannot preempt the model route", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.strategy = "round-robin";
  bindAnthropicSessionAffinity("same-session", ids[0]!);
  const route = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  const choice = resolveAnthropicAccountForSession("same-session", cfg, Date.now(), route);
  expect(choice.routeName).toBe("sonnet");
  expect(choice.accountId).not.toBe(ids[0]);
  expect(route.accounts).toContain(choice.accountId!);
  const sent = await post(cfg);
  expect(sent.status).toBe(200);
  expect(sends[0]).not.toContain("synthetic-access-0");
});

test("disabled routes do not change the historical active-account selection", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.enabled = false;
  expect(resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision).toBeNull();
  expect(resolveAnthropicAccountForSession("session", cfg).accountId).toBe(ids[0]);
});

test("fill-first uses declared route order when the active account is outside the route", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.strategy = "fill-first";
  cfg.anthropicAccountPool!.routes![0]!.accounts = [ids[2]!, ids[1]!];
  const decision = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  const choice = resolveAnthropicAccountForSession("fresh", cfg, Date.now(), decision);
  expect(choice.accountId).toBe(ids[2]);
});
