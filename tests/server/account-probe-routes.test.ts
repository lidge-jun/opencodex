import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityCliUserAgent } from "../../src/adapters/client-fingerprint";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";
import { clearModelCache } from "../../src/codex/model-cache";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import { setAntigravityAccountQuotaTransportForTests } from "../../src/providers/quota/antigravity";
import {
  classifyAntigravityProbeResponse,
  probeAntigravityAccounts,
} from "../../src/providers/quota/antigravity-account-probe";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const previousHome = process.env.OPENCODEX_HOME;
const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
let home = "";

const future = () => Date.now() + 60 * 60_000;
const account = (id: string, access: string, extra: Record<string, unknown> = {}) => ({
  id, credential: { access, refresh: `refresh-${id}`, expires: future(), email: `${id}@example.com`, projectId: `proj-${id}`, ...extra },
});

function writeStore(accounts: unknown[], activeAccountId = "okacct1"): string {
  const path = join(home, "auth.json");
  writeFileSync(path, JSON.stringify({ "google-antigravity": { activeAccountId, accounts } }), { mode: 0o600 });
  return path;
}

function googleError(code: number, status: string, message: string, reason?: string): string {
  return JSON.stringify({ error: { code, status, message, ...(reason ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] } : {}) } });
}

const summaryBody = JSON.stringify({ groups: [{ displayName: "Gemini Models", buckets: [
  { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8, resetTime: "2026-11-12T12:00:00Z" },
] }] });

/** Upstream fake keyed by bearer token; records every request it sees. */
function installUpstream(byToken: Record<string, () => Response>) {
  const seen: Array<{ url: string; auth: string; userAgent: string; project: string }> = [];
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async (url, _pinned, body, _signal, requestOptions) => {
      const headers = new Headers(requestOptions?.headers);
      const auth = headers.get("authorization") ?? "";
      seen.push({ url, auth, userAgent: headers.get("user-agent") ?? "", project: String(JSON.parse(String(body)).project) });
      const token = auth.replace(/^Bearer /, "");
      return byToken[token]?.() ?? new Response("{}", { status: 500 });
    },
  });
  return seen;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-account-probe-"));
  process.env.OPENCODEX_HOME = home;
  for (const key of proxyKeys) delete process.env[key];
});

afterEach(() => {
  setAntigravityAccountQuotaTransportForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  for (const key of proxyKeys) {
    if (originalProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProxyEnv[key];
  }
  removeTreeWithRetry(home);
});

describe("classifyAntigravityProbeResponse", () => {
  test("maps Google answers to probe verdicts", () => {
    expect(classifyAntigravityProbeResponse(200, "").status).toBe("ok");
    expect(classifyAntigravityProbeResponse(403, googleError(403, "PERMISSION_DENIED", "Verify your account to continue.", "VALIDATION_REQUIRED")))
      .toMatchObject({ status: "verification_required", reason: "VALIDATION_REQUIRED" });
    expect(classifyAntigravityProbeResponse(403, googleError(403, "PERMISSION_DENIED", "This account has been suspended for violating the Terms of Service.")).status)
      .toBe("suspended");
    expect(classifyAntigravityProbeResponse(403, googleError(403, "PERMISSION_DENIED", "Cloud Code Private API has not been used in project 1 before or it is disabled.", "SERVICE_DISABLED")).status)
      .toBe("permission_denied");
    expect(classifyAntigravityProbeResponse(403, googleError(403, "PERMISSION_DENIED", "The caller does not have permission")))
      .toMatchObject({ status: "permission_denied", reason: "PERMISSION_DENIED", message: "The caller does not have permission" });
    expect(classifyAntigravityProbeResponse(429, googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded")).status).toBe("rate_limited");
    expect(classifyAntigravityProbeResponse(401, googleError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.")))
      .toMatchObject({ status: "error", reason: "UNAUTHENTICATED" });
    expect(classifyAntigravityProbeResponse(503, "upstream down")).toMatchObject({ status: "error", message: "upstream down" });
  });
});

describe("probeAntigravityAccounts", () => {
  test("probes each account with its own token under the CLI fingerprint, never writes the store, never leaks tokens", async () => {
    const path = writeStore([
      account("okacct1", "tok-ok"),
      account("verify1", "tok-verify"),
      account("denied1", "tok-denied"),
      account("limit01", "tok-limit"),
      { ...account("paused1", "tok-paused"), paused: true },
      account("expired1", "tok-expired", { expires: Date.now() - 1000 }),
      account("noproj1", "tok-noproj", { projectId: undefined }),
    ]);
    const before = readFileSync(path, "utf8");
    const seen = installUpstream({
      "tok-ok": () => new Response(summaryBody, { status: 200, headers: { "content-type": "application/json" } }),
      "tok-verify": () => new Response(googleError(403, "PERMISSION_DENIED", "Verify your account", "VALIDATION_REQUIRED"), { status: 403 }),
      "tok-denied": () => new Response(googleError(403, "PERMISSION_DENIED", "The caller does not have permission"), { status: 403 }),
      "tok-limit": () => new Response(googleError(429, "RESOURCE_EXHAUSTED", "Too many requests"), { status: 429 }),
    });

    const results = await probeAntigravityAccounts();
    const byId = Object.fromEntries((results ?? []).map(row => [row.accountId, row]));
    expect(byId.okacct1).toMatchObject({ status: "ok", httpStatus: 200, active: true });
    expect(byId.okacct1!.quota?.customWindows?.[0]).toMatchObject({ label: "Gem" });
    expect(byId.verify1).toMatchObject({ status: "verification_required", httpStatus: 403 });
    expect(byId.denied1).toMatchObject({ status: "permission_denied", httpStatus: 403 });
    expect(byId.limit01).toMatchObject({ status: "rate_limited", httpStatus: 429 });
    expect(byId.paused1).toMatchObject({ status: "paused", httpStatus: null, paused: true });
    expect(byId.expired1).toMatchObject({ status: "token_expired", httpStatus: null, paused: false });
    expect(byId.noproj1).toMatchObject({ status: "error", reason: "missing_project" });

    // Paused, expired and project-less accounts send nothing; every request uses the CLI fingerprint.
    expect(seen.map(row => row.auth).sort()).toEqual(["Bearer tok-denied", "Bearer tok-limit", "Bearer tok-ok", "Bearer tok-verify"]);
    for (const row of seen) {
      expect(row.url).toBe(SUMMARY_URL);
      expect(row.userAgent).toBe(antigravityCliUserAgent());
      expect(row.project).toMatch(/^proj-/);
    }
    // Read-only: the auth store is byte-identical and no token appears in the result.
    expect(readFileSync(path, "utf8")).toBe(before);
    const serialized = JSON.stringify(results);
    for (const token of ["tok-ok", "tok-verify", "tok-denied", "tok-limit", "tok-paused-expired", "refresh-"]) {
      expect(serialized).not.toContain(token);
    }
    expect(byId.okacct1!.maskedLabel).not.toBe("okacct1@example.com");
  });

  test("a pause made while earlier probes are in flight suppresses the queued account's request", async () => {
    const ids = ["acct1", "acct2", "acct3", "acct4", "acct5"];
    writeStore(ids.map(id => account(id, `tok-${id}`)), "acct1");
    const held: Array<() => void> = [];
    const seen: string[] = [];
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
      pinnedPost: async (_url, _pinned, _body, _signal, requestOptions) => {
        seen.push(new Headers(requestOptions?.headers).get("authorization") ?? "");
        await new Promise<void>(resolve => held.push(resolve));
        return new Response(summaryBody, { status: 200 });
      },
    });
    const pending = probeAntigravityAccounts();
    while (held.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
    writeStore(ids.map(id => id === "acct5" ? { ...account(id, `tok-${id}`), paused: true } : account(id, `tok-${id}`)), "acct1");
    for (const release of held.splice(0)) release();
    const results = await pending;
    expect(seen).not.toContain("Bearer tok-acct5");
    expect(seen).toHaveLength(4);
    expect(results?.find(row => row.accountId === "acct5")).toMatchObject({ status: "paused", paused: true, httpStatus: null });
  });

  test("a single account id probes only that account; an unknown id is null", async () => {
    writeStore([account("okacct1", "tok-ok"), account("other01", "tok-other")]);
    const seen = installUpstream({ "tok-ok": () => new Response(summaryBody, { status: 200 }) });
    const one = await probeAntigravityAccounts({ accountId: "okacct1" });
    expect(one?.map(row => row.accountId)).toEqual(["okacct1"]);
    expect(seen).toHaveLength(1);
    expect(await probeAntigravityAccounts({ accountId: "missing" })).toBeNull();
  });
});

describe("management routes", () => {
  function config(): OcxConfig {
    return {
      port: 10100,
      defaultProvider: "vendor",
      providers: {
        vendor: { adapter: "openai-chat", baseUrl: "https://vendor.example/v1", liveModels: false, models: ["known"] },
        // A refresh whose convergence gathered nothing fetches the roster itself; never reach the network.
        live: { adapter: "openai-chat", baseUrl: "https://live.example/v1", models: ["known"], fetch: liveRoster },
      },
    } as OcxConfig;
  }
  const liveRoster = (async () => Response.json({ object: "list", data: [{ id: "known", object: "model" }] })) as unknown as typeof fetch;

  async function call(live: OcxConfig, path: string, body: unknown, onConverge?: () => void) {
    const url = new URL(`http://localhost${path}`);
    const response = await handleManagementAPI(new Request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), url, live, {
      saveConfigPreservingClaudeCode: () => {},
      createManagementConvergeCodex: () => async () => {
        onConverge?.();
        return { kind: "catalog-only", changed: false, catalogRefresh: { status: "unchanged" }, observed: {} as never, history: {} as never };
      },
    });
    return { status: response!.status, json: await response!.json() as Record<string, unknown> };
  }

  test("POST /api/oauth/accounts/probe validates input and returns per-account results", async () => {
    writeStore([account("okacct1", "tok-ok")]);
    installUpstream({ "tok-ok": () => new Response(summaryBody, { status: 200 }) });
    const live = config();
    expect((await call(live, "/api/oauth/accounts/probe", { provider: "anthropic" })).status).toBe(400);
    expect((await call(live, "/api/oauth/accounts/probe", { provider: "google-antigravity", accountId: 7 })).status).toBe(400);
    expect((await call(live, "/api/oauth/accounts/probe", { provider: "google-antigravity", accountId: "nope" })).status).toBe(404);
    const ok = await call(live, "/api/oauth/accounts/probe", { provider: "google-antigravity", accountId: "okacct1" });
    expect(ok.status).toBe(200);
    expect(ok.json.provider).toBe("google-antigravity");
    expect(ok.json.results).toEqual([expect.objectContaining({ accountId: "okacct1", status: "ok", httpStatus: 200 })]);
    expect(JSON.stringify(ok.json)).not.toContain("tok-ok");
  });

  test("POST /api/model-discovery/refresh reports static providers and arrivals recorded by this call", async () => {
    const live = config();
    expect((await call(live, "/api/model-discovery/refresh", { provider: "missing" })).status).toBe(404);
    const statik = await call(live, "/api/model-discovery/refresh", { provider: "vendor" });
    expect(statik.json).toMatchObject({ ok: false, applicable: false, reason: "static_catalog" });

    live.modelDiscovery = { recentArrivals: { live: [{ id: "old", at: "2026-11-01T00:00:00Z" }] } };
    live.disabledModels = ["live/fresh"];
    const refreshed = await call(live, "/api/model-discovery/refresh", { provider: "live" }, () => {
      live.modelDiscovery!.recentArrivals!.live!.push({ id: "fresh", at: "2026-11-12T00:00:00Z" });
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.ok).toBe(true);
    expect(refreshed.json.newArrivals).toEqual([{ id: "fresh", at: "2026-11-12T00:00:00Z", state: "auto-disabled" }]);
    expect((refreshed.json.recentArrivals as unknown[]).length).toBe(2);
  });

  test("refresh reports arrival state exactly as GET /api/model-discovery does", async () => {
    const live = config();
    live.providers.live!.selectedModels = ["known"];
    live.modelDiscovery = { recentArrivals: { live: [
      { id: "picked-out", at: "2026-11-10T00:00:00Z" },
      { id: "hand-off", at: "2026-11-11T00:00:00Z", disabledByPolicy: false },
    ] } };
    live.disabledModels = ["live/hand-off"];
    const refreshed = await call(live, "/api/model-discovery/refresh", { provider: "live" });
    const url = new URL("http://localhost/api/model-discovery");
    const read = await handleManagementAPI(new Request(url), url, live, { saveConfigPreservingClaudeCode: () => {} });
    const listed = (await read!.json() as { recentArrivals: Record<string, unknown> }).recentArrivals.live;
    expect(refreshed.json.recentArrivals).toEqual(listed);
    expect((listed as Array<{ state: string }>).map(row => row.state)).toEqual(["not-selected", "disabled"]);
  });

  test("refresh still fetches the provider when catalog convergence skips without gathering", async () => {
    clearModelCache();
    const live = config();
    let fetched = 0;
    (live.providers.live as { fetch?: typeof fetch }).fetch = (async () => {
      fetched++;
      return Response.json({ object: "list", data: [{ id: "known", object: "model" }] });
    }) as unknown as typeof fetch;
    const refreshed = await call(live, "/api/model-discovery/refresh", { provider: "live" });
    expect(fetched).toBeGreaterThan(0);
    expect(refreshed.json.discovery).toMatchObject({ status: "ok" });
    expect(refreshed.json.liveModelCount).toBe(1);
  });
});

describe("ocx models discover", () => {
  async function discover(response: unknown, json = false) {
    const log = console.log;
    console.log = () => {};
    try {
      return await handleModelsRuntimeCommand("discover", ["live", ...(json ? ["--json"] : [])], {
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async () => Response.json(response),
      });
    } finally {
      console.log = log;
    }
  }

  test("a failed discovery answered with HTTP 200 exits nonzero, in text and JSON modes", async () => {
    const failed = { ok: true, provider: "live", discovery: { status: "failed", reason: "http_error", httpStatus: 401 }, liveModelCount: null, newArrivals: [], recentArrivals: [] };
    expect(await discover(failed)).toBe(1);
    expect(await discover(failed, true)).toBe(1);
    expect(await discover({ ...failed, discovery: { status: "ok" }, liveModelCount: 3 })).toBe(0);
    expect(await discover({ ok: false, provider: "live", applicable: false, reason: "static_catalog" })).toBe(0);
  });
});
