import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [opencodexHome, codexHome, capturePath] = Bun.argv.slice(2);
if (!opencodexHome || !codexHome || !capturePath) {
  throw new Error("runtime child requires opencodex home, codex home, and capture path");
}

for (const key of Object.keys(process.env)) {
  if (/^(?:OPENAI_|CODEX_|OPENCODEX_)/.test(key) || /^(?:http|https|all)_proxy$/i.test(key)) {
    delete process.env[key];
  }
}
process.env.OPENCODEX_HOME = opencodexHome;
process.env.CODEX_HOME = codexHome;
process.env.OPENCODEX_API_AUTH_TOKEN = "fixture-admission";
process.env.NO_PROXY = "127.0.0.1,localhost,::1";
process.env.no_proxy = "127.0.0.1,localhost,::1";
mkdirSync(opencodexHome, { recursive: true, mode: 0o700 });
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
const authPath = join(codexHome, "auth.json");
const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = [
  jwtPart({ alg: "none", typ: "JWT" }),
  jwtPart({
    sub: "fixture-user",
    email: "runtime@example.test",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    chatgpt_account_id: "fixture-codex-account",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "fixture-codex-account",
      chatgpt_plan_type: "pro",
    },
  }),
  "fixture-signature",
].join(".");
writeFileSync(authPath, JSON.stringify({
  tokens: {
    id_token: idToken,
    access_token: "fixture-codex-access",
    refresh_token: "fixture-refresh-token",
    account_id: "fixture-codex-account",
  },
  last_refresh: new Date().toISOString(),
}) + "\n", { mode: 0o600 });
chmodSync(authPath, 0o600);
const codexConfigPath = join(codexHome, "config.toml");
writeFileSync(codexConfigPath, "", { mode: 0o600 });
chmodSync(codexConfigPath, 0o600);

function atomicCapture(value: unknown): void {
  const temp = `${capturePath}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, capturePath);
}

const captures: Array<Record<string, unknown>> = [];

function lifecycle(body: Record<string, unknown>): string {
  const item = {
    id: "msg_runtime_fixture",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "OCX_PROBE_OK", annotations: [] }],
  };
  const response = {
    id: "resp_runtime_fixture",
    object: "response",
    status: "completed",
    model: body.model,
    output: [item],
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  };
  const frames = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OCX_PROBE_OK" },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "OCX_PROBE_OK" },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

const savedFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init);
  if (request.method === "GET" && request.url === "https://chatgpt.com/backend-api/wham/usage") {
    const authorization = request.headers.get("authorization");
    const isPool = authorization === "Bearer fixture-pool-access";
    return Response.json({
      email: isPool ? "pool.fixture@example.test" : "runtime@example.test",
      plan_type: "pro",
      rate_limit: {
        secondary_window: {
          used_percent: isPool ? 23 : 11,
          reset_at: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        },
      },
      rate_limit_reset_credits: { available_count: isPool ? 1 : 2 },
    });
  }
  if (request.method !== "POST" || ![
    "https://chatgpt.com/backend-api/codex/responses",
    "https://api.openai.com/v1/responses",
  ].includes(request.url)) {
    throw new Error(`runtime child blocked unexpected request: ${request.method} ${request.url}`);
  }
  const body = await request.clone().json() as Record<string, unknown>;
  const authorization = request.headers.get("authorization");
  captures.push({
    upstream: request.url.startsWith("https://api.openai.com/") ? "api.openai.com/v1" : "chatgpt.com/backend-api/codex",
    model: body.model,
    reasoningMode: body.reasoning && typeof body.reasoning === "object"
      ? (body.reasoning as { mode?: unknown }).mode ?? null
      : null,
    credentialOwner: authorization === "Bearer fixture-api-key"
      ? "openai-apikey"
      : authorization === "Bearer fixture-pool-access"
        ? "openai-pool-added"
        : authorization === "Bearer fixture-codex-access"
          ? "openai-pool-main"
          : authorization === "Bearer fixture-direct-caller"
            ? "openai-direct-main"
            : "unexpected",
    accountOwner: request.headers.get("chatgpt-account-id") ?? null,
  });
  atomicCapture(captures);
  return new Response(lifecycle(body), { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

let server: { url: URL; stop(closeActiveConnections?: boolean): Promise<void> } | null = null;
let stopping = false;

try {
  const [
    { saveConfig },
    { providerConfigSeed },
    { PROVIDER_REGISTRY },
    { startServer },
    { syncModelsToCodex },
    { readRootTomlString },
    { saveCodexAccountCredential },
    { updateAccountQuota },
  ] = await Promise.all([
    import("../src/config"),
    import("../src/providers/derive"),
    import("../src/providers/registry"),
    import("../src/server"),
    import("../src/codex/sync"),
    import("../src/codex/paths"),
    import("../src/codex/account-store"),
    import("../src/codex/auth-api"),
  ]);

  const seed = (id: string) => providerConfigSeed(PROVIDER_REGISTRY.find(entry => entry.id === id)!);
  const api = seed("openai-apikey");
  api.apiKey = "fixture-api-key";
  api.liveModels = false;
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2 as const,
    providers: {
      openai: seed("openai"),
      "openai-apikey": api,
    },
    codexAccounts: [{
      id: "fixture-pool",
      email: "pool.fixture@example.test",
      plan: "pro",
      chatgptAccountId: "fixture-pool-account",
      isMain: false,
    }],
    activeCodexAccountId: "fixture-pool",
    autoSwitchThreshold: 80,
  };
  saveCodexAccountCredential("fixture-pool", {
    accessToken: "fixture-pool-access",
    refreshToken: "fixture-pool-refresh",
    expiresAt: Date.now() + 60 * 60_000,
    chatgptAccountId: "fixture-pool-account",
  });
  updateAccountQuota("fixture-pool", 23, Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
  saveConfig(config);

  server = startServer(0);
  const port = Number(new URL(server.url).port);
  const sync = await syncModelsToCodex(port, config, null);
  if (!sync.ok || !sync.catalogPath) throw new Error(`runtime catalog sync failed: ${sync.message}`);
  const catalog = JSON.parse(readFileSync(sync.catalogPath, "utf8")) as { models?: Array<{ slug?: string }> };
  if (!catalog.models?.some(model => model.slug === "gpt-5.6-sol")) {
    throw new Error("runtime catalog is missing bare gpt-5.6-sol");
  }
  if (!catalog.models?.some(model => model.slug === "openai-apikey/gpt-5.6-sol-pro")) {
    throw new Error("runtime catalog is missing openai-apikey/gpt-5.6-sol-pro");
  }
  if (catalog.models.some(model => model.slug?.startsWith("openai-multi/"))) {
    throw new Error("runtime catalog unexpectedly exposes the legacy Multi namespace");
  }
  const injected = readFileSync(codexConfigPath, "utf8");
  if (readRootTomlString(injected, "openai_base_url") !== `http://127.0.0.1:${port}/v1`) {
    throw new Error("runtime Codex injection does not reference the active proxy port");
  }
  if (readRootTomlString(injected, "model_catalog_json") !== sync.catalogPath) {
    throw new Error("runtime Codex injection does not reference the generated catalog");
  }
  const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid, port, version, catalogReady: true }) + "\n");

  await new Promise<void>(resolve => {
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      if (server) await server.stop(true);
      resolve();
    };
    process.once("SIGTERM", () => { void stop(); });
    process.once("SIGINT", () => { void stop(); });
  });
} finally {
  globalThis.fetch = savedFetch;
  if (server && !stopping) await server.stop(true).catch(() => undefined);
}
