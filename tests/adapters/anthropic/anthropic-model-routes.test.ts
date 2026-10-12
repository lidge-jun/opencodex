import { rotateAnthropicAccountOn429 } from "../../helpers/anthropic-shared-quota";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { OAUTH_PROVIDERS } from "../../../src/oauth";
import { getAccountCredential, setAnthropicAccountThreshold } from "../../../src/oauth/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { clearAnthropicAccountPoolState, bindAnthropicSessionAffinity, getAnthropicAccountHealthSnapshot, getAnthropicSidecarAccessToken, getAnthropicPoolAccessSnapshot, getAnthropicPoolRetryAfterSeconds, promoteAnthropicActiveAccount, resolveAnthropicAccountForSession,} from "../../../src/oauth/anthropic-routing";
import { parseAnthropicModelRoutes, resolveAnthropicModelRoute } from "../../../src/oauth/anthropic-model-routes";
import { captureOAuthAccountSelection, getAccountSet, markAccountNeedsReauth, replaceProviderAccountSet, saveAccountCredential, saveCredential, setAccountPaused, setActiveAccount } from "../../../src/oauth/store";
import { clearUpstreamHostHealth, getUpstreamHostHealth, upstreamHostHealthKey } from "../../../src/codex/upstream-host-health";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../../src/providers/request-pacing";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import { clearResponseStateForTests } from "../../../src/responses/state";
import { parseRequest } from "../../../src/responses/parser";
import { handleResponses } from "../../../src/server/responses";
import { describeImagesInPlace, planVisionSidecar, resetVisionDescriptionCache } from "../../../src/vision";
import { runAnthropicWebSearch } from "../../../src/web-search/anthropic-executor";
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
  clearUpstreamHostHealth();
  clearAccountQuotaCache();
  clearResponseStateForTests();
});
afterEach(() => {
  clearUpstreamHostHealth();
  resetProviderRequestPacingForTest();
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
function config(ids: string[], reply: (token: string) => Response | Promise<Response>): OcxConfig {
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
  expect(resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision?.position).toBe(1);
  expect(resolveAnthropicModelRoute(cfg, "claude-haiku-4").decision?.position).toBe(2);
  expect(resolveAnthropicModelRoute(cfg, "CLAUDE-HAIKU-4").decision).toBeNull();
  expect(parseAnthropicModelRoutes([{ name: "a", match: "*", accounts: ["a", "a"] }]).ok).toBe(false);
  expect(parseAnthropicModelRoutes([{ name: "a", match: "[bad]", accounts: ["a"] }]).ok).toBe(false);
});

test.each([false, true])("threshold edit during credential refresh reselects before send (route=%s)", async routed => {
  const ids = await seed(); const [a, b, c] = ids as [string, string, string];
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool = { enabled: true, strategy: "quota", ...(routed ? { routes: [{ name: "all", match: "claude-*", accounts: ids }] } : {}) };
  const initial = resolveAnthropicAccountForSession(null, cfg);
  await promoteAnthropicActiveAccount(initial.accountId!, captureOAuthAccountSelection("anthropic"), { config: cfg, reason: initial.reason });
  for (const [id, percent] of [[a, 60], [b, 70], [c, 90]] as const) setCachedProviderAccountQuotaForTests("anthropic", id, { fiveHourPercent: percent, updatedAt: Date.now() });
  const credential = getAccountCredential("anthropic", a)!;
  await saveAccountCredential("anthropic", a, { ...credential, expires: Date.now() - 1 });
  const refresh = spyOn(OAUTH_PROVIDERS.anthropic!, "refresh").mockImplementation(async () => {
    await setAnthropicAccountThreshold(a, 50);
    return { ...credential, expires: Date.now() + 3600_000 };
  });
  try {
    const response = await post(cfg); expect(response.status).toBe(200);
    expect(sends).toEqual(["Bearer synthetic-access-1"]);
  } finally { refresh.mockRestore(); }
});

test.each([true, false])("all-paused pool returns 403 without any send (enabled=%s)", async enabled => {
  const ids = await seed();
  for (const id of ids) await setAccountPaused("anthropic", id, true);
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.enabled = enabled;
  const response = await post(cfg);
  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Resume");
  expect(sends).toEqual([]);
});

test("a paused route successor is skipped on disabled-pool 429 failover", async () => {
  const ids = await seed();
  await setAccountPaused("anthropic", ids[1]!, true);
  const cfg = config(ids, async token => {
    if (token.includes("synthetic-access-0")) {
      await setAccountPaused("anthropic", ids[0]!, true);
      return Response.json({ error: { type: "rate_limit_error", message: "synthetic refusal" } }, { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "60" } });
    }
    return answer();
  });
  cfg.anthropicAccountPool!.enabled = false;
  expect((await post(cfg)).status).toBe(200);
  expect(sends).toHaveLength(2);
  expect(sends[0]).toContain("synthetic-access-0");
  expect(sends[1]).toContain("synthetic-access-2");
});

test("pausing an already-sent successful turn does not cancel its result", async () => {
  const ids = await seed();
  const cfg = config(ids, async () => {
    for (const id of ids) await setAccountPaused("anthropic", id, true);
    return answer();
  });
  expect((await post(cfg)).status).toBe(200);
  expect(sends).toHaveLength(1);
});

test.each([true, false])("pause while queued for pacing never sends the cached bearer (enabled=%s)", async enabled => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool = { enabled };
  cfg.providers.anthropic!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
  const slot = await waitForProviderRequestSlot("anthropic", cfg.providers.anthropic!, "claude-sonnet-4-5");
  const pending = post(cfg);
  try {
    for (let i = 0; i < 100 && providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued).toBe(1);
    await setAccountPaused("anthropic", ids[0]!, true);
  } finally { slot.release(); }
  expect((await pending).status).toBe(200);
  expect(sends).toHaveLength(1);
  expect(sends[0]).not.toContain("synthetic-access-0");
});

for (const adapter of ["anthropic", "openai-responses"] as const) {
  for (const enabled of [true, false]) {
    for (const remaining of ["needs-reauth", "unusable"] as const) {
      test(`${adapter}: pause with ${remaining} survivors during pacing matches fresh admission, pool enabled=${enabled}`, async () => {
        const ids = await seed();
        await setAccountPaused("anthropic", ids[2]!, true);
        const cfg = config(ids, () => answer());
        cfg.anthropicAccountPool = { enabled, routes: [{ name: "private-auth-scope", match: "claude-*", accounts: [ids[0]!, ids[1]!] }] };
        cfg.providers.anthropic!.adapter = adapter;
        cfg.providers.anthropic!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
        const hostKey = upstreamHostHealthKey("anthropic", "anthropic-routes.test");
        const slot = await waitForProviderRequestSlot("anthropic", cfg.providers.anthropic!, "claude-sonnet-4-5");
        const pending = post(cfg);
        let rosterBeforeDispatch: ReturnType<typeof getAccountSet>;
        try {
          for (let i = 0; i < 100 && providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued === 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          expect(providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued).toBe(1);
          if (remaining === "needs-reauth") await markAccountNeedsReauth("anthropic", ids[1]!, true);
          else {
            const credential = getAccountSet("anthropic")!.accounts.find(row => row.id === ids[1])!.credential;
            await saveAccountCredential("anthropic", ids[1]!, { ...credential, source: "local-cli", expires: 0 });
          }
          await setAccountPaused("anthropic", ids[0]!, true);
          if (remaining === "unusable") {
            // A persisted background local-CLI slot must not adopt the foreground CLI identity.
            await replaceProviderAccountSet("anthropic", { ...getAccountSet("anthropic")!, activeAccountId: ids[0]! });
          }
          rosterBeforeDispatch = getAccountSet("anthropic");
          expect(getUpstreamHostHealth(hostKey)).toBeNull();
        } finally { slot.release(); }
        const response = await pending;
        const initial = await post(cfg);
        expect(initial.status).toBe(enabled ? 401 : 403);
        expect(response.status).toBe(initial.status);
        const body = await response.json() as { error: { type: string; message: string } };
        const initialBody = await initial.json() as { error: { type: string } };
        expect(body.error.type).toBe(initialBody.error.type);
        expect(body.error.message).not.toContain("private-auth-scope");
        expect(sends).toEqual([]);
        expect(getUpstreamHostHealth(hostKey)).toBeNull();
        expect(ids.map(id => getAnthropicAccountHealthSnapshot(id))).toEqual([null, null, null]);
        expect(getAccountSet("anthropic")).toEqual(rosterBeforeDispatch!);
      });
    }

    test(`${adapter}: a pacing-time pause skips a cooled successor for a healthy account, pool enabled=${enabled}`, async () => {
      const ids = await seed();
      const cfg = config(ids, () => answer());
      cfg.anthropicAccountPool = { enabled, routes: [{ name: "all", match: "claude-*", accounts: ids }] };
      cfg.providers.anthropic!.adapter = adapter;
      cfg.providers.anthropic!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
      const slot = await waitForProviderRequestSlot("anthropic", cfg.providers.anthropic!, "claude-sonnet-4-5");
      const pending = post(cfg);
      try {
        for (let i = 0; i < 100 && providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued === 0; i++) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued).toBe(1);
        rotateAnthropicAccountOn429(cfg, ids[1]!, "60");
        await setAccountPaused("anthropic", ids[0]!, true);
      } finally { slot.release(); }
      expect((await pending).status).toBe(200);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain("synthetic-access-2");
    });

    test(`${adapter}: paused plus cooled accounts during pacing return scoped 429, pool enabled=${enabled}`, async () => {
      const ids = await seed();
      const cfg = config(ids, () => answer());
      cfg.anthropicAccountPool = { enabled, routes: [{ name: "private-scope", match: "claude-*", accounts: [ids[0]!, ids[1]!] }] };
      cfg.providers.anthropic!.adapter = adapter;
      cfg.providers.anthropic!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
      if (!enabled) await setAccountPaused("anthropic", ids[2]!, true);
      const slot = await waitForProviderRequestSlot("anthropic", cfg.providers.anthropic!, "claude-sonnet-4-5");
      const pending = post(cfg);
      try {
        for (let i = 0; i < 100 && providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued === 0; i++) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued).toBe(1);
        rotateAnthropicAccountOn429(cfg, ids[1]!, "60");
        // A shorter outsider cooldown must not change the strict route's Retry-After.
        if (enabled) rotateAnthropicAccountOn429(cfg, ids[2]!, "5");
        await setAccountPaused("anthropic", ids[0]!, true);
      } finally { slot.release(); }
      const response = await pending;
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(50);
      expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(60);
      const body = await response.json() as { error: { type: string; message: string } };
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.message.includes("model route")).toBe(enabled);
      expect(body.error.message).not.toContain("private-scope");
      expect(sends).toEqual([]);
    });

    test(`${adapter}: pausing every account during pacing returns 403, pool enabled=${enabled}`, async () => {
      const ids = await seed();
      const cfg = config(ids, () => answer());
      cfg.anthropicAccountPool!.enabled = enabled;
      cfg.providers.anthropic!.adapter = adapter;
      cfg.providers.anthropic!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
      const slot = await waitForProviderRequestSlot("anthropic", cfg.providers.anthropic!, "claude-sonnet-4-5");
      const pending = post(cfg);
      try {
        for (let i = 0; i < 100 && providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued === 0; i++) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued).toBe(1);
        for (const id of ids) await setAccountPaused("anthropic", id, true);
      } finally { slot.release(); }
      const response = await pending;
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { type: "permission_error", message: expect.stringContaining("Resume") } });
      expect(sends).toEqual([]);
    });
  }
}

test("strict route with paused and cooled members returns 429 from its remaining usable member", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  const decision = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  await setAccountPaused("anthropic", ids[1]!, true);
  rotateAnthropicAccountOn429(cfg, ids[2]!, "60", null, Date.now(), null, decision);
  expect(resolveAnthropicAccountForSession("", cfg, Date.now(), decision).reason).toBe("all-cooled");
  const response = await post(cfg);
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  expect(sends).toEqual([]);
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

test("sidecar helpers use the routed account and refuse an empty strict route", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.routes![0]!.accounts = [ids[1]!];
  expect(await getAnthropicSidecarAccessToken("anthropic", "claude-sonnet-4-5", cfg))
    .toBe("synthetic-access-1");

  cfg.anthropicAccountPool!.routes![0]!.accounts = ["removed-account"];
  await expect(getAnthropicSidecarAccessToken("anthropic", "claude-sonnet-4-5", cfg))
    .rejects.toThrow("No permitted Anthropic account");
});

test("a web-search sidecar send carries the routed account's credential", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.routes![0]!.accounts = [ids[1]!];

  let sentAuth = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentAuth = new Headers(init?.headers).get("authorization") ?? "";
    const frame = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "done" },
    };
    return new Response(`event: content_block_delta\ndata: ${JSON.stringify(frame)}\n\n`, { status: 200 });
  }) as typeof fetch;

  const out = await runAnthropicWebSearch(
    "bun release",
    "anthropic",
    cfg.providers.anthropic as OcxProviderConfig,
    { model: "claude-sonnet-4-5", reasoning: "low", timeoutMs: 5_000 },
    undefined,
    cfg,
  );
  expect(out.error).toBeUndefined();
  expect(out.text).toBe("done");
  expect(sentAuth).toBe("Bearer synthetic-access-1");
});

test.each([false, true])("vision plan enforces its helper-model account route (empty strict route=%s)", async emptyRoute => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  const mainModel = "text-only-model";
  const helperModel = "claude-haiku-4-5";
  cfg.providers.anthropic!.noVisionModels = [mainModel];
  cfg.visionSidecar = { enabled: true, backend: "anthropic", model: helperModel, timeoutMs: 5_000 };
  cfg.anthropicAccountPool!.routes = [
    { name: "main", match: mainModel, accounts: [ids[0]!] },
    { name: "vision-helper", match: helperModel, accounts: [emptyRoute ? "removed-account" : ids[1]!] },
  ];
  const parsed = parseRequest({
    model: `anthropic/${mainModel}`,
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "Describe this synthetic image." },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
    ] }],
  });
  const visionSends: Array<{ authorization: string | null; model: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    visionSends.push({ authorization: new Headers(init?.headers).get("authorization"),
      model: (JSON.parse(String(init?.body)) as { model: string }).model });
    expect(String(input)).toBe("https://anthropic-routes.test/v1/messages");
    const frame = { type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "A synthetic routed vision description." } };
    return new Response(`event: content_block_delta\ndata: ${JSON.stringify(frame)}\n\n`);
  }) as typeof fetch;
  resetVisionDescriptionCache();
  try {
    const plan = planVisionSidecar(cfg, cfg.providers.anthropic!, mainModel, parsed,
      undefined, { providerName: "anthropic" });
    expect(plan?.backend).toBe("anthropic");
    await describeImagesInPlace(parsed, plan!, new Headers());
    const content = JSON.stringify(parsed.context.messages);
    if (emptyRoute) {
      expect(visionSends).toEqual([]);
      expect(content).toContain("anthropic vision sidecar auth failed");
      expect(content).not.toContain("A synthetic routed vision description.");
    } else {
      expect(visionSends).toEqual([{ authorization: "Bearer synthetic-access-1", model: helperModel }]);
      expect(content).toContain("A synthetic routed vision description.");
      expect(content).not.toContain("could not be processed");
    }
    expect(sends).toEqual([]);
  } finally {
    resetVisionDescriptionCache();
  }
});

// An operator may name a route after an account ID; the data-plane client must never see it.
const ACCOUNT_LIKE_ROUTE = "0123456789abcdef0123456789abcdef";

test("empty matched route answers locally without the route name and never sends; explicit fallback widens", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.routes = [{ name: ACCOUNT_LIKE_ROUTE, match: "claude-*", accounts: ["removed-account"] }];
  const denied = await post(cfg);
  expect(denied.status).toBe(401);
  const deniedBody = await denied.text();
  expect(deniedBody).toContain("this model route");
  expect(deniedBody).not.toContain(ACCOUNT_LIKE_ROUTE);
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
    ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "limited" } }, { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" } })
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
    { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" } }));
  cfg.anthropicAccountPool!.routes![0]!.accounts = [ids[1]!];
  cfg.anthropicAccountPool!.routes![0]!.name = ACCOUNT_LIKE_ROUTE;
  const first = await post(cfg);
  expect(first.status).toBe(429);
  expect(sends).toHaveLength(1);
  const second = await post(cfg);
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).not.toBeNull();
  const cooledBody = await second.text();
  expect(cooledBody).toContain("this model route");
  expect(cooledBody).not.toContain(ACCOUNT_LIKE_ROUTE);
  expect(sends).toHaveLength(1);
});

test("fallback route advertises the earliest ordinary-pool cooldown when every account is cooling", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.routes = [{ name: ACCOUNT_LIKE_ROUTE, match: "claude-*", accounts: [ids[1]!], fallback: true }];
  const decision = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  const now = Date.now();
  rotateAnthropicAccountOn429(cfg, ids[1]!, "3600", null, now, null, decision);
  rotateAnthropicAccountOn429(cfg, ids[0]!, "60", null, now, null, decision);
  rotateAnthropicAccountOn429(cfg, ids[2]!, "1800", null, now, null, decision);

  expect(getAnthropicPoolRetryAfterSeconds(now, decision)).toBe(60);
  const expanded = await post(cfg);
  expect(expanded.status).toBe(429);
  expect(Number(expanded.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(expanded.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  expect(await expanded.text()).not.toContain(ACCOUNT_LIKE_ROUTE);

  cfg.anthropicAccountPool!.routes[0]!.fallback = false;
  const strictDecision = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  expect(getAnthropicPoolRetryAfterSeconds(now, strictDecision)).toBe(3600);
  const strict = await post(cfg);
  expect(strict.status).toBe(429);
  expect(Number(strict.headers.get("retry-after"))).toBeGreaterThan(3500);
  expect(sends).toHaveLength(0);
});

test("removed fallback route account returns 429 using cooling ordinary-pool accounts", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.routes = [{ name: ACCOUNT_LIKE_ROUTE, match: "claude-*", accounts: ["removed-account"], fallback: true }];
  const decision = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  const now = Date.now();
  rotateAnthropicAccountOn429(cfg, ids[0]!, "120", null, now, null, decision);
  rotateAnthropicAccountOn429(cfg, ids[1]!, "60", null, now, null, decision);
  rotateAnthropicAccountOn429(cfg, ids[2]!, "180", null, now, null, decision);

  expect(resolveAnthropicAccountForSession("removed-route", cfg, now, decision).reason).toBe("all-cooled");
  const expanded = await post(cfg);
  expect(expanded.status).toBe(429);
  expect(Number(expanded.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(expanded.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  expect(await expanded.text()).not.toContain(ACCOUNT_LIKE_ROUTE);
  expect(sends).toHaveLength(0);

  cfg.anthropicAccountPool!.routes[0]!.fallback = false;
  const strict = await post(cfg);
  expect(strict.status).toBe(401);
  expect(strict.headers.get("retry-after")).toBeNull();
  expect(sends).toHaveLength(0);
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
  expect(choice.routePosition).toBe(1);
  expect(choice.accountId).not.toBe(ids[0]);
  expect(route.accounts).toContain(choice.accountId!);
  const sent = await post(cfg);
  expect(sent.status).toBe(200);
  expect(sends[0]).not.toContain("synthetic-access-0");
});

test("a routed pick preserves an excluded session affinity for a later unrouted model", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  bindAnthropicSessionAffinity("same-session", ids[0]!);
  const route = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  const expected = captureOAuthAccountSelection("anthropic");
  const routed = resolveAnthropicAccountForSession("same-session", cfg, Date.now(), route);
  expect(route.accounts).toContain(routed.accountId!);
  expect(routed.accountId).not.toBe(ids[0]);
  const snapshot = await getAnthropicPoolAccessSnapshot(routed.accountId!);
  expect(await promoteAnthropicActiveAccount(routed.accountId!, expected, {
    config: cfg, sessionKey: "same-session", reason: routed.reason,
    routeDecision: route, expectedCredentialGeneration: snapshot.generation,
  })).not.toBeNull();

  const unrouted = resolveAnthropicAccountForSession("same-session", cfg);
  expect(unrouted).toMatchObject({ accountId: ids[0], reason: "affinity" });
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

test("fill-first fallback advances from the active ordinary-pool account", async () => {
  const ids = await seed();
  const ordinaryOrder = [...ids].sort((a, b) => a.localeCompare(b));
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.strategy = "fill-first";
  cfg.anthropicAccountPool!.routes = [{
    name: "missing", match: "claude-*", accounts: ["removed-account"], fallback: true,
  }];
  // The middle account is the current ordinary-pool account. Crossing its threshold
  // must advance to its successor, rather than restart at the first account.
  await setActiveAccount("anthropic", ordinaryOrder[0]!);
  cfg.anthropicAccountPool!.enabled = false;
  resolveAnthropicAccountForSession("", cfg); // establish the old manual preference
  cfg.anthropicAccountPool!.enabled = true;
  await setActiveAccount("anthropic", ordinaryOrder[1]!);
  setCachedProviderAccountQuotaForTests("anthropic", ordinaryOrder[0]!, { fiveHourPercent: 10 });
  setCachedProviderAccountQuotaForTests("anthropic", ordinaryOrder[1]!, { fiveHourPercent: 90 });
  setCachedProviderAccountQuotaForTests("anthropic", ordinaryOrder[2]!, { fiveHourPercent: 10 });
  const decision = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
  const choice = resolveAnthropicAccountForSession("fresh", cfg, Date.now(), decision);
  expect(choice.reason).toBe("fill-first");
  expect(choice.accountId).toBe(ordinaryOrder[2]);
  expect(choice.accountId).not.toBe(ordinaryOrder[0]);
});

test("selection, refusal and 429 rotation logs use the rule position, never its account-like name", async () => {
  const ids = await seed();
  const cfg = config(ids, () => answer());
  cfg.anthropicAccountPool!.routes = [
    { name: "other", match: "claude-haiku-*", accounts: [ids[0]!] },
    { name: ACCOUNT_LIKE_ROUTE, match: "claude-*", accounts: [ids[1]!, ids[2]!] },
  ];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.info = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  console.warn = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    expect((await post(cfg)).status).toBe(200);
    const decision = resolveAnthropicModelRoute(cfg, "claude-sonnet-4-5").decision!;
    rotateAnthropicAccountOn429(cfg, ids[1]!, "30", null, Date.now(), null, decision);
    cfg.anthropicAccountPool!.routes[1]!.accounts = ["removed-account"];
    expect((await post(cfg)).status).toBe(401);
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  const routeLines = lines.filter(line => line.includes("[anthropic-pool] route:"));
  expect(routeLines.some(line => line.includes("route:#2") && line.includes("answering locally"))).toBe(true);
  expect(routeLines.some(line => line.includes("route:#2") && line.includes("429 on"))).toBe(true);
  expect(routeLines.some(line => line.includes("route:#2") && !line.includes("answering locally") && !line.includes("429 on"))).toBe(true);
  expect(routeLines.every(line => !line.includes(ACCOUNT_LIKE_ROUTE))).toBe(true);
});
