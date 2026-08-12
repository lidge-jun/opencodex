import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { gatherRoutedModels as gatherRoutedModelsDirect } from "../src/codex/catalog";
import { clearModelCache, getStaleCached, setCached } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import { getAccountSet } from "../src/oauth/store";
import { ACCOUNT_IMPORT_DEADLINE_MS, ACCOUNT_IMPORT_MAX_BYTES, ACCOUNT_IMPORT_MAX_REQUEST_BYTES } from "../src/oauth/account-import/types";
import { handleOauthAccountRoutes } from "../src/server/management/oauth-account-routes";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

const gatherRoutedModels: typeof gatherRoutedModelsDirect = config =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config));

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
  } as OcxConfig;
}

function writeAccounts(): void {
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({
    anthropic: {
      activeAccountId: "aaaa1111",
      accounts: [
        { id: "aaaa1111", credential: { access: "t1", refresh: "r1", expires: 9999999999999, email: "first@example.com", accountId: "acct-1" } },
        { id: "bbbb2222", credential: { access: "t2", refresh: "r2", expires: 9999999999999, email: "second@example.com", accountId: "acct-2" } },
      ],
    },
  }), { mode: 0o600 });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-oauth-accounts-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-oauth-accounts-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  writeAccounts();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("google-antigravity");
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("multiauth accounts API", () => {
  test("GET lists masked accounts with active flag", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { activeAccountId: string; accounts: Array<{ id: string; email?: string; active: boolean }> };
      expect(body.activeAccountId).toBe("aaaa1111");
      expect(body.accounts.length).toBe(2);
      const emails = body.accounts.map(a => a.email ?? "");
      expect(emails.some(e => e.includes("first@example.com"))).toBe(false); // masked
      expect(body.accounts.find(a => a.id === "aaaa1111")?.active).toBe(true);
      const raw = JSON.stringify(body);
      expect(raw.includes("t1")).toBe(false); // no tokens
    } finally {
      await server.stop(true);
    }
  });

  test("GET includes projected health with redacted healthSummary", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        accounts: Array<{
          id: string;
          health?: { status: string };
          healthLabel?: string;
          healthSummary?: string;
          healthAction?: string;
        }>;
      };
      expect(body.accounts.length).toBe(2);
      for (const account of body.accounts) {
        expect(account.health).toBeDefined();
        expect(account.health?.status).toBeTruthy();
        expect(typeof account.healthLabel).toBe("string");
        expect(account.healthLabel!.length).toBeGreaterThan(0);
        expect(typeof account.healthSummary).toBe("string");
        expect(account.healthSummary!.includes(account.id)).toBe(false);
        expect(account.healthSummary!).toMatch(/account-…/);
      }
      const healthy = body.accounts.find(a => a.id === "aaaa1111");
      expect(healthy?.health?.status).toBe("healthy");
      expect(healthy?.healthLabel).toBe("Healthy");
    } finally {
      await server.stop(true);
    }
  });

  test("GET projects needsReauth health with action and redacted summary", async () => {
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      anthropic: {
        activeAccountId: "aaaa1111",
        accounts: [
          {
            id: "aaaa1111",
            needsReauth: true,
            credential: {
              access: "t1",
              refresh: "r1",
              expires: 9999999999999,
              email: "first@example.com",
              accountId: "acct-1",
            },
          },
        ],
      },
    }), { mode: 0o600 });

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        accounts: Array<{
          id: string;
          health?: { status: string; reason?: string };
          healthLabel?: string;
          healthSummary?: string;
          healthAction?: string;
        }>;
      };
      const account = body.accounts[0]!;
      expect(account.health?.status).toBe("reauth_required");
      expect(account.healthLabel).toMatch(/Reauthentication|Refresh/);
      expect(account.healthSummary).toMatch(/account-…/);
      expect(account.healthSummary).not.toContain("aaaa1111");
      expect(account.healthSummary).not.toContain("first@example.com");
      expect(account.healthAction).toContain("ocx login anthropic");
    } finally {
      await server.stop(true);
    }
  });

  test("PUT active switches; unknown account 404; unknown provider 400", async () => {
    const server = startServer(0);
    try {
      const ok = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", accountId: "bbbb2222" }),
      });
      expect(ok.status).toBe(200);
      const after = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url)).then(r => r.json()) as { activeAccountId: string };
      expect(after.activeAccountId).toBe("bbbb2222");

      const missing = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", accountId: "nope" }),
      });
      expect(missing.status).toBe(404);

      const badProvider = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "not-a-provider", accountId: "x" }),
      });
      expect(badProvider.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("POST Cockpit import admits only the exact provider, format, and array document", async () => {
    const server = startServer(0);
    try {
      for (const [body, code] of [
        [{ provider: "openai", format: "cockpit-tools", document: [] }, "unsupported_provider"],
        [{ provider: "unknown", format: "cockpit-tools", document: [] }, "unsupported_provider"],
        [{ provider: "google-antigravity", format: "unknown", document: [] }, "unsupported_format"],
        [{ provider: "google-antigravity", format: "cockpit-tools", document: { accounts: [] } }, "invalid_document"],
        [{ provider: "google-antigravity", format: "cockpit-tools", document: "not-an-array" }, "invalid_document"],
        [{ provider: "Google-Antigravity", format: "cockpit-tools", document: [] }, "unsupported_provider"],
        [{ provider: " google-antigravity ", format: "cockpit-tools", document: [] }, "unsupported_provider"],
        [{ provider: "google-antigravity", format: "Cockpit-Tools", document: [] }, "unsupported_format"],
      ] as const) {
        const response = await fetch(new URL("/api/oauth/accounts/import", server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ code });
      }
      const malformed = await fetch(new URL("/api/oauth/accounts/import", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ code: "invalid_document" });
      expect(getAccountSet("google-antigravity")).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("POST Cockpit import deadline bounds a still-streaming body and returns import_cancelled", async () => {
    let bodyCancelled = false;
    const request = new Request("http://localhost/api/oauth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"provider":"google-antigravity",'));
        },
        cancel() { bodyCancelled = true; },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetTimeout(handler, timeout === ACCOUNT_IMPORT_DEADLINE_MS ? 0 : timeout, ...args)) as typeof setTimeout;
    try {
      const response = await handleOauthAccountRoutes({
        req: request,
        url: new URL(request.url),
        config: baseConfig(),
        deps: {},
        convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }),
        syncClaudeAgentDefsBestEffort: async () => {},
      });
      expect(response?.status).toBe(408);
      expect(await response?.json()).toEqual({ code: "import_cancelled" });
      expect(request.signal.aborted).toBe(false);
      expect(bodyCancelled).toBe(true);
      expect(getAccountSet("google-antigravity")).toBeNull();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("POST Cockpit import deadline returns 408 and reconciles caches after a partial commit", async () => {
    let secondValidationStarted!: () => void;
    const secondValidation = new Promise<void>(resolve => { secondValidationStarted = resolve; });
    let fireDeadline!: () => void;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      if (raw.includes("/api/")) return originalFetch(input, init);
      if (raw.includes("oauth2.googleapis.com/token")) {
        const refresh = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
        if (refresh === "second-refresh") {
          secondValidationStarted();
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
            if (signal?.aborted) rejectAbort();
            else signal?.addEventListener("abort", rejectAbort, { once: true });
          });
        }
        return Response.json({ access_token: `access-${refresh}`, expires_in: 3600 });
      }
      if (raw.includes("/oauth2/v2/userinfo")) return Response.json({ id: "google-subject-first", email: "first@example.com" });
      if (raw.includes(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "project-import" });
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === ACCOUNT_IMPORT_DEADLINE_MS) {
        if (typeof handler !== "function") throw new TypeError("deadline handler must be callable");
        fireDeadline = () => handler(...args);
        return originalSetTimeout(() => {}, 60_000);
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;
    try {
      setCached("google-antigravity", [{ provider: "google-antigravity", id: "stale-before-import" }]);
      const importing = fetch(new URL("/api/oauth/accounts/import", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          format: "cockpit-tools",
          document: [
            { email: "first@example.com", refresh_token: "first-refresh" },
            { email: "second@example.com", refresh_token: "second-refresh" },
          ],
        }),
      });
      await secondValidation;
      fireDeadline();
      const response = await importing;
      expect(response.status).toBe(408);
      const responseText = await response.text();
      expect(responseText).not.toContain("first-refresh");
      expect(responseText).not.toContain("second-refresh");
      expect(JSON.parse(responseText)).toEqual({ code: "import_cancelled" });
      expect(getAccountSet("google-antigravity")?.accounts).toHaveLength(1);
      expect(getAccountSet("google-antigravity")?.accounts[0]?.credential.refresh).toBe("first-refresh");
      expect(getStaleCached("google-antigravity")).toBeNull();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      await server.stop(true);
    }
  });

  test("POST Cockpit import validates live identity/project, atomically updates duplicates, and returns a secret-free DTO", async () => {
    const canary = "cockpit-api-canary-refresh-DO-NOT-LEAK";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      if (raw.includes("oauth2.googleapis.com/token")) {
        const refresh = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
        return Response.json({ access_token: `access-${refresh}`, expires_in: 3600 });
      }
      if (raw.includes("/oauth2/v2/userinfo")) return Response.json({ id: "google-subject-imported", email: "imported@example.com" });
      if (raw.includes(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "project-import" });
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const send = (refreshToken: string) => fetch(new URL("/api/oauth/accounts/import", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          format: "cockpit-tools",
          document: [{ email: "IMPORTED@example.com", refresh_token: refreshToken, tags: ["tag"], notes: "ignored" }],
        }),
      });

      const first = await send(canary);
      expect(first.status).toBe(200);
      const firstText = await first.text();
      expect(firstText).not.toContain(canary);
      expect(JSON.parse(firstText)).toEqual({
        totalCount: 1,
        importedCount: 1,
        updatedCount: 0,
        failedCount: 0,
        unsupportedCount: 0,
        results: [{ index: 0, status: "imported", code: "imported" }],
      });

      const second = await send("rotated-refresh-safe");
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({
        totalCount: 1,
        importedCount: 0,
        updatedCount: 1,
        failedCount: 0,
        unsupportedCount: 0,
        results: [{ index: 0, status: "updated", code: "updated" }],
      });

      const boundaryDocument = [{
        email: "imported@example.com",
        refresh_token: "boundary-refresh-safe",
        notes: "",
      }];
      const encoder = new TextEncoder();
      const emptyDocumentBytes = encoder.encode(JSON.stringify(boundaryDocument)).byteLength;
      boundaryDocument[0]!.notes = "x".repeat(ACCOUNT_IMPORT_MAX_BYTES - emptyDocumentBytes);
      const boundaryBody = JSON.stringify({
        provider: "google-antigravity",
        format: "cockpit-tools",
        document: boundaryDocument,
      });
      expect(encoder.encode(JSON.stringify(boundaryDocument)).byteLength).toBe(ACCOUNT_IMPORT_MAX_BYTES);
      expect(encoder.encode(boundaryBody).byteLength).toBeGreaterThan(ACCOUNT_IMPORT_MAX_BYTES);
      expect(encoder.encode(boundaryBody).byteLength).toBeLessThanOrEqual(ACCOUNT_IMPORT_MAX_REQUEST_BYTES);
      const boundary = await fetch(new URL("/api/oauth/accounts/import", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: boundaryBody,
      });
      expect(boundary.status).toBe(200);
      expect(await boundary.json()).toMatchObject({ updatedCount: 1, failedCount: 0 });

      const set = getAccountSet("google-antigravity");
      expect(set?.accounts).toHaveLength(1);
      expect(set?.accounts[0]?.credential.refresh).toBe("boundary-refresh-safe");
      expect(set?.accounts[0]?.credential.projectId).toBe("project-import");
    } finally {
      await server.stop(true);
    }
  });

  test("POST Cockpit import never persists mismatched, rejected, missing-project, invalid, or oversized records", async () => {
    const canary = "cockpit-negative-canary-DO-NOT-LEAK";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      if (raw.includes("oauth2.googleapis.com/token")) {
        const refresh = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
        if (refresh === "rejected-token") return new Response("raw upstream secret detail", { status: 400 });
        return Response.json({ access_token: `access-${refresh}`, expires_in: 3600 });
      }
      if (raw.includes("/oauth2/v2/userinfo")) {
        const authorization = new Headers(init?.headers).get("Authorization") ?? "";
        if (authorization.includes("missing-project")) {
          return Response.json({ id: "google-subject-missing", email: "missing@example.com" });
        }
        return Response.json({ id: "google-subject-provider", email: "provider@example.com" });
      }
      if (raw.includes(":loadCodeAssist")) {
        const authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return authorization.includes("missing-project")
          ? Response.json({})
          : Response.json({ cloudaicompanionProject: "project-safe" });
      }
      if (raw.includes(":onboardUser")) return new Response("forbidden", { status: 403 });
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/oauth/accounts/import", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          format: "cockpit-tools",
          document: [
            { email: "claimed@example.com", refresh_token: canary },
            { email: "provider@example.com", refresh_token: "rejected-token" },
            { email: "missing@example.com", refresh_token: "missing-project" },
            { email: "bad@example.com", refresh_token: "control\nvalue" },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(canary);
      expect(text).not.toContain("raw upstream secret detail");
      expect(JSON.parse(text)).toEqual({
        totalCount: 4,
        importedCount: 0,
        updatedCount: 0,
        failedCount: 4,
        unsupportedCount: 0,
        results: [
          { index: 0, status: "failed", code: "identity_mismatch" },
          { index: 1, status: "failed", code: "credential_rejected" },
          { index: 2, status: "failed", code: "missing_project" },
          { index: 3, status: "failed", code: "invalid_record" },
        ],
      });
      expect(getAccountSet("google-antigravity")).toBeNull();

      const oversized = await fetch(new URL("/api/oauth/accounts/import", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          format: "cockpit-tools",
          document: [{ email: "provider@example.com", refresh_token: "safe", notes: "x".repeat(ACCOUNT_IMPORT_MAX_BYTES) }],
        }),
      });
      expect(oversized.status).toBe(400);
      expect(await oversized.json()).toEqual({ code: "invalid_document" });
      expect(getAccountSet("google-antigravity")).toBeNull();

      const oversizedRaw = await fetch(new URL("/api/oauth/accounts/import", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `${" ".repeat(ACCOUNT_IMPORT_MAX_REQUEST_BYTES)}{}`,
      });
      expect(oversizedRaw.status).toBe(400);
      expect(await oversizedRaw.json()).toEqual({ code: "invalid_document" });
      expect(getAccountSet("google-antigravity")).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("switching an Antigravity account clears its account-scoped live-model cache", async () => {
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      "google-antigravity": {
        activeAccountId: "antigravity-a",
        accounts: [
          { id: "antigravity-a", credential: { access: "a", refresh: "ra", expires: 9999999999999, projectId: "project-a" } },
          { id: "antigravity-b", credential: { access: "b", refresh: "rb", expires: 9999999999999, projectId: "project-b" } },
        ],
      },
    }), { mode: 0o600 });
    const server = startServer(0);
    try {
      setCached("google-antigravity", [{ provider: "google-antigravity", id: "account-a-only-model" }]);
      const response = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", accountId: "antigravity-b" }),
      });

      expect(response.status).toBe(200);
      expect(getStaleCached("google-antigravity")).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("switching an Antigravity account discards an in-flight prior-account discovery", async () => {
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      "google-antigravity": {
        activeAccountId: "antigravity-a",
        accounts: [
          { id: "antigravity-a", credential: { access: "account-a-token", refresh: "ra", expires: 9999999999999, projectId: "project-a" } },
          { id: "antigravity-b", credential: { access: "account-b-token", refresh: "rb", expires: 9999999999999, projectId: "project-b" } },
        ],
      },
    }), { mode: 0o600 });
    const config = {
      providers: {
        "google-antigravity": {
          adapter: "google",
          authMode: "oauth",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          liveModels: true,
        },
      },
    } as unknown as OcxConfig;
    let releaseAccountA!: () => void;
    const accountAStarted = new Promise<void>(resolve => {
      releaseAccountA = resolve;
    });
    let accountAFetchStarted!: () => void;
    const accountAFetchObserved = new Promise<void>(resolve => {
      accountAFetchStarted = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/")) return originalFetch(input, init);
      const authorization = new Headers(init?.headers).get("Authorization");
      expect(authorization).toBe("Bearer account-a-token");
      accountAFetchStarted();
      await accountAStarted;
      return Response.json({
        models: { "account-a-model": { maxTokens: 16_384 } },
        agentModelSorts: [{ groups: [{ modelIds: ["account-a-model"] }] }],
      });
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const first = gatherRoutedModels(config);
      await accountAFetchObserved;
      const switched = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", accountId: "antigravity-b" }),
      });
      expect(switched.status).toBe(200);
      releaseAccountA();
      await first;
      expect(getStaleCached("google-antigravity")).toBeNull();

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/")) return originalFetch(input, init);
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer account-b-token");
        expect(JSON.parse(String(init?.body))).toEqual({ project: "project-b" });
        return Response.json({
          models: { "account-b-model": { maxTokens: 32_768 } },
          agentModelSorts: [{ groups: [{ modelIds: ["account-b-model"] }] }],
        });
      }) as typeof fetch;
      const second = await gatherRoutedModels(config);
      expect(second.map(model => model.id)).toEqual(["account-b-model"]);
      expect(getStaleCached("google-antigravity")?.map(model => model.id)).toEqual(["account-b-model"]);
    } finally {
      await server.stop(true);
    }
  });

  test("DELETE removes one account; active removal promotes the other", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic&id=aaaa1111", server.url), { method: "DELETE" });
      expect(res.status).toBe(200);
      const after = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url)).then(r => r.json()) as { activeAccountId: string; accounts: unknown[] };
      expect(after.accounts.length).toBe(1);
      expect(after.activeAccountId).toBe("bbbb2222");
    } finally {
      await server.stop(true);
    }
  });
});
