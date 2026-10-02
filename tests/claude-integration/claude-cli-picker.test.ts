// INV-CLIPICKER-01: cc catalog rows only for CLI-classified, CLI-first-party requests; registry-decodable aliases only; fail-open.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeDesktop3pAlias, buildDesktop3pRegistry, resolveDesktop3pAlias } from "../../src/claude/desktop-3p";
import { DESKTOP_3P_REGISTRY_RETRY_MS, ensureDesktop3pRegistry } from "../../src/claude/desktop-3p-startup";
import { reconcileClaudeFirstPartySettings } from "../../src/claude/first-party-settings";
import {
  cliCatalogEligible, cliCatalogKind, injectCliBootstrapOptions, invalidateClaudeCodeServedCatalog,
  rewriteCliCatalogBody, rewriteCliCatalogResponse,
} from "../../src/claude/intercept/cli-catalog";
import { createCliCatalogProvider } from "../../src/claude/intercept/cli-picker";
import { CLAUDE_INTERCEPT_HOSTS, startConnectProxy } from "../../src/claude/intercept/connect-proxy";
import { CLAUDE_INTERCEPT_UPSTREAM, startClaudeInterceptListener } from "../../src/claude/intercept/listener";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { BOOTSTRAP_MAX_DECODED_BYTES, injectPickerModels, type PickerModelEntry } from "../../src/claude/intercept/picker-bootstrap";
import { buildCliPickerModels, routableCliPickerModels, type PickerRouteInput } from "../../src/claude/intercept/picker-models";
import { applyClaudeInterceptSettings, buildClaudeInterceptEnv } from "../../src/claude/intercept/settings";

/**
 * The Claude Code CLI's /model picker: which catalog requests the intercept may extend, how rows
 * merge into the cc surface and the bootstrap fallback, which registry aliases are advertised, and
 * when the CLI's cached catalog is dropped. No real network: Anthropic is a local Bun server.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CLI_UA = "claude-cli/2.1.287 (external, cli)";
const DESKTOP_UA = "claude-cli/2.1.287 (external, claude-desktop)";
const BOTH = { desktop: true, cli: true };
const DESKTOP_ONLY = { desktop: true, cli: false };
const ROW: PickerModelEntry = { id: "claude-opus-4-8-abc", name: "Grok 4.7 (xai)", description: "opencodex · xai/grok-4.7", contextWindow: 128_000 };

const ROUTES: PickerRouteInput = {
  nativeSlugs: ["gpt-6-sol"],
  routedModels: [
    { provider: "xai", id: "grok-4.7", contextWindow: 128_000 },
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "kimi", id: "k3", contextWindow: 1_048_576 },
  ],
};
function installRegistry(input: PickerRouteInput = ROUTES): void {
  buildDesktop3pRegistry(input.nativeSlugs, input.routedModels);
}

function modelSelector() {
  return {
    model_selector_state: { current: "claude-opus-5-5" },
    model_selector_config: [
      { id: "cc", models: [{
        id: "claude-opus-5-5", name: "Opus 5.5", section: "main", notice: { text: "x" }, selection_notice: "y",
        min_claude_code_version: "2.1.280", thinking: { type: "effort" }, description: "Most capable", context_window: 200_000,
      }] },
      { id: "ccd", models: [{ id: "claude-opus-5-5", name: "Opus 5.5", section: "main" }] },
    ],
  };
}

test("only GET on the CLI catalog paths is a catalog request", () => {
  expect(cliCatalogKind("GET", "/api/organizations/0b6c1f2e-1111-4222-8333-944455556666/model_selector/cc")).toBe("model_selector");
  expect(cliCatalogKind("GET", "/api/organizations/abc/model_selector/cc/")).toBe("model_selector");
  expect(cliCatalogKind("GET", "/api/model_selector/cc")).toBe("model_selector");
  expect(cliCatalogKind("GET", "/api/claude_cli/bootstrap")).toBe("bootstrap");
  expect(cliCatalogKind("POST", "/api/model_selector/cc")).toBeNull();
  expect(cliCatalogKind("HEAD", "/api/claude_cli/bootstrap")).toBeNull();
  for (const path of [
    "/api/organizations/abc/model_selector/ccd", "/api/model_selector/ccd", "/api/organizations/a/b/model_selector/cc",
    "/api/bootstrap", "/api/claude_cli/bootstrap/extra", "/v1/models", "/api/model_selector/cc/x",
  ]) expect(cliCatalogKind("GET", path)).toBeNull();
});

test("the cc catalog follows the CLI client and CLI intent; the bootstrap follows CLI intent alone", () => {
  expect(cliCatalogEligible("model_selector", CLI_UA, BOTH)).toBe(true);
  expect(cliCatalogEligible("model_selector", CLI_UA, DESKTOP_ONLY)).toBe(false);
  expect(cliCatalogEligible("model_selector", DESKTOP_UA, BOTH)).toBe(false);
  expect(cliCatalogEligible("model_selector", "claude-code/2.1.287", BOTH)).toBe(false);
  expect(cliCatalogEligible("model_selector", null, BOTH)).toBe(false);
  expect(cliCatalogEligible("bootstrap", "claude-code/2.1.287", BOTH)).toBe(true);
  expect(cliCatalogEligible("bootstrap", "claude-code/2.1.287", DESKTOP_ONLY)).toBe(false);
});

test("model_selector rows land on cc only, without the template's notices or version gates", () => {
  const out = rewriteCliCatalogBody("model_selector", JSON.stringify(modelSelector()), [ROW, ROW]);
  expect(out).not.toBeNull();
  const parsed = JSON.parse(out!) as ReturnType<typeof modelSelector>;
  const cc = parsed.model_selector_config[0]!.models as Array<Record<string, unknown>>;
  expect(cc.map(row => row.id)).toEqual(["claude-opus-5-5", ROW.id]);
  expect(cc[0]).toEqual(modelSelector().model_selector_config[0]!.models[0]!);
  expect(cc[1]).toEqual({
    id: ROW.id, name: ROW.name, section: "main", thinking: { type: "effort" },
    context_window: 128_000, description: "opencodex · xai/grok-4.7",
  });
  expect(parsed.model_selector_config[1]).toEqual(modelSelector().model_selector_config[1]!);
  expect(parsed.model_selector_state).toEqual(modelSelector().model_selector_state);
  // Already advertised, nothing to add, or not JSON: relay unchanged.
  expect(rewriteCliCatalogBody("model_selector", out!, [ROW])).toBeNull();
  expect(rewriteCliCatalogBody("model_selector", JSON.stringify(modelSelector()), [])).toBeNull();
  expect(rewriteCliCatalogBody("model_selector", "{not json", [ROW])).toBeNull();
  expect(rewriteCliCatalogBody("model_selector", JSON.stringify({ model_selector_config: [{ id: "ccd", models: [] }] }), [ROW])).toBeNull();
});

test("bootstrap rows join additional_model_options, created when absent, never over a foreign shape", () => {
  const existing = { model: "claude-haiku-5", name: "Haiku", description: "fast" };
  const appended = JSON.parse(rewriteCliCatalogBody("bootstrap", JSON.stringify({ other: 1, additional_model_options: [existing] }), [ROW])!);
  expect(appended).toEqual({ other: 1, additional_model_options: [existing, { model: ROW.id, name: ROW.name, description: ROW.description }] });
  for (const body of [{ other: 1 }, { other: 1, additional_model_options: null }]) {
    const created = JSON.parse(rewriteCliCatalogBody("bootstrap", JSON.stringify(body), [{ id: "claude-opus-4-8-xyz", name: "No description" }])!);
    expect(created.additional_model_options).toEqual([{ model: "claude-opus-4-8-xyz", name: "No description", description: "" }]);
    expect(created.other).toBe(1);
  }
  expect(rewriteCliCatalogBody("bootstrap", JSON.stringify({ additional_model_options: { model: "x" } }), [ROW])).toBeNull();
  expect(rewriteCliCatalogBody("bootstrap", JSON.stringify({ additional_model_options: "x" }), [ROW])).toBeNull();
  expect(rewriteCliCatalogBody("bootstrap", JSON.stringify([]), [ROW])).toBeNull();
  expect(rewriteCliCatalogBody("bootstrap", JSON.stringify({ additional_model_options: [{ model: ROW.id }] }), [ROW])).toBeNull();
});

test("Desktop picker injection without options keeps its surfaces and row shape", () => {
  const template = {
    id: "claude-opus-5-5", name: "Opus 5.5", section: "main", notice: { text: "kept by Desktop" },
    thinking: { enabled: true }, description: "old", badge: "new", tooltip: "t", fast_mode: true,
    disabled_reason: null, min_version: "1", context_window: 200_000,
  };
  const body = {
    model_selector_config: [
      { id: "ccd", models: [{ ...template }] },
      { id: "cc", models: [{ ...template }] },
    ],
  };
  const desktopRows: PickerModelEntry[] = [{ id: "ocx-claude-xai--grok-4.7", name: "Grok 4.7 (xai)", contextWindow: 128_000 }];
  expect(injectPickerModels(body, desktopRows)).toBe(1);
  expect(body.model_selector_config[1]!.models).toEqual([template]);
  expect(body.model_selector_config[0]!.models[1] as Record<string, unknown>).toEqual({
    id: "ocx-claude-xai--grok-4.7", name: "Grok 4.7 (xai)", section: "main", notice: { text: "kept by Desktop" },
    thinking: { enabled: true }, context_window: 128_000,
  });
});

test("CLI rows carry decodable registry aliases, labels and route descriptions; Anthropic rows are skipped", () => {
  installRegistry();
  const rows = buildCliPickerModels(ROUTES);
  const sol = activeDesktop3pAlias("native", "gpt-6-sol");
  const grok = activeDesktop3pAlias("xai", "grok-4.7");
  const k3 = activeDesktop3pAlias("kimi", "k3");
  for (const alias of [sol, grok, k3]) expect(alias).toMatch(/^claude-opus-4-8-[a-z][a-z0-9]{2}$/);
  expect(rows.map(row => row.id)).toEqual([sol, grok, k3 + "[1m]"]);
  expect(rows[0]).toMatchObject({ name: "GPT 6 Sol (native)", description: "opencodex · native/gpt-6-sol" });
  expect(rows[1]).toEqual({ id: grok, name: "Grok 4.7 (xai)", description: "opencodex · xai/grok-4.7", route: "xai/grok-4.7", contextWindow: 128_000 });
  expect(rows[2]).toMatchObject({ description: "opencodex · kimi/k3", contextWindow: 1_048_576 });
  expect(rows.some(row => row.description?.includes("anthropic/"))).toBe(false);
  expect(resolveDesktop3pAlias(grok)).toBe("xai/grok-4.7");
});

test("routes missing from the registry are not advertised, and a rebuilt registry retires stale rows", () => {
  installRegistry({ nativeSlugs: ["gpt-6-sol"], routedModels: [{ provider: "xai", id: "grok-4.7", contextWindow: 128_000 }] });
  const rows = buildCliPickerModels(ROUTES);
  expect(rows.map(row => row.description)).toEqual(["opencodex · native/gpt-6-sol", "opencodex · xai/grok-4.7"]);

  installRegistry();
  const full = buildCliPickerModels(ROUTES);
  expect(routableCliPickerModels(full)).toEqual(full);
  installRegistry({ nativeSlugs: [], routedModels: [{ provider: "kimi", id: "k3", contextWindow: 1_048_576 }] });
  expect(routableCliPickerModels(full).map(row => row.description)).toEqual(["opencodex · kimi/k3"]);
});

test("catalog responses are rewritten only for a 2xx JSON body, with stale validators dropped", async () => {
  const failed = new Response("nope", { status: 503 });
  expect(await rewriteCliCatalogResponse(failed, "model_selector", [ROW])).toBe(failed);

  const garbage = await rewriteCliCatalogResponse(
    new Response("<html>", { status: 200, headers: { etag: "\"v1\"", "content-type": "text/html" } }), "model_selector", [ROW]);
  expect(garbage.status).toBe(200);
  expect(garbage.headers.get("etag")).toBe("\"v1\"");
  expect(await garbage.text()).toBe("<html>");

  const raw = JSON.stringify(modelSelector());
  const ok = await rewriteCliCatalogResponse(new Response(raw, { status: 200, headers: {
    etag: "\"v1\"", "content-length": String(raw.length), "content-type": "application/json; charset=utf-8", "x-request-id": "r1",
  } }), "model_selector", [ROW]);
  expect(ok.headers.get("etag")).toBeNull();
  expect(ok.headers.get("x-request-id")).toBe("r1");
  expect(ok.headers.get("content-type")).toBe("application/json");
  const text = await ok.text();
  expect(ok.headers.get("content-length") === null || Number(ok.headers.get("content-length")) === Buffer.byteLength(text)).toBe(true);
  expect(JSON.parse(text).model_selector_config[0].models.map((row: { id: string }) => row.id)).toEqual(["claude-opus-5-5", ROW.id]);
});

const AUTH_TOKEN = "cli-picker-proxy-token";
interface CatalogPair { proxyPort: number; caPem: string; hookCalls: string[]; upstreamHits: string[] }

async function startCatalogPair(
  hook: (req: Request, kind: string) => Promise<readonly PickerModelEntry[] | null>,
  route: (req: Request) => "router" | "relay-native",
): Promise<CatalogPair> {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, CLAUDE_INTERCEPT_HOSTS);
  const hookCalls: string[] = [];
  const upstreamHits: string[] = [];
  const fakeAnthropic = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/model_selector/cc")) return Response.json(modelSelector(), { headers: { etag: "\"cat\"" } });
      if (path === "/api/claude_cli/bootstrap") return Response.json({ additional_model_options: [] });
      return Response.json({ relayed: true });
    },
  });
  cleanups.push(() => fakeAnthropic.stop(true));
  const fakeOrigin = "http://127.0.0.1:" + fakeAnthropic.port;
  // Both relay targets are recorded; the real Anthropic origin is redirected to the local server.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    upstreamHits.push(target);
    return fetch(target.replace(CLAUDE_INTERCEPT_UPSTREAM, fakeOrigin), init);
  }) as typeof fetch;
  const listener = startClaudeInterceptListener({
    leaf,
    upstreamBase: fakeOrigin,
    fetchImpl,
    route,
    dispatch: async () => Response.json({ dispatched: true }),
    cliCatalog: async (req, kind) => {
      hookCalls.push(kind + " " + new URL(req.url).pathname);
      return hook(req, kind);
    },
  });
  cleanups.push(() => listener.stop(true));
  const proxy = await startConnectProxy(0, { interceptPort: listener.port!, authToken: AUTH_TOKEN });
  cleanups.push(proxy.close);
  return { proxyPort: proxy.port, caPem: ca.certPem, hookCalls, upstreamHits };
}

async function getViaProxy(pair: CatalogPair, path: string, userAgent: string): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch("https://api.anthropic.com" + path, {
    headers: { "user-agent": userAgent },
    proxy: "http://opencodex:" + AUTH_TOKEN + "@127.0.0.1:" + pair.proxyPort,
    tls: { ca: pair.caPem },
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

test("the intercept listener merges hook rows into a CLI catalog relayed through the CONNECT proxy", async () => {
  const pair = await startCatalogPair(
    async (req, kind) => cliCatalogEligible(kind as "model_selector", req.headers.get("user-agent"), BOTH) ? [ROW] : null,
    () => "router",
  );
  const cli = await getViaProxy(pair, "/api/organizations/abc/model_selector/cc", CLI_UA);
  expect(cli.status).toBe(200);
  expect(cli.headers.get("etag")).toBeNull();
  expect(cli.json.model_selector_config[0].models.map((row: { id: string }) => row.id)).toEqual(["claude-opus-5-5", ROW.id]);
  expect(cli.json.model_selector_config[0].models[1].description).toBe(ROW.description);

  const desktop = await getViaProxy(pair, "/api/organizations/abc/model_selector/cc", DESKTOP_UA);
  expect(desktop.json).toEqual(modelSelector());
  expect(desktop.headers.get("etag")).toBe("\"cat\"");

  expect(await getViaProxy(pair, "/v1/models", CLI_UA).then(res => res.json)).toEqual({ relayed: true });
  expect(pair.hookCalls).toEqual([
    "model_selector /api/organizations/abc/model_selector/cc",
    "model_selector /api/organizations/abc/model_selector/cc",
  ]);
});

test("a catalog the route sends to native Anthropic still consults the hook, and a failing hook fails open", async () => {
  let fail = false;
  const pair = await startCatalogPair(async () => {
    if (fail) throw new Error("discovery exploded");
    return [ROW];
  }, () => "relay-native");
  const bootstrap = await getViaProxy(pair, "/api/claude_cli/bootstrap", "claude-code/2.1.287");
  expect(bootstrap.json).toEqual({ additional_model_options: [{ model: ROW.id, name: ROW.name, description: ROW.description }] });
  expect(pair.hookCalls).toEqual(["bootstrap /api/claude_cli/bootstrap"]);
  expect(pair.upstreamHits).toEqual([CLAUDE_INTERCEPT_UPSTREAM + "/api/claude_cli/bootstrap"]);

  fail = true;
  const unchanged = await getViaProxy(pair, "/api/claude_cli/bootstrap", "claude-code/2.1.287");
  expect(unchanged.status).toBe(200);
  expect(unchanged.json).toEqual({ additional_model_options: [] });
  expect(pair.hookCalls).toHaveLength(2);
});

function catalogRequest(userAgent: string): Request {
  return new Request("https://api.anthropic.com/api/model_selector/cc", { headers: { "user-agent": userAgent } });
}

test("the CLI catalog provider gates on eligibility, builds on a cold start, and answers from disk after a restart", async () => {
  const configDir = tempDir("ocx-cli-picker-");
  let desired = DESKTOP_ONLY;
  let loads = 0;
  let registryBuilds = 0;
  const options = {
    configDir,
    desiredClients: () => desired,
    ensureRegistry: async () => { registryBuilds++; installRegistry(); },
    loadRoutes: async () => { loads++; return ROUTES; },
  };
  const provider = createCliCatalogProvider(options);
  expect(await provider(catalogRequest(CLI_UA), "model_selector")).toBeNull();
  expect(loads).toBe(0);
  expect(registryBuilds).toBe(0);

  desired = BOTH;
  expect(await provider(catalogRequest(DESKTOP_UA), "model_selector")).toBeNull();
  expect(loads).toBe(0);
  const rows = await provider(catalogRequest(CLI_UA), "model_selector");
  expect(rows?.map(row => row.description)).toEqual(["opencodex · native/gpt-6-sol", "opencodex · xai/grok-4.7", "opencodex · kimi/k3"]);
  expect(loads).toBe(1);

  const restarted = createCliCatalogProvider({ ...options, loadRoutes: async () => { loads++; return new Promise<never>(() => {}); } });
  expect(await restarted(catalogRequest(CLI_UA), "model_selector")).toEqual(rows!);
  expect(loads).toBe(1);
});

test("a hanging discovery on a cold start relays unchanged within the wait bound", async () => {
  const configDir = tempDir("ocx-cli-picker-cold-");
  const provider = createCliCatalogProvider({
    configDir,
    coldWaitMs: 30,
    desiredClients: () => BOTH,
    ensureRegistry: async () => installRegistry(),
    loadRoutes: () => new Promise<never>(() => {}),
  });
  const started = performance.now();
  expect(await provider(catalogRequest(CLI_UA), "model_selector")).toBeNull();
  expect(performance.now() - started).toBeLessThan(2_000);
});

test("a persisted snapshot waits for the restarted process's registry build before answering", async () => {
  const configDir = tempDir("ocx-cli-picker-restart-");
  installRegistry();
  const first = createCliCatalogProvider({
    configDir, desiredClients: () => BOTH, ensureRegistry: async () => {}, loadRoutes: async () => ROUTES,
  });
  const rows = await first(catalogRequest(CLI_UA), "model_selector");
  expect(rows).toHaveLength(3);
  // A restart begins with an empty registry; the shared build lands a moment later.
  buildDesktop3pRegistry([], []);
  let builds = 0;
  const restarted = createCliCatalogProvider({
    configDir, desiredClients: () => BOTH,
    ensureRegistry: async () => { builds++; await Bun.sleep(5); installRegistry(); },
    loadRoutes: () => new Promise<never>(() => {}),
  });
  expect(await restarted(catalogRequest(CLI_UA), "model_selector")).toEqual(rows!);
  expect(builds).toBe(1);
});

test("a persisted snapshot from a retired provider setup is rebuilt before answering", async () => {
  const configDir = tempDir("ocx-cli-picker-reconfig-");
  installRegistry();
  const before = createCliCatalogProvider({
    configDir, desiredClients: () => BOTH, ensureRegistry: async () => {}, loadRoutes: async () => ROUTES,
  });
  expect(await before(catalogRequest(CLI_UA), "model_selector")).toHaveLength(3);
  // The operator replaced every provider: none of the persisted rows decode any more.
  const next: PickerRouteInput = { nativeSlugs: [], routedModels: [{ provider: "moonshot", id: "kimi-for-coding" }] };
  installRegistry(next);
  const after = createCliCatalogProvider({
    configDir, desiredClients: () => BOTH, ensureRegistry: async () => {}, loadRoutes: async () => next,
  });
  const rows = await after(catalogRequest(CLI_UA), "model_selector");
  expect(rows?.map(row => row.route)).toEqual(["moonshot/kimi-for-coding"]);
});

test("one catalog request never waits past a single cold-wait deadline", async () => {
  const configDir = tempDir("ocx-cli-picker-deadline-");
  installRegistry();
  const seed = createCliCatalogProvider({ configDir, desiredClients: () => BOTH, ensureRegistry: async () => {}, loadRoutes: async () => ROUTES });
  expect(await seed(catalogRequest(CLI_UA), "model_selector")).toHaveLength(3);
  buildDesktop3pRegistry([], []);
  const slow = createCliCatalogProvider({
    configDir, desiredClients: () => BOTH, coldWaitMs: 120, registryReady: () => true,
    ensureRegistry: () => new Promise<never>(() => {}), loadRoutes: () => new Promise<never>(() => {}),
  });
  const started = performance.now();
  expect(await slow(catalogRequest(CLI_UA), "model_selector")).toEqual([]);
  expect(performance.now() - started).toBeLessThan(220);
});

test("a failed registry build keeps the last good snapshot instead of persisting an empty one", async () => {
  const configDir = tempDir("ocx-cli-picker-keep-");
  installRegistry();
  const seed = createCliCatalogProvider({ configDir, desiredClients: () => BOTH, ensureRegistry: async () => {}, loadRoutes: async () => ROUTES });
  const rows = await seed(catalogRequest(CLI_UA), "model_selector");
  expect(rows).toHaveLength(3);
  // The restarted process's build fails: it resolves (cooldown) and leaves the registry empty.
  buildDesktop3pRegistry([], []);
  let loads = 0;
  const failing = createCliCatalogProvider({
    configDir, desiredClients: () => BOTH, ensureRegistry: async () => {}, loadRoutes: async () => { loads++; return ROUTES; },
  });
  expect(await failing(catalogRequest(CLI_UA), "model_selector")).toEqual([]);
  expect(loads).toBe(0);
  // Once the registry is back, the persisted rows answer again.
  installRegistry();
  const recovered = createCliCatalogProvider({ configDir, desiredClients: () => BOTH, ensureRegistry: async () => {}, loadRoutes: () => new Promise<never>(() => {}) });
  expect(await recovered(catalogRequest(CLI_UA), "model_selector")).toEqual(rows!);
});

test("a persisted row is retired when its alias now decodes to a different route", () => {
  installRegistry();
  const [sol] = buildCliPickerModels(ROUTES);
  expect(routableCliPickerModels([sol!])).toEqual([sol!]);
  expect(routableCliPickerModels([{ ...sol!, route: "xai/grok-4.7" }])).toEqual([]);
  expect(routableCliPickerModels([{ id: sol!.id, name: sol!.name }])).toEqual([]);
});

test("an oversized catalog is cut off while streaming instead of being buffered", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const response = await rewriteCliCatalogResponse(new Response(body, { status: 200 }), "model_selector", [ROW]);
  expect(response.status).toBe(502);
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThanOrEqual(18);
});

test("a failed on-demand registry build is not retried until the cooldown passes", async () => {
  buildDesktop3pRegistry([], []);
  const warn = console.warn;
  console.warn = () => {};
  try {
    let reads = 0;
    // Every field access throws, so the build fails inside its own catch.
    const broken = new Proxy({}, { get() { throw new Error("config unavailable"); } }) as never;
    const readConfig = () => { reads++; return broken; };
    await ensureDesktop3pRegistry(readConfig);
    expect(reads).toBe(1);
    await ensureDesktop3pRegistry(readConfig);
    expect(reads).toBe(1);
    await ensureDesktop3pRegistry(readConfig, () => Date.now() + DESKTOP_3P_REGISTRY_RETRY_MS + 1);
    expect(reads).toBe(2);
  } finally {
    console.warn = warn;
  }
});

function seedCatalogCache(claudeDir: string): string {
  const dir = join(claudeDir, "cache", "model-catalog");
  mkdirSync(dir, { recursive: true });
  for (const name of ["org-1-cc.json", "default-cc.json", "org-1-ccd.json", "org-1-cc.headless-failed.json", "notes.txt"]) {
    writeFileSync(join(dir, name), "{}");
  }
  return dir;
}
const SURVIVORS = ["notes.txt", "org-1-cc.headless-failed.json", "org-1-ccd.json"];

test("invalidating the served catalog drops only the CLI's cc copies and tolerates a missing cache", () => {
  const claudeDir = tempDir("ocx-cli-cache-");
  expect(invalidateClaudeCodeServedCatalog(claudeDir)).toBe(0);
  const dir = seedCatalogCache(claudeDir);
  expect(invalidateClaudeCodeServedCatalog(claudeDir)).toBe(2);
  expect(readdirSync(dir).sort()).toEqual(SURVIVORS);
});

test("writing the intercept settings and a successful first-party reconcile drop the cached cc catalog", () => {
  const claudeDir = tempDir("ocx-cli-settings-");
  const dir = seedCatalogCache(claudeDir);
  const written = applyClaudeInterceptSettings(buildClaudeInterceptEnv(18_765, join(claudeDir, "ca.pem"), "token"), claudeDir);
  expect(written).toMatchObject({ ok: true, changed: true });
  expect(readdirSync(dir).sort()).toEqual(SURVIVORS);

  // CLI intent can flip while the shared env stays put; a successful reconcile still invalidates.
  const opencodexDir = tempDir("ocx-cli-reconcile-");
  writeFileSync(join(dir, "org-2-cc.json"), "{}");
  const config = {} as Parameters<typeof reconcileClaudeFirstPartySettings>[0];
  const removed = reconcileClaudeFirstPartySettings(config, { desktop: false, cli: false }, { claudeConfigDir: claudeDir, opencodexConfigDir: opencodexDir });
  expect(removed.ok).toBe(true);
  expect(existsSync(join(dir, "org-2-cc.json"))).toBe(false);

  // A failed reconcile leaves the cache for the next attempt.
  writeFileSync(join(claudeDir, "settings.json"), "{not json");
  writeFileSync(join(dir, "org-3-cc.json"), "{}");
  const failed = reconcileClaudeFirstPartySettings(config, { desktop: false, cli: false }, { claudeConfigDir: claudeDir, opencodexConfigDir: opencodexDir });
  expect(failed).toMatchObject({ ok: false, reason: "unreadable" });
  expect(existsSync(join(dir, "org-3-cc.json"))).toBe(true);
});


test("CLI retained metadata amplification fails open with original response bytes and headers", async () => {
  const text = JSON.stringify({ model_selector_config: [{ id: "cc", models: [{
    id: "claude-native", metadata: { retained: "x".repeat(1024 * 1024) },
  }] }] });
  const aliases = Array.from({ length: 32 }, (_, i) => ({ id: `claude-alias-${i}`, name: `Route ${i}` }));
  const response = await rewriteCliCatalogResponse(new Response(text, {
    headers: { etag: '"native"', "x-request-id": "catalog-test" },
  }), "model_selector", aliases);
  expect((await response.text()) === text).toBe(true);
  expect(response.headers.get("etag")).toBe('"native"');
  expect(response.headers.get("x-request-id")).toBe("catalog-test");
});

test("CLI selector and explicit bootstrap fallback share the final output cap", () => {
  const aliases = Array.from({ length: 32 }, (_, i) => ({ id: `claude-alias-${i}`, name: `Route ${i}` }));
  for (const [kind, body] of [["model_selector", modelSelector()], ["bootstrap", {}]] as const) {
    const text = JSON.stringify({ ...body, padding: "x".repeat(BOOTSTRAP_MAX_DECODED_BYTES - 1000) });
    expect(Buffer.byteLength(text)).toBeLessThan(BOOTSTRAP_MAX_DECODED_BYTES);
    expect(rewriteCliCatalogBody(kind, text, aliases) === null).toBe(true);
  }
});

test("CLI fallback refuses oversized row fields without changing its parsed input", () => {
  const row = { ...ROW, description: "x".repeat(1024 * 1024) };
  const body = { additional_model_options: [{ model: "native" }] };
  expect(injectCliBootstrapOptions(body, [ROW, row])).toBe(1);
  const fresh = { additional_model_options: [{ model: "native" }] };
  expect(injectCliBootstrapOptions(fresh, [ROW, { ...row, id: "claude-oversized" }])).toBe(0);
  expect(fresh.additional_model_options).toEqual([{ model: "native" }]);
  expect(rewriteCliCatalogBody("bootstrap", "{}", [row]) === null).toBe(true);
});


test("duplicate CLI surfaces share the row expansion limit", () => {
  const body = { model_selector_config: Array.from({ length: 3 }, () => ({ id: "cc", models: [{
    id: "claude-native", metadata: "x".repeat(32 * 1024),
  }] })) };
  const aliases = Array.from({ length: 32 }, (_, i) => ({ id: `claude-alias-${i}`, name: `Route ${i}` }));
  expect(rewriteCliCatalogBody("model_selector", JSON.stringify(body), aliases) === null).toBe(true);
});
