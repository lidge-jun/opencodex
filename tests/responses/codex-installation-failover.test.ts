import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import type { OcxConfig } from "../../src/types";

const key = "x-codex-installation-id";
const original = "11111111-1111-4111-8111-111111111111";
const realFetch = globalThis.fetch;
const homeKeys = ["OPENCODEX_HOME", "CODEX_HOME"] as const;
let home: string;
let previous: Array<string | undefined>;
let release: () => void;
function clear() {
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); clearPoolRecoveryState();
  for (const id of ["work", "other"]) clearAccountNeedsReauth(id);
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-installation-failover-"));
  previous = homeKeys.map(name => process.env[name]);
  for (const name of homeKeys) process.env[name] = home;
  release = acquireOwnedSpendHome(); clear();
  for (const id of ["work", "other"]) setAccountQuotaFromParsed(id, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(["work", "other"].map(id => [id, {
    credential: { accessToken: `${id}-access`, refreshToken: `${id}-grant`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `acc-${id}` },
    generation: 1, refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
  }]))));
});
afterEach(async () => {
  globalThis.fetch = realFetch; release(); clear();
  await drainAndRemoveFixtureRoots({ roots: [{ path: home }], restoreEnvironment: () => {
    homeKeys.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  } });
});
const config = (): OcxConfig => ({ port: 0, defaultProvider: "openai", activeCodexAccountId: "work", autoSwitchThreshold: 0,
  accountPoolStrategy: "round-robin", codexAccounts: ["work", "other"].map(id => ({ id, label: id })),
  providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false } },
} as OcxConfig);
async function send(compact: boolean) {
  const req = new Request(`http://localhost/v1/responses${compact ? "/compact" : ""}`, { method: "POST",
    headers: { "content-type": "application/json", [key]: original },
    body: JSON.stringify({ model: "gpt-5.5", input: [], stream: false, client_metadata: { [key]: "different-body-id" } }),
  });
  const handler = compact ? handleResponsesCompact : handleResponses;
  const response = await handler(req, config(), { model: "", provider: "" });
  await response.text();
  return response;
}
for (const compact of [false, true]) for (const status of [401, 429]) test(`${compact ? "compact" : "Responses"} ${status === 401 ? "401 refresh preserves identity" : "429 A->B changes identity"} on both wire surfaces`, async () => {
  const sends: Array<{ headers: Headers; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("auth.openai.com")) return Response.json({ access_token: "work-refreshed", refresh_token: "work-rotated", expires_in: 3600 });
    if (!url.endsWith("/responses") && !url.endsWith("/responses/compact")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    const headers = new Headers(init?.headers);
    sends.push({ headers, body: JSON.parse(String(init?.body)) });
    const rejection = status;
    return headers.get("authorization") === "Bearer work-access"
      ? Response.json({ error: { message: rejection === 401 ? "rejected bearer" : "You have hit your usage limit." } }, { status: rejection, headers: { "retry-after": "600" } })
      : Response.json({ id: "resp_done", object: compact ? "response.compaction" : "response", status: "completed", output: [] });
  }) as typeof fetch;
  expect((await send(compact)).status).toBe(200);
  expect(sends.map(item => item.headers.get("chatgpt-account-id"))).toEqual(status === 401 ? ["acc-work", "acc-work"] : ["acc-work", "acc-other"]);
  for (const item of sends) {
    expect(item.headers.get(key)).not.toBe(original);
    expect(item.body.client_metadata[key]).toBe(item.headers.get(key));
  }
  if (status === 429) expect(sends[0]!.headers.get(key)).not.toBe(sends.at(-1)!.headers.get(key));
  if (status === 401) expect(sends[0]!.headers.get(key)).toBe(sends[1]!.headers.get(key));
});
for (const compact of [false, true]) test(`${compact ? "compact" : "Responses"} corrupt secret refuses before sending`, async () => {
  writeFileSync(join(home, "codex-installation-secret"), "invalid", { mode: 0o600 });
  let sends = 0;
  globalThis.fetch = (async () => { sends++; throw new Error("unexpected send"); }) as typeof fetch;
  expect((await send(compact)).status).toBe(503);
  expect(sends).toBe(0);
});

test("Responses secret failure during A->B refuses instead of throwing or sending B", async () => {
  let sends = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    sends++;
    writeFileSync(join(home, "codex-installation-secret"), "corrupt", { mode: 0o600 });
    return Response.json({ error: { message: "You have hit your usage limit." } }, { status: 429, headers: { "retry-after": "600" } });
  }) as typeof fetch;
  expect((await send(false)).status).toBe(503);
  expect(sends).toBe(1);
});

for (const surface of ["search", "images", "live"] as const) test(`${surface} maps installation-secret refusal before upstream`, async () => {
  writeFileSync(join(home, "codex-installation-secret"), "corrupt", { mode: 0o600 });
  let sends = 0;
  globalThis.fetch = (async () => { sends++; throw new Error("unexpected send"); }) as typeof fetch;
  const req = new Request(`http://localhost/v1/${surface}`, { method: "POST", headers: { "content-type": "application/json", [key]: original }, body: JSON.stringify(surface === "search" ? { query: "test" } : surface === "images" ? { model: "gpt-image-1", prompt: "test" } : { model: "gpt-realtime", sdp: "v=0" }) });
  const cfg = config();
  const log = { model: "", provider: "" };
  const response = surface === "search" ? await (await import("../../src/server/search")).handleSearch(req, cfg, log)
    : surface === "images" ? await (await import("../../src/server/images")).handleImages(req, cfg, "generations", log)
    : await (await import("../../src/server/live")).handleLive(req, cfg, log);
  expect(response.status).toBe(503);
  expect(sends).toBe(0);
});

test("optional Responses helper disables itself on installation-secret refusal", async () => {
  writeFileSync(join(home, "codex-installation-secret"), "corrupt", { mode: 0o600 });
  const { prepareResponsesSidecarAuth } = await import("../../src/server/responses/request-sidecar-auth");
  const { createTestTranslatorBudget } = await import("../helpers/translator-budget");
  const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "test-key" };
  const req = new Request("http://localhost/v1/responses", { headers: { [key]: original } });
  const result = await prepareResponsesSidecarAuth({ req, config: config(), options: {} }, {
    parsed: { modelId: "gpt-5.5", stream: false, context: { messages: [] }, options: {}, _webSearch: true },
    route: { provider, providerName: "other", modelId: "gpt-5.5" }, selectedForwardHeaders: req.headers, translatorBudget: createTestTranslatorBudget(),
  } as any, { adapter: { name: "openai-chat" }, isPassthrough: false } as any);
  expect(result.openAiSidecar).toBeUndefined();
});

test("compact secret failure during A->B returns identity-unavailable 503", async () => {
  let sends = 0;
  globalThis.fetch = (async input => {
    if (!String(input).endsWith("/responses/compact")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    sends++;
    writeFileSync(join(home, "codex-installation-secret"), "corrupt", { mode: 0o600 });
    return Response.json({ error: { message: "You have hit your usage limit." } }, { status: 429, headers: { "retry-after": "600" } });
  }) as typeof fetch;
  expect((await send(true)).status).toBe(503);
  expect(sends).toBe(1);
});

test("physical WS A->B upgrades and response.create frames use each selected identity", async () => {
  const realWebSocket = globalThis.WebSocket;
  const { codexWsPool } = await import("../../src/server/responses/codex-ws-pool");
  const sockets: Array<{ headers: Headers; frames: string[] }> = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    headers: Headers;
    frames: string[] = [];
    listeners = new Map<string, Array<(event: any) => void>>();
    constructor(_url: string, options: { headers: HeadersInit }) {
      this.headers = new Headers(options.headers); sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
    }
    addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    removeEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
    emit(type: string, event: any) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    send(text: string) {
      this.frames.push(text);
      queueMicrotask(() => {
        const frame = (body: unknown) => this.emit("message", { data: JSON.stringify(body) });
        if (this.headers.get("chatgpt-account-id") === "acc-work") {
          frame({ type: "error", status: 429, error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "You have hit your usage limit." } });
        } else {
          frame({ type: "response.created", response: { id: "resp_ws_b", status: "in_progress", output: [] } });
          frame({ type: "response.completed", response: { id: "resp_ws_b", status: "completed", output: [] } });
        }
      });
    }
    close() { this.readyState = 3; this.emit("close", {}); }
  }
  codexWsPool.dispose();
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async input => {
    if (String(input).endsWith("/responses")) throw new Error("unexpected HTTP fallback");
    return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
  }) as typeof fetch;
  try {
    const cfg = config(); delete cfg.providers.openai!.upstreamWebsocket;
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", [key]: original }, body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true, store: false, client_metadata: { [key]: "body-id" } }) });
    const response = await handleResponses(req, cfg, { model: "", provider: "" }, { codexWsRuntimeIdentity: "1.4.0" });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("resp_ws_b");
    expect(sockets.map(socket => socket.headers.get("chatgpt-account-id"))).toEqual(["acc-work", "acc-other"]);
    for (const socket of sockets) {
      expect(socket.frames).toHaveLength(1);
      expect(JSON.parse(socket.frames[0]!).client_metadata[key]).toBe(socket.headers.get(key));
      expect(socket.headers.get(key)).not.toBe(original);
    }
    expect(sockets[0]!.headers.get(key)).not.toBe(sockets[1]!.headers.get(key));
  } finally { codexWsPool.dispose(); globalThis.WebSocket = realWebSocket; }
});

test("identity failure after auth preparation and before adapter build returns 503", async () => {
  let sends = 0;
  globalThis.fetch = (async () => { sends++; throw new Error("unexpected send"); }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", [key]: original }, body: JSON.stringify({ model: "gpt-5.5", input: [], client_metadata: { [key]: "body-id" } }) });
  const response = await handleResponses(req, config(), { model: "", provider: "" }, {
    onCompactionRecoveryRoute: () => { writeFileSync(join(home, "codex-installation-secret"), "corrupt", { mode: 0o600 }); },
  });
  expect(response.status).toBe(503);
  expect(sends).toBe(0);
});

test("portable compaction maps a late generic adapter identity failure to 503", async () => {
  const cfg = config();
  cfg.providers.gateway = { adapter: "openai-responses", authMode: "key", baseUrl: "https://gateway.example/v1", apiKey: "fixture-key" };
  cfg.compactionRouting = { model: "gpt-5.5", reasoningEffort: "low" };
  let sends = 0;
  globalThis.fetch = (async () => { sends++; throw new Error("unexpected send"); }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", [key]: original, "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }) }, body: JSON.stringify({ model: "gateway/normal", stream: false, input: [{ role: "user", content: "keep state" }, { type: "compaction_trigger" }], client_metadata: { [key]: "body-id" } }) });
  const response = await handleResponses(req, cfg, { model: "", provider: "" }, { onCompactionRecoveryRoute: () => { writeFileSync(join(home, "codex-installation-secret"), "corrupt", { mode: 0o600 }); } });
  expect(response.status).toBe(503);
  expect(sends).toBe(0);
});
