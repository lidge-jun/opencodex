import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { OcxComboTarget, OcxProviderConfig } from "../src/types";

const root = join(import.meta.dir, "..");
const ports = { dashboard: 15173, proxy: 18601, upstream: 18602 };
const loopback = "127.0.0.1";
const upstreamUrl = `http://${loopback}:${ports.upstream}`;
const proxyUrl = `http://${loopback}:${ports.proxy}`;
const ids = ["openai", "openai-apikey", "anthropic", "anthropic-apikey"] as const;
type ProviderId = typeof ids[number];
const fixtureProvider = (id: ProviderId) => `fixture-${id}`;
const modelFor = (id: ProviderId) => id.startsWith("anthropic") ? "claude-fixture" : "gpt-fixture";
type Scenario = "success" | "subscription-exhausted" | "switch-provider" | "last-key" | "all-exhausted" | "transient";
const SCENARIOS = new Set<Scenario>(["success", "subscription-exhausted", "switch-provider", "last-key", "all-exhausted", "transient"]);

function fixtureEnvironment(home: string): Record<string, string> {
  return {
    HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home,
    CODEX_HOME: join(home, "codex"), OPENCODEX_HOME: join(home, "opencodex"),
    PATH: process.platform === "win32" ? dirname(process.execPath) : `${dirname(process.execPath)}:/usr/bin:/bin`,
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    OCX_DISABLE_UPDATE_CHECK: "1",
  };
}

async function supervise(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "ocx-fallback-"));
  const env = fixtureEnvironment(home);
  const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--isolated", home], {
    cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const interrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try { return await child.exited; }
  finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    rmSync(home, { recursive: true, force: true });
  }
}

function successfulCompletion(id: ProviderId, stream: boolean): Response {
  const model = modelFor(id);
  const reply = "Fallback fixture completed.";
  if (id.startsWith("anthropic")) {
    const message = {
      id: "msg_fixture", type: "message", role: "assistant", model,
      content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    if (!stream) return Response.json(message);
    return sse([
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ], true);
  }
  const completion = { id: "chatcmpl-fixture", model, created: 1 };
  if (!stream) return Response.json({
    ...completion, object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  return sse([
    { ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
    { ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ], false);
}

function sse(events: Array<Record<string, unknown>>, named: boolean): Response {
  const data = events.map(event => (named ? `event: ${event.type}\n` : "") + `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(data + (named ? "" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } });
}

function exhausted(id: ProviderId): Response {
  if (id === "anthropic-apikey") return Response.json({
    type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
  }, { status: 400, headers: { "Retry-After": "1" } });
  if (id === "anthropic") return Response.json({
    type: "error", error: { type: "rate_limit_error", message: "Your weekly usage quota is exhausted" },
  }, { status: 429, headers: { "Retry-After": "1" } });
  return Response.json({
    error: { code: id === "openai" ? "usage_limit_reached" : "insufficient_quota", message: "Your account quota is exhausted" },
  }, { status: 429, headers: { "Retry-After": "1" } });
}

async function runFixture(home: string): Promise<void> {
  if (!basename(home).startsWith("ocx-fallback-")) throw new Error("Run the fixture without --isolated.");
  const safeEnv = fixtureEnvironment(home);
  for (const name of ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const) {
    if (!home || safeEnv[name] !== process.env[name]) throw new Error("Run the fixture without --isolated.");
    mkdirSync(safeEnv[name], { recursive: true, mode: 0o700 });
  }
  // Compose the real server after the disposable process environment is in effect.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol !== "http:" || url.hostname !== loopback
      || ![ports.upstream, ports.proxy, ports.dashboard].some(port => url.port === String(port))) {
      throw new Error("The fallback fixture only permits its three loopback endpoints.");
    }
    return originalFetch(input, { ...init, redirect: "error" });
  }, { preconnect: () => {} });
  const [{ startServer }, { saveConfig }, { clearComboTargetCooldowns }] = await Promise.all([
    import("../src/server/index"), import("../src/config"), import("../src/combos/failover"),
  ]);
  let scenario: Scenario = "success";
  let first: ProviderId = "openai";
  let attempts: ProviderId[] = [];
  const mock = Bun.serve({
    hostname: loopback, port: ports.upstream,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return Response.json({ fixture: "opencodex-fallback", proxyPort: ports.proxy });
      if (path === "/attempts" && req.method === "GET") return Response.json(attempts);
      if (path === "/scenario" && req.method === "POST") {
        const next = await req.json().catch(() => null);
        if (!SCENARIOS.has(next?.scenario) || !["openai", "anthropic"].includes(next?.first)) {
          return new Response("Invalid scenario", { status: 400 });
        }
        scenario = next.scenario;
        first = next.first;
        attempts = [];
        clearComboTargetCooldowns();
        return new Response(null, { status: 204 });
      }
      const id = ids.find(candidate => path.startsWith(`/${candidate}/v1/`));
      if (!id) return new Response(null, { status: 404 });
      if (path.endsWith("/models")) return Response.json({ object: "list", data: [{ id: modelFor(id), type: "model" }] });
      if (req.method !== "POST" || !/\/(?:chat\/completions|messages)$/.test(path)) return new Response(null, { status: 404 });
      const body = await req.json().catch(() => null);
      if (body?.model !== modelFor(id)) return new Response("Unexpected fixture model", { status: 400 });
      attempts.push(id);
      await Bun.sleep(35);
      if (scenario === "transient" && id === first) return Response.json({
        type: "error", error: { code: "rate_limit_exceeded", type: "rate_limit_error", message: "Requests per minute limit reached" },
      }, { status: 429, headers: { "Retry-After": "1" } });
      const last = first === "openai" ? "anthropic-apikey" : "openai-apikey";
      if (scenario === "all-exhausted" || (scenario === "last-key" && id !== last) || (scenario === "subscription-exhausted" && id === first)
        || (scenario === "switch-provider" && (id === first || id === `${first}-apikey`))) return exhausted(id);
      return successfulCompletion(id, body.stream === true);
    },
  });
  let proxy: ReturnType<typeof startServer> | undefined;
  let vite: ReturnType<typeof Bun.spawn> | undefined;
  let stop: () => void = () => {};
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const providers = Object.fromEntries(ids.map(id => [fixtureProvider(id), {
      alias: id,
      adapter: id.startsWith("anthropic") ? "anthropic" : "openai-chat",
      baseUrl: `${upstreamUrl}/${id}/v1`, allowPrivateNetwork: true,
      authMode: id.endsWith("-apikey") ? "key" : "local",
      apiKey: "dev-fixture-key", defaultModel: modelFor(id), models: [modelFor(id)],
    } satisfies OcxProviderConfig]));
    const targets: OcxComboTarget[] = ids.map(id => ({
      provider: fixtureProvider(id), model: modelFor(id), metered: id.endsWith("-apikey"),
    }));
    saveConfig({
      port: ports.proxy, hostname: loopback, defaultProvider: fixtureProvider("openai"), providers,
      clientIntegrations: { codex: false, grok: false, "claude-desktop": false }, desktopCompatibility: { startOnProxyStart: false },
      claudeCode: { intercept: { enabled: false } }, telemetry: { decision: "declined" },
      combos: { baseline: { strategy: "failover", allowMeteredTargets: true, targets } },
    });
    proxy = startServer(ports.proxy, {
      inspectNativeCodexOwnership: () => ({ ownership: "foreign", reason: "Disposable fixture without native credentials" }),
      packageTreeServiceChild: () => false,
      packageTreeLauncherTarget: null,
      acceptSystemRestart: () => { throw new Error("System restart is disabled for this fixture."); },
    });
    vite = Bun.spawn([process.execPath, "--no-env-file", "run", "dev", "--host", loopback, "--port", String(ports.dashboard), "--strictPort"], {
      cwd: join(root, "gui"), env: { ...safeEnv, OPENCODEX_PROXY_TARGET: proxyUrl }, stdout: "inherit", stderr: "inherit",
    });
    console.log(`Open the isolated dashboard at http://${loopback}:${ports.dashboard}/#models/combos`);
    const exitCode = await Promise.race([vite.exited, stopped.then(() => undefined)]);
    if (exitCode !== undefined && exitCode !== 0) throw new Error(`Fixture dashboard exited with status ${exitCode}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (vite && vite.exitCode === null) { vite.kill("SIGTERM"); await vite.exited; }
    try { await proxy?.stop(true); } finally { await mock.stop(true); }
  }
}

if (process.argv[2] === "--isolated") await runFixture(process.argv[3] ?? "");
else process.exitCode = await supervise();
