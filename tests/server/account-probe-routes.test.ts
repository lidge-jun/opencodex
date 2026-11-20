import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityCliUserAgent } from "../../src/adapters/client-fingerprint";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";
import { gatherRoutedModels, getLastComboCatalogOmissions } from "../../src/codex/catalog";
import { gatherRoutedModelsForCatalogGather } from "../../src/codex/catalog/routed-gather";
import { clearModelCache, getStaleCached } from "../../src/codex/model-cache";
import { cmdAccountProbe } from "../../src/cli/account-probe";
import { resolveObservedVertexDiscoveryAuth } from "../../src/providers/google-vertex-model-discovery";
import { pinnedHttpPost } from "../../src/lib/pinned-http";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import { setAntigravityAccountQuotaTransportForTests } from "../../src/providers/quota/antigravity";
import {
  classifyAntigravityProbeResponse,
  probeAntigravityAccounts,
} from "../../src/providers/quota/antigravity-account-probe";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementPrincipal } from "../../src/server/management-auth";
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
      .toMatchObject({ status: "permission_denied", reason: "PERMISSION_DENIED", message: null });
    expect(classifyAntigravityProbeResponse(429, googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded")).status).toBe("rate_limited");
    expect(classifyAntigravityProbeResponse(401, googleError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.")))
      .toMatchObject({ status: "error", reason: "UNAUTHENTICATED" });
    expect(classifyAntigravityProbeResponse(503, "upstream down")).toMatchObject({ status: "error", message: null });
  });
});

describe("probeAntigravityAccounts", () => {
  test("the pinned transport reads only bounded error evidence for probe verdicts", async () => {
    writeStore([
      account("verify1", "fixture-verify"), account("suspended1", "fixture-suspended"),
      account("disabled1", "fixture-disabled"), account("large1", "fixture-large"),
    ]);
    const bodyByAuth = new Map([
      ["Bearer fixture-verify", googleError(403, "PERMISSION_DENIED", "Verify your account.", "VALIDATION_REQUIRED")],
      ["Bearer fixture-suspended", googleError(403, "PERMISSION_DENIED", "This account has been suspended.")],
      ["Bearer fixture-disabled", googleError(403, "PERMISSION_DENIED", "This service is disabled.", "SERVICE_DISABLED")],
      ["Bearer fixture-large", " ".repeat(8 * 1024 + 1)],
    ]);
    const pinned = { address: "127.0.0.1", family: 4 };
    const upstream = Bun.serve({ hostname: pinned.address, port: 0, fetch: req =>
      new Response(bodyByAuth.get(req.headers.get("authorization") ?? ""), { status: 403 }) });
    try {
      setAntigravityAccountQuotaTransportForTests({
        resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [pinned], privateNetwork: false }),
        // Keep the probe's options but send only the synthetic requests to the local fixture.
        pinnedPost: (_url, address, body, signal, options) => pinnedHttpPost(upstream.url.href, address, body, signal, options),
      });
      expect(await probeAntigravityAccounts()).toEqual([
        expect.objectContaining({ status: "verification_required", httpStatus: 403, reason: "VALIDATION_REQUIRED", message: null }),
        expect.objectContaining({ status: "suspended", httpStatus: 403, message: null }),
        expect.objectContaining({ status: "permission_denied", httpStatus: 403, reason: "SERVICE_DISABLED", message: null }),
        expect.objectContaining({ status: "error", httpStatus: null, reason: "response_unusable", message: null }),
      ]);
      const plain = await pinnedHttpPost(upstream.url.href, pinned, "{}", undefined, { headers: { authorization: "Bearer fixture-verify" } });
      expect(plain.status).toBe(403);
      expect(plain.body).toBeNull();
    } finally {
      await upstream.stop(true);
    }
  });

  test("omits untrusted error strings and projects only known quota windows", async () => {
    writeStore([account("denied1", "fixture-access"), account("okacct1", "fixture-ok")]);
    const seen = installUpstream({
      "fixture-access": () => new Response(googleError(403, "FIXTURE_STATUS", "fixture-access", "FIXTURE_REASON"), { status: 403 }),
      "fixture-ok": () => Response.json({ groups: [{ displayName: "fixture-ok", buckets: [{ window: "5h", remainingFraction: 0.8 }] }] }),
    });
    const rows = await probeAntigravityAccounts();
    expect(seen).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({ accountId: "denied1", status: "permission_denied", reason: "PERMISSION_DENIED", message: null }),
      expect.objectContaining({ accountId: "okacct1", quota: null }),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/fixture-access|fixture-ok|FIXTURE_REASON|FIXTURE_STATUS/);
  });

  test.each([200, 403])("cancels an oversized HTTP %i body and returns a closed error", async status => {
    writeStore([account("okacct1", "tok-ok")]);
    let canceled = false;
    const seen = installUpstream({
      "tok-ok": () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(600 * 1024)); },
        pull(controller) { controller.close(); },
        cancel() { canceled = true; },
      }, { highWaterMark: 0 }), { status }),
    });
    const rows = await probeAntigravityAccounts();
    expect(seen).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ status: "error", reason: "response_unusable", quota: null });
    expect(canceled).toBe(true);
  });

  test("the deadline cancels a stalled error body", async () => {
    writeStore([account("okacct1", "tok-ok")]);
    const deadline = new AbortController();
    let canceled = false;
    const seen = installUpstream({
      "tok-ok": () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          deadline.abort(new DOMException("fixture deadline", "TimeoutError"));
          setTimeout(() => { if (!canceled) controller.close(); }, 50);
        },
        cancel() { canceled = true; },
      }, { highWaterMark: 0 }), { status: 403 }),
    });
    const rows = await probeAntigravityAccounts({ signal: deadline.signal });
    expect(seen).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ status: "error", reason: "timeout" });
    expect(canceled).toBe(true);
  });

  test("redirects are discarded without following the location or waiting for cancellation", async () => {
    writeStore([account("okacct1", "tok-ok")]);
    let canceled = false;
    const release = Promise.withResolvers<void>();
    const seen = installUpstream({
      "tok-ok": () => new Response(new ReadableStream({
        cancel() { canceled = true; return release.promise; },
      }), { status: 307, headers: { location: "https://example.test/other" } }),
    });
    let cancellationReleased = false;
    const timer = setTimeout(() => { cancellationReleased = true; release.resolve(); }, 100);
    try {
      expect((await probeAntigravityAccounts())?.[0]).toMatchObject({ status: "error", reason: "redirect_blocked", message: null });
      expect(canceled).toBe(true);
      expect(cancellationReleased).toBe(false);
      expect(seen.map(row => row.url)).toEqual([SUMMARY_URL]);
    } finally {
      clearTimeout(timer);
      release.resolve();
    }
  });

  test("a pause during DNS resolution suppresses dispatch of the stored credential", async () => {
    const row = account("okacct1", "tok-ok");
    writeStore([row]);
    let sends = 0;
    setAntigravityAccountQuotaTransportForTests({
      async resolveAddresses() {
        writeStore([{ ...row, paused: true }]);
        return { hostname: new URL(SUMMARY_URL).hostname, addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false };
      },
      async pinnedPost() { sends++; return Response.json({}); },
    });
    const rows = await probeAntigravityAccounts();
    expect(sends).toBe(0);
    expect(rows?.[0]?.status).toBe("error");
  });

  test("a passive probe leaves the store bytes and filesystem metadata untouched", async () => {
    const path = writeStore([account("okacct1", "tok-ok")]);
    const before = readFileSync(path, "utf8");
    chmodSync(path, 0o644);
    installUpstream({ "tok-ok": () => Response.json({}) });
    expect((await probeAntigravityAccounts())?.[0]?.status).toBe("ok");
    expect(readFileSync(path, "utf8")).toBe(before);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  test("a queued account removed during a batch sends no request", async () => {
    const ids = ["acct1", "acct2", "acct3", "acct4", "acct5"];
    const rows = ids.map(id => account(id, `tok-${id}`));
    writeStore(rows, "acct1");
    const seen = installUpstream({
      "tok-acct1": () => {
        writeStore(rows.slice(0, 4), "acct1");
        return Response.json({});
      },
    });
    const result = await probeAntigravityAccounts();
    expect(seen.map(row => row.auth)).toHaveLength(4);
    expect(result?.map(row => row.accountId)).not.toContain("acct5");
  });

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
    for (const token of ["tok-ok", "tok-verify", "tok-denied", "tok-limit", "tok-paused", "tok-expired", "tok-noproj", "refresh-"]) {
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

  async function call(live: OcxConfig, path: string, body: unknown, onConverge?: () => void, principal: ManagementPrincipal | null = "admin-token") {
    const url = new URL(`http://localhost${path}`);
    const response = await handleManagementAPI(new Request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), url, live, {
      saveConfigPreservingClaudeCode: () => {},
      createManagementConvergeCodex: () => async () => {
        onConverge?.();
        return { kind: "catalog-only", changed: false, catalogRefresh: { status: "unchanged" }, observed: {} as never, history: {} as never };
      },
    }, principal ?? undefined);
    return { status: response!.status, json: await response!.json() as Record<string, unknown> };
  }

  test("targeted CLI probe resolves the alias without changing the store bytes or file mode", async () => {
    const path = writeStore([{ ...account("okacct1", "fixture-active"), alias: "Work" }, account("other1", "fixture-other")]);
    const bytes = readFileSync(path);
    if (process.platform !== "win32") chmodSync(path, 0o644);
    const mode = statSync(path).mode;
    const seen = installUpstream({ "fixture-active": () => new Response(summaryBody) });
    const live = config();
    const fetchImpl = (async (input, init) => {
      const url = new URL(String(input));
      const req = new Request(url, init);
      return (await handleManagementAPI(req, url, live, { saveConfigPreservingClaudeCode: () => {} }, "admin-token"))!;
    }) as typeof fetch;

    expect(await cmdAccountProbe(["google-antigravity", "work"], { baseUrl: "http://127.0.0.1:1", fetchImpl })).toBe(0);
    expect(seen.map(row => row.auth)).toEqual(["Bearer fixture-active"]);
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode).toBe(mode);
  });

  test("account probes require an admin token or dashboard session principal", async () => {
    writeStore([account("okacct1", "tok-ok")]);
    const seen = installUpstream({ "tok-ok": () => Response.json({}) });
    for (const principal of [null, "local-read-capability"] as const) {
      expect((await call(config(), "/api/oauth/accounts/probe", { provider: "google-antigravity" }, undefined, principal)).status).toBe(403);
    }
    expect(seen).toHaveLength(0);
    expect((await call(config(), "/api/oauth/accounts/probe", { provider: "google-antigravity" }, undefined, "gui-session")).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test("a running batch rejects overlapping management probes", async () => {
    writeStore([account("okacct1", "tok-ok")]);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen = installUpstream({
      "tok-ok": () => {
        started.resolve();
        return new Response(new ReadableStream({
          async pull(controller) { await release.promise; controller.close(); },
        }));
      },
    });
    const first = call(config(), "/api/oauth/accounts/probe", { provider: "google-antigravity" });
    await started.promise;
    const second = call(config(), "/api/oauth/accounts/probe", { provider: "google-antigravity", accountId: "okacct1" });
    const finish = setTimeout(release.resolve, 100);
    try {
      expect((await second).status).toBe(409);
      expect(seen).toHaveLength(1);
    } finally {
      release.resolve();
      clearTimeout(finish);
      await first;
    }
    expect((await call(config(), "/api/oauth/accounts/probe", { provider: "google-antigravity" })).status).toBe(200);
  });

  test("POST /api/oauth/accounts/probe validates input and returns per-account results", async () => {
    writeStore([account("okacct1", "tok-ok")]);
    const seen = installUpstream({ "tok-ok": () => new Response(summaryBody, { status: 200 }) });
    const live = config();
    expect((await call(live, "/api/oauth/accounts/probe", { provider: "anthropic" })).status).toBe(400);
    expect((await call(live, "/api/oauth/accounts/probe", { provider: "google-antigravity", accountId: 7 })).status).toBe(400);
    expect((await call(live, "/api/oauth/accounts/probe", { provider: "google-antigravity", accountId: "nope" })).status).toBe(404);
    expect(seen).toHaveLength(0);
    const ok = await call(live, "/api/oauth/accounts/probe", { provider: "google-antigravity", accountId: "okacct1" });
    expect(ok.status).toBe(200);
    expect(ok.json.provider).toBe("google-antigravity");
    expect(ok.json.results).toEqual([expect.objectContaining({ accountId: "okacct1", status: "ok", httpStatus: 200 })]);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(ok.json)).not.toContain("tok-ok");
  });

  test("POST /api/model-discovery/refresh reports static providers and arrivals recorded by this call", async () => {
    const live = config();
    expect((await call(live, "/api/model-discovery/refresh", { provider: "missing" })).status).toBe(404);
    const statik = await call(live, "/api/model-discovery/refresh", { provider: "vendor" });
    expect(statik.json).toMatchObject({ ok: false, applicable: false, reason: "static_catalog" });

    const at = "2026-11-01T00:00:00Z";
    live.modelDiscovery = {
      newModelPolicy: "off",
      knownModels: { live: { ids: ["known", "old"], removed: [], updatedAt: at } },
      recentArrivals: { live: [{ id: "old", at }] },
    };
    (live.providers.live as { fetch?: typeof fetch }).fetch = (async () =>
      Response.json({ data: [{ id: "known" }, { id: "fresh" }] })) as typeof fetch;
    const refreshed = await call(live, "/api/model-discovery/refresh", { provider: "live" });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.ok).toBe(true);
    expect(refreshed.json.newArrivals).toEqual([expect.objectContaining({ id: "fresh", state: "auto-disabled" })]);
    expect(live.disabledModels).toContain("live/fresh");
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

  test("refresh fetches the provider without running catalog convergence", async () => {
    clearModelCache();
    const live = config();
    let fetched = 0;
    (live.providers.live as { fetch?: typeof fetch }).fetch = (async () => {
      fetched++;
      return Response.json({ object: "list", data: [{ id: "known", object: "model" }] });
    }) as unknown as typeof fetch;
    const refreshed = await call(live, "/api/model-discovery/refresh", { provider: "live" }, () => {
      throw new Error("discovery must not run a catalog-wide refresh");
    });
    expect(fetched).toBe(1);
    expect(refreshed.json.discovery).toMatchObject({ status: "ok" });
    expect(refreshed.json.liveModelCount).toBe(1);
  });

  test("manual discovery honors a provider's 429 cooldown", async () => {
    clearModelCache();
    const live = config();
    let sends = 0;
    (live.providers.live as { fetch?: typeof fetch }).fetch = (async () => {
      sends++;
      return new Response("rate-limited", { status: 429 });
    }) as typeof fetch;
    try {
      const refresh = () => call(live, "/api/model-discovery/refresh", { provider: "live" });
      const first = await refresh();
      expect(first.json.discovery).toEqual({ status: "failed", reason: "http", httpStatus: 429 });
      const retry = await refresh();
      expect(retry.status).toBe(200);
      expect(retry.json.discovery).toEqual(first.json.discovery);
      expect(retry.json.newArrivals).toEqual([]);
      expect(sends).toBe(1);
    } finally {
      clearModelCache();
    }
  });

  test("scoped discovery retains the catalog's provider alias ownership", async () => {
    clearModelCache();
    const live = config();
    live.providers["google-antigravity"] = live.providers.live!;
    live.providers.vendor!.alias = "agy";
    try {
      const refreshed = await call(live, "/api/model-discovery/refresh", { provider: "google-antigravity" });
      expect(refreshed.json.discovery).toEqual({ status: "ok" });
      expect(getStaleCached("google-antigravity")?.[0]?.providerAlias).toBeNull();
    } finally {
      clearModelCache();
    }
  });

  test("an overlapping manual refresh returns 409 without sending to any provider", async () => {
    clearModelCache();
    const live = config();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requested = 0;
    let unrelated = 0;
    (live.providers.live as { fetch?: typeof fetch }).fetch = (async () => {
      requested++;
      started.resolve();
      await release.promise;
      return new Response("rate-limited", { status: 429 });
    }) as typeof fetch;
    live.providers.unrelated = {
      ...live.providers.live!, baseUrl: "https://unrelated.example/v1",
      fetch: (async () => { unrelated++; return Response.json({ data: [{ id: "other" }] }); }) as typeof fetch,
    } as OcxConfig["providers"][string];
    try {
      const refresh = () => call(live, "/api/model-discovery/refresh", { provider: "live" });
      const first = refresh();
      await started.promise;
      const second = refresh();
      try {
        const result = await Promise.race([second, Bun.sleep(100).then(() => null)]);
        expect(result?.status).toBe(409);
        expect(result?.json.code).toBe("discovery_in_progress");
        expect({ requested, unrelated }).toEqual({ requested: 1, unrelated: 0 });
      } finally {
        release.resolve();
        await second;
        expect((await first).json.discovery).toEqual({ status: "failed", reason: "http", httpStatus: 429 });
      }
    } finally {
      release.resolve();
      clearModelCache();
    }
  });

  test.each(["refreshing", "observed"] as const)("manual refresh returns 409 during a held %s full gather", async mode => {
    clearModelCache();
    const live = config();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let sends = 0;
    (live.providers.live as { fetch?: typeof fetch }).fetch = (async () => {
      sends++;
      started.resolve();
      await release.promise;
      return new Response("rate-limited", { status: 429 });
    }) as typeof fetch;
    const full = mode === "refreshing" ? gatherRoutedModels(live)
      : gatherRoutedModelsForCatalogGather(live, { authStoreBuffer: null });
    try {
      await started.promise;
      const manual = call(live, "/api/model-discovery/refresh", { provider: "live" });
      try {
        const result = await Promise.race([manual, Bun.sleep(100).then(() => null)]);
        expect(result?.status).toBe(409);
        expect(result?.json.code).toBe("discovery_in_progress");
        expect(sends).toBe(1);
      } finally {
        release.resolve();
        await manual;
      }
    } finally {
      release.resolve();
      await full;
      clearModelCache();
    }
  });

  test("a second manual Vertex refresh returns 409 after an A → B → A credential rotation", async () => {
    const name = "manual-vertex";
    const live = config();
    const originalKey = process.env.GOOGLE_CLOUD_API_KEY;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let sends = 0;
    live.providers[name] = {
      adapter: "google", googleMode: "vertex", authMode: "key", liveModels: true,
      baseUrl: "https://aiplatform.googleapis.com",
      fetch: (async () => {
        sends++;
        started.resolve();
        await release.promise;
        return new Response(null, { status: 429 });
      }) as typeof fetch,
    } as OcxConfig["providers"][string];
    process.env.GOOGLE_CLOUD_API_KEY = "fixture-vertex-a";
    const refresh = () => call(live, "/api/model-discovery/refresh", { provider: name });
    const first = refresh();
    try {
      await started.promise;
      process.env.GOOGLE_CLOUD_API_KEY = "fixture-vertex-b";
      expect(resolveObservedVertexDiscoveryAuth(live.providers[name]!)?.token).toBe("fixture-vertex-b");
      process.env.GOOGLE_CLOUD_API_KEY = "fixture-vertex-a";
      const second = refresh();
      try {
        const result = await Promise.race([second, Bun.sleep(100).then(() => null)]);
        expect(result?.status).toBe(409);
        expect(result?.json.code).toBe("discovery_in_progress");
        expect(sends).toBe(1);
      } finally {
        release.resolve();
        await second;
      }
    } finally {
      release.resolve();
      await first;
      if (originalKey === undefined) delete process.env.GOOGLE_CLOUD_API_KEY;
      else process.env.GOOGLE_CLOUD_API_KEY = originalKey;
      clearModelCache(name);
    }
  });

  test("a scoped refresh preserves full-gather omissions and skips sibling combos", async () => {
    clearModelCache();
    const live = config();
    const combo = { strategy: "failover", stickyLimit: 1, defaultEffort: "medium", alias: null } as const;
    live.combos = {
      healthy: { ...combo, targets: [{ provider: "vendor", model: "known", weight: 1 }] },
      unavailable: { ...combo, targets: [{ provider: "missing", model: "unknown", weight: 1 }] },
    };
    try {
      await gatherRoutedModels(live);
      const published = getLastComboCatalogOmissions();
      expect(published.map(item => item.id)).toEqual(["unavailable"]);
      const scoped: Array<(typeof published)[number]> = [];
      await gatherRoutedModels(live, { onlyProvider: "live", comboOmissions: scoped });
      expect(scoped).toEqual([]);
      expect(getLastComboCatalogOmissions()).toEqual(published);
    } finally {
      clearModelCache();
      await gatherRoutedModels({ ...live, providers: {}, combos: {} });
    }
  });

  test("a disabled provider cannot report a successful discovery without a live observation", async () => {
    const live = config();
    live.providers.live!.disabled = true;
    const result = await call(live, "/api/model-discovery/refresh", { provider: "live" });
    expect(result.status).toBe(503);
    expect(result.json).toMatchObject({ error: "live model discovery did not produce an observation" });
  });

  test("a refresh whose live fetch fails keeps the last good list as the fallback", async () => {
    clearModelCache();
    const live = config();
    let fail = false;
    (live.providers.live as { fetch?: typeof fetch }).fetch = (async () => fail
      ? new Response("down", { status: 500 })
      : Response.json({ object: "list", data: [{ id: "known", object: "model" }, { id: "extra", object: "model" }] })) as unknown as typeof fetch;
    try {
      expect((await call(live, "/api/model-discovery/refresh", { provider: "live" })).json.discovery).toMatchObject({ status: "ok" });
      fail = true;
      const failed = await call(live, "/api/model-discovery/refresh", { provider: "live" });
      expect(failed.json.discovery).toMatchObject({ status: "failed" });
      expect((getStaleCached("live") ?? []).map(row => row.id).sort()).toEqual(["extra", "known"]);
    } finally {
      clearModelCache();
    }
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
