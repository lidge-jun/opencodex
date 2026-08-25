import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  clearGoogleAntigravityAccountPoolState,
  formatGoogleAntigravityProviderForLog,
  getGoogleAntigravityAccountHealthSnapshot,
  googleAntigravitySessionAffinitySizeForTests,
} from "../src/oauth/google-antigravity-routing";
import { getAccountSet, markAccountNeedsReauth, saveCredential, setActiveAccount } from "../src/oauth/store";
import { clearAccountQuotaCache } from "../src/providers/quota";
import { clearRequestLogsForTests, getRequestLogEntries } from "../src/server/request-log";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

interface Dispatch {
  authorization: string | null;
  project: unknown;
}

const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let codexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-google-pool-request-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-google-pool-request-codex-");
  clearGoogleAntigravityAccountPoolState();
  clearAccountQuotaCache("google-antigravity");
  clearRequestLogsForTests();
});

afterEach(() => {
  clearGoogleAntigravityAccountPoolState();
  clearAccountQuotaCache("google-antigravity");
  codexHome?.restore();
  codexHome = null;
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

async function seedAccounts(eligibleCount = 2, configuredCount = eligibleCount) {
  const expires = Date.now() + 3_600_000;
  const suffixes = ["a", "b", "c", "d", "e"].slice(0, configuredCount);
  for (const suffix of suffixes) {
    await saveCredential("google-antigravity", {
      access: `request-token-${suffix}`,
      refresh: `request-refresh-${suffix}`,
      expires,
      accountId: `request-identity-${suffix}`,
      email: `request-${suffix}@example.test`,
      projectId: `request-project-${suffix}`,
    });
  }
  const set = getAccountSet("google-antigravity")!;
  const accountIds = suffixes.map(suffix =>
    set.accounts.find(account => account.credential.accountId === `request-identity-${suffix}`)!.id
  );
  await setActiveAccount("google-antigravity", accountIds[0]!);
  for (const accountId of accountIds.slice(eligibleCount)) {
    await markAccountNeedsReauth("google-antigravity", accountId, true);
  }
  return {
    aId: accountIds[0]!,
    bId: accountIds[1]!,
    accountIds: accountIds.slice(0, eligibleCount),
  };
}

function config(baseUrl: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "google",
        authMode: "oauth",
        googleMode: "cloud-code-assist",
        baseUrl,
        allowPrivateNetwork: true,
        defaultModel: "gemini-3.7-flash",
        models: ["gemini-3.7-flash"],
      },
    },
    googleAntigravityAccountPool: { enabled: true, autoSwitchThreshold: 80 },
  } as OcxConfig;
}

function completedCcaResponse(): Response {
  return Response.json({
    response: {
      candidates: [{ content: { parts: [{ text: "pool success" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2 },
    },
  });
}

function ccaSse(...payloads: unknown[]): Response {
  return new Response(
    payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const quotaResponses = new Map([
  ["Bearer request-token-a", { status: 429, retryAfter: "300" }],
  ["Bearer request-token-b", { status: 429, retryAfter: "500" }],
  ["Bearer request-token-c", { status: 429, retryAfter: "400" }],
  ["Bearer request-token-d", { status: 402, retryAfter: "450" }],
  ["Bearer request-token-e", { status: 429, retryAfter: "600" }],
]);

function exhaustedCcaResponse(authorization: string | null): Response {
  const quota = authorization ? quotaResponses.get(authorization) : undefined;
  if (!quota) throw new Error(`unexpected Antigravity authorization: ${authorization ?? "missing"}`);
  const suffix = authorization.at(-1);
  return Response.json(
    {
      error: {
        status: "RESOURCE_EXHAUSTED",
        message: `Quota exceeded for request-${suffix}@example.test, request-identity-${suffix}, request-project-${suffix}`,
      },
    },
    { status: quota.status, headers: { "retry-after": quota.retryAfter } },
  );
}

describe("google antigravity Responses account failover", () => {
  test("snapshot failure does not commit initial session affinity or dispatch upstream", async () => {
    await saveCredential("google-antigravity", {
      access: "request-token-without-project",
      refresh: "request-refresh-without-project",
      expires: Date.now() + 3_600_000,
      accountId: "request-identity-without-project",
      email: "request-without-project@example.test",
    });
    let dispatches = 0;
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        dispatches += 1;
        return completedCcaResponse();
      },
    });
    saveConfig(config(upstream.url.origin));
    const proxy = startServer(0);
    try {
      expect(googleAntigravitySessionAffinitySizeForTests()).toBe(0);
      const response = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "snapshot-failure" },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream: false }),
      });
      expect(response.status).toBe(401);
      expect(dispatches).toBe(0);
      expect(googleAntigravitySessionAffinitySizeForTests()).toBe(0);
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
  });

  test.each([1, 2, 3, 4])(
    "initial exhaustion across %d eligible accounts returns all-cooled without an extra dispatch",
    async eligibleCount => {
    const { accountIds } = await seedAccounts(eligibleCount, 4);
    const dispatches: Dispatch[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json() as { project?: unknown };
        dispatches.push({
          authorization: request.headers.get("authorization"),
          project: body.project,
        });
        return exhaustedCcaResponse(request.headers.get("authorization"));
      },
    });
    saveConfig(config(upstream.url.origin));
    const proxy = startServer(0);
    try {
      const request = () => fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": `initial-exhaustion-${eligibleCount}` },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream: false }),
      });

      const exhausted = await request();
      const exhaustedBody = await exhausted.text();
      expect([exhausted.status, exhausted.headers.get("retry-after")]).toEqual([429, "300"]);
      expect(exhaustedBody).toContain("All Google Antigravity OAuth accounts are temporarily rate-limited");
      expect(dispatches).toEqual(["a", "b", "c", "d"].slice(0, eligibleCount).map(suffix => ({
        authorization: `Bearer request-token-${suffix}`,
        project: `request-project-${suffix}`,
      })));
      expect(accountIds.every(id => getGoogleAntigravityAccountHealthSnapshot(id) !== null)).toBe(true);

      const allCooled = await request();
      const allCooledBody = await allCooled.text();
      expect([allCooled.status, allCooled.headers.get("retry-after")]).toEqual([429, "300"]);
      expect(allCooledBody).toBe(exhaustedBody);
      expect(dispatches).toHaveLength(eligibleCount);
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
    },
  );

  test("the failover cap cools the fourth account without dispatching an eligible fifth account", async () => {
    const { accountIds } = await seedAccounts(5, 5);
    const dispatches: Dispatch[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json() as { project?: unknown };
        dispatches.push({
          authorization: request.headers.get("authorization"),
          project: body.project,
        });
        return exhaustedCcaResponse(request.headers.get("authorization"));
      },
    });
    saveConfig(config(upstream.url.origin));
    const proxy = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "five-account-cap" },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream: false }),
      });
      const body = await response.text();

      expect([response.status, response.headers.get("retry-after")]).toEqual([402, "450"]);
      expect(body).toContain("Google Antigravity quota exhausted after bounded account failover");
      for (const secret of [
        "request-d@example.test",
        "request-identity-d",
        "request-project-d",
      ]) expect(body).not.toContain(secret);
      expect(dispatches).toEqual(["a", "b", "c", "d"].map(suffix => ({
        authorization: `Bearer request-token-${suffix}`,
        project: `request-project-${suffix}`,
      })));
      expect(accountIds.slice(0, 4).every(id => getGoogleAntigravityAccountHealthSnapshot(id) !== null)).toBe(true);
      expect(getGoogleAntigravityAccountHealthSnapshot(accountIds[4]!)).toBeNull();
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
  });

  test.each([1, 2, 3, 4])(
    "terminal continuation exhaustion across %d eligible accounts surfaces all-cooled",
    async eligibleCount => {
    const { accountIds } = await seedAccounts(eligibleCount, 4);
    let initialSends = 0;
    const quotaDispatches: Dispatch[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (initialSends === 0) {
          initialSends += 1;
          return Response.json({
            response: {
              candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
            },
          });
        }
        const body = await request.json() as { project?: unknown };
        quotaDispatches.push({
          authorization: request.headers.get("authorization"),
          project: body.project,
        });
        return exhaustedCcaResponse(request.headers.get("authorization"));
      },
    });
    saveConfig({ ...config(upstream.url.origin), emptyCompletionRetry: true });
    const proxy = startServer(0);
    try {
      const first = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": `continuation-exhaustion-${eligibleCount}` },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream: false }),
      });
      const firstBody = await first.text();
      expect([first.status, first.headers.get("retry-after")]).toEqual([429, "300"]);
      expect(firstBody).toContain("All Google Antigravity OAuth accounts are temporarily rate-limited");
      expect(initialSends).toBe(1);
      expect(quotaDispatches).toEqual(["a", "b", "c", "d"].slice(0, eligibleCount).map(suffix => ({
        authorization: `Bearer request-token-${suffix}`,
        project: `request-project-${suffix}`,
      })));
      expect(accountIds.every(id => getGoogleAntigravityAccountHealthSnapshot(id) !== null)).toBe(true);

      const allCooled = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": `continuation-exhaustion-${eligibleCount}` },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "again", stream: false }),
      });
      const allCooledBody = await allCooled.text();
      expect([allCooled.status, allCooled.headers.get("retry-after")]).toEqual([429, "300"]);
      expect(allCooledBody).toBe(firstBody);
      expect(initialSends).toBe(1);
      expect(quotaDispatches).toHaveLength(eligibleCount);
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
    },
  );

  test("terminal continuation cap preserves quota status without dispatching an eligible fifth account", async () => {
    const { accountIds } = await seedAccounts(5, 5);
    let initialSends = 0;
    const quotaDispatches: Dispatch[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (initialSends === 0) {
          initialSends += 1;
          return Response.json({
            response: {
              candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
            },
          });
        }
        const body = await request.json() as { project?: unknown };
        quotaDispatches.push({
          authorization: request.headers.get("authorization"),
          project: body.project,
        });
        return exhaustedCcaResponse(request.headers.get("authorization"));
      },
    });
    saveConfig({ ...config(upstream.url.origin), emptyCompletionRetry: true });
    const proxy = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "five-account-continuation-cap" },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream: false }),
      });
      const body = await response.text();

      expect([response.status, response.headers.get("retry-after")]).toEqual([402, "450"]);
      expect(body).toContain("Google Antigravity quota exhausted after bounded account failover");
      expect(initialSends).toBe(1);
      expect(quotaDispatches).toEqual(["a", "b", "c", "d"].map(suffix => ({
        authorization: `Bearer request-token-${suffix}`,
        project: `request-project-${suffix}`,
      })));
      expect(accountIds.slice(0, 4).every(id => getGoogleAntigravityAccountHealthSnapshot(id) !== null)).toBe(true);
      expect(getGoogleAntigravityAccountHealthSnapshot(accountIds[4]!)).toBeNull();
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
  });

  test("streaming quota failover completes before parsing the successful account stream", async () => {
    await seedAccounts();
    const dispatches: Dispatch[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json() as { project?: unknown };
        const authorization = request.headers.get("authorization");
        dispatches.push({ authorization, project: body.project });
        if (authorization === "Bearer request-token-a") {
          return Response.json({
            error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for this account" },
          }, { status: 429 });
        }
        return ccaSse({
          response: {
            candidates: [{ content: { parts: [{ text: "stream pool success" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
          },
        });
      },
    });
    saveConfig(config(upstream.url.origin));
    const proxy = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "stream-failover" },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("stream pool success");
      expect(dispatches).toHaveLength(2);
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
  });

  test("a partial successful stream is never replayed onto another account", async () => {
    await seedAccounts();
    const dispatches: Dispatch[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json() as { project?: unknown };
        dispatches.push({
          authorization: request.headers.get("authorization"),
          project: body.project,
        });
        return ccaSse(
          { response: { candidates: [{ content: { parts: [{ text: "partial stream output" }] } }] } },
          { error: { message: "stream failed after output" } },
        );
      },
    });
    saveConfig(config(upstream.url.origin));
    const proxy = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "partial-stream" },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream: true }),
      });
      const text = await response.text();
      expect(text).toContain("partial stream output");
      expect(text).toContain("stream failed after output");
      expect(dispatches).toEqual([
        { authorization: "Bearer request-token-a", project: "request-project-a" },
      ]);
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
  });

  test.each([429, 402])(
    "final %d cools the account and rebuilds token plus project for the next account",
    async failureStatus => {
    const { aId, bId } = await seedAccounts();
    const dispatches: Dispatch[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json() as { project?: unknown };
        const authorization = request.headers.get("authorization");
        dispatches.push({ authorization, project: body.project });
        if (authorization === "Bearer request-token-a") {
          return Response.json({
            error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for this account" },
          }, { status: failureStatus, headers: { "retry-after": "45" } });
        }
        return completedCcaResponse();
      },
    });
    saveConfig(config(upstream.url.origin));
    const proxy = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "google-pool-thread" },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "hello", stream: false }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("pool success");
      expect(dispatches).toEqual([
        { authorization: "Bearer request-token-a", project: "request-project-a" },
        { authorization: "Bearer request-token-b", project: "request-project-b" },
      ]);
      expect(getAccountSet("google-antigravity")?.activeAccountId).toBe(bId);
      expect(aId).not.toBe(bId);
      expect(getGoogleAntigravityAccountHealthSnapshot(aId)).toMatchObject({
        cooldownSource: "retry-after",
        cooldownUntil: expect.any(Number),
      });

      // Even if an operator-visible active pointer changes between turns, the
      // same thread stays on B until B itself becomes ineligible/cooled.
      await setActiveAccount("google-antigravity", aId);
      const sticky = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "google-pool-thread" },
        body: JSON.stringify({ model: "gemini-3.7-flash", input: "again", stream: false }),
      });
      expect(sticky.status).toBe(200);
      expect(dispatches.at(-1)).toEqual({
        authorization: "Bearer request-token-b",
        project: "request-project-b",
      });
      expect(dispatches).toHaveLength(3);

      const logs = getRequestLogEntries();
      const failoverLog = logs.find(entry => entry.attempts?.some(attempt =>
        attempt.recoveryKinds.includes("google-antigravity-oauth-quota")
      ));
      expect(failoverLog).toMatchObject({
        provider: formatGoogleAntigravityProviderForLog("google-antigravity", bId),
        attempts: [{
          provider: formatGoogleAntigravityProviderForLog("google-antigravity", bId),
          sendCount: 2,
          recoveryKinds: ["google-antigravity-oauth-quota"],
        }],
      });
      const serializedLogs = JSON.stringify(logs);
      for (const secret of [
        aId,
        bId,
        "request-token-a",
        "request-token-b",
        "request-project-a",
        "request-project-b",
        "request-a@example.test",
        "request-b@example.test",
      ]) expect(serializedLogs).not.toContain(secret);
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
    },
  );
});
