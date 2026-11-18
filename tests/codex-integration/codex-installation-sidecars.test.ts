import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as authContextModule from "../../src/codex/auth-context";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, resetCodexRoutingForManualSelection } from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { handleImages } from "../../src/server/images";
import { handleLive } from "../../src/server/live";
import { handleSearch } from "../../src/server/search";
import * as requestBodyModule from "../../src/server/request-decompress";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const install = "x-codex-installation-id";
const turn = "x-codex-turn-metadata";
const attest = "x-oai-attestation";
const callerId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const callerTurn = JSON.stringify({ installation_id: callerId, keep: "turn-field" });
const callerToken = fakeChatGptJwt({ chatgpt_account_id: "caller-account" });
const storedMainToken = fakeChatGptJwt({ exp: 4_000_000_000, chatgpt_account_id: "stored-main-account" });
const originalFetch = globalThis.fetch;
const originalAdmission = process.env.OPENCODEX_API_AUTH_TOKEN;
let home: TempHome;
let sent: Array<{ url: string; headers: Headers; body: Record<string, any>; redirect?: RequestRedirect }>;

type AuthKind = "main" | "pool" | "main-pool";
function config(kind: AuthKind, defaults: boolean, account = "sidecar-a"): OcxConfig {
  const selected = kind === "main-pool" ? MAIN_CODEX_ACCOUNT_ID : account;
  return {
    port: 0, defaultProvider: "openai", openaiProviderTierVersion: 2,
    codexMainAccountHardLock: false, autoSwitchThreshold: 0,
    providers: { openai: {
      adapter: "openai-responses", authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      codexAccountMode: kind === "main" ? "direct" : "pool",
      headers: defaults ? {
        "X-Codex-Installation-Id": "static-installation",
        "X-Codex-Turn-Metadata": '{"installation_id":"static-turn"}',
        "X-Oai-Attestation": "static-attestation", "X-Static-Keep": "static-kept",
      } : {},
    } },
    codexAccounts: ["sidecar-a", "sidecar-b"].map(id => ({ id, email: `${id}@example.test`, plan: "team", isMain: false })),
    activeCodexAccountId: selected, activeCodexAccountPinned: selected, accountPoolStrategy: "fill-first",
  } as OcxConfig;
}

beforeAll(async () => {
  home = createTempHome("ocx-installation-sidecars-");
  mkdirSync(home.codexHome, { recursive: true });
  writeFileSync(home.path(".codex", "auth.json"), JSON.stringify({
    tokens: { access_token: storedMainToken, account_id: "stored-main-account" },
  }));
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  saveConfig(config("pool", false));
  for (const id of ["sidecar-a", "sidecar-b"]) {
    saveCodexAccountCredential(id, {
      accessToken: `${id}-fixture-token`, refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 3_600_000, chatgptAccountId: `canonical-${id}`,
    });
  }
  await flushConfigDirHardeningAndReaps(home.root);
});

beforeEach(() => {
  clearCodexUpstreamHealth(); clearThreadAccountMap(); clearAccountQuota();
  for (const id of ["sidecar-a", "sidecar-b", MAIN_CODEX_ACCOUNT_ID]) {
    clearAccountNeedsReauth(id);
    setAccountQuotaFromParsed(id, { weeklyPercent: 10, weeklyResetAt: Date.now() / 1000 + 3_600 });
  }
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://chatgpt.com/backend-api/codex/")) throw new Error("unexpected sidecar fixture send");
    const text = await new Response(init?.body).text();
    sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(text), redirect: init?.redirect });
    return Response.json({ ok: true });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(async () => {
  globalThis.fetch = originalFetch;
  clearCodexUpstreamHealth(); clearThreadAccountMap(); clearAccountQuota();
  await flushConfigDirHardeningAndReaps(home.root);
  home.remove();
  if (originalAdmission === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = originalAdmission;
});

// Independent oracle from persisted secret bytes, using the documented domain and UUID layout.
function expectedIdentity(account: string): string {
  const secret = readFileSync(home.path("codex-installation-secret"));
  const bytes = createHmac("sha256", secret).update(`opencodex-codex-installation-id-v1\0canonical-${account}`).digest();
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

const surfaces = ["search", "generations", "edits", "live-json", "live-multipart"] as const;
type Surface = typeof surfaces[number];
async function call(surface: Surface, selected: OcxConfig, headerPresent: boolean, bodyPresent: boolean, expectedStatus = 200) {
  resetCodexRoutingForManualSelection(selected.activeCodexAccountId!);
  const metadata = Object.freeze({ keep: "metadata-field", ...(bodyPresent ? { [install]: callerId, [turn]: callerTurn } : {}) });
  const session = Object.freeze({ model: "gpt-realtime", client_metadata: metadata });
  const raw = Object.freeze({ model: "gpt-5", query: "fixture", prompt: "fixture", sdp: "fixture-sdp", session, client_metadata: metadata });
  const original = JSON.stringify(raw);
  const headers = new Headers({ authorization: `Bearer ${callerToken}`, "chatgpt-account-id": "caller-account" });
  if (selected.activeCodexAccountId === MAIN_CODEX_ACCOUNT_ID) headers.delete("authorization");
  if (headerPresent) { headers.set(install, callerId); headers.set(turn, callerTurn); headers.set(attest, "caller-attestation"); }
  const path = surface === "search" ? "alpha/search" : surface.startsWith("live-") ? "realtime/calls" : `images/${surface}`;
  let requestBody: BodyInit = original;
  if (surface === "live-multipart") {
    const form = new FormData(); form.set("sdp", raw.sdp); form.set("session", JSON.stringify(session));
    requestBody = form;
  } else headers.set("content-type", "application/json");
  const req = new Request(`http://127.0.0.1/v1/${path}`, { method: "POST", headers, body: requestBody });
  const copy = req.clone();
  const log = { model: "", provider: "" };
  const decode = requestBodyModule.readJsonRequestBody;
  let parsedInput: unknown;
  const hook = surface.startsWith("live-") ? undefined
    : spyOn(requestBodyModule, "readJsonRequestBody").mockImplementation(async (...args) => {
      parsedInput = await decode(...args);
      Object.freeze((parsedInput as { client_metadata: object }).client_metadata);
      Object.freeze(parsedInput);
      return parsedInput;
    });
  let response: Response;
  try {
    response = surface === "search" ? await handleSearch(req, selected, log)
      : surface === "generations" || surface === "edits" ? await handleImages(req, selected, surface, log)
      : await handleLive(req, selected, log);
  } finally { hook?.mockRestore(); }
  expect(response.status).toBe(expectedStatus);
  expect(JSON.stringify(raw)).toBe(original);
  if (parsedInput !== undefined) expect(JSON.stringify(parsedInput)).toBe(original);
  if (surface === "live-multipart") expect((await copy.formData()).get("session")).toBe(JSON.stringify(session));
  else expect(await copy.text()).toBe(original);
  return response;
}

for (const surface of surfaces) for (const kind of ["main", "pool", "main-pool"] as const)
for (const defaults of [false, true]) for (const headerPresent of [false, true]) for (const bodyPresent of [false, true]) {
  test(`${surface} ${kind} defaults=${defaults} header=${headerPresent} body=${bodyPresent}`, async () => {
    await call(surface, config(kind, defaults), headerPresent, bodyPresent);
    expect(sent).toHaveLength(1);
    const wire = sent[0]!;
    const meta = surface === "live-multipart" ? wire.body.session.client_metadata : wire.body.client_metadata;
    expect(Object.hasOwn(meta, install)).toBe(bodyPresent);
    expect(Object.hasOwn(meta, turn)).toBe(bodyPresent);
    if (bodyPresent) {
      if (kind === "pool") expect(meta[install]).not.toBe(callerId);
      const expected = kind === "pool" ? expectedIdentity("sidecar-a") : callerId;
      expect(meta[install]).toBe(expected);
      expect(JSON.parse(meta[turn])).toEqual({ installation_id: expected, keep: "turn-field" });
      if (surface === "live-json") expect(wire.body.session.client_metadata).toEqual(meta);
    }
    expect(meta.keep).toBe("metadata-field");
    expect(wire.headers.has(install)).toBe(headerPresent);
    expect(wire.headers.has(turn)).toBe(headerPresent);
    if (headerPresent) {
      const expected = kind === "pool" ? expectedIdentity("sidecar-a") : callerId;
      expect(wire.headers.get(install)).toBe(expected);
      expect(JSON.parse(wire.headers.get(turn)!)).toEqual({ installation_id: expected, keep: "turn-field" });
    }
    expect(wire.headers.get(attest)).toBe(kind === "main" && headerPresent ? "caller-attestation" : null);
    expect(wire.headers.get("x-static-keep")).toBe(defaults ? "static-kept" : null);
    expect(wire.headers.get("authorization")).toBe(kind === "pool" ? "Bearer sidecar-a-fixture-token"
      : kind === "main-pool" ? `Bearer ${storedMainToken}` : `Bearer ${callerToken}`);
    expect(wire.headers.get("chatgpt-account-id")).toBe(kind === "pool" ? "canonical-sidecar-a"
      : kind === "main-pool" ? "stored-main-account" : "caller-account");
    expect(wire.redirect).toBe("manual");
  });
}

for (const surface of surfaces) test(`${surface} physical sends follow canonical Pool account A then B`, async () => {
  for (const account of ["sidecar-a", "sidecar-b"]) {
    clearThreadAccountMap();
    await call(surface, config("pool", true, account), true, true);
  }
  expect(sent).toHaveLength(2);
  const ids = sent.map(wire => wire.headers.get(install));
  expect(ids[0]).not.toBe(ids[1]);
  for (const [index, wire] of sent.entries()) {
    const account = index === 0 ? "sidecar-a" : "sidecar-b";
    const meta = surface === "live-multipart" ? wire.body.session.client_metadata : wire.body.client_metadata;
    expect(meta[install]).toBe(expectedIdentity(account));
    expect(meta[install]).toBe(ids[index]);
    expect(wire.headers.get("chatgpt-account-id")).toBe(`canonical-${account}`);
  }
});

for (const surface of surfaces) test(`${surface} late identity failure returns 503 without a physical send`, async () => {
  const materialize = authContextModule.headersForCodexAuthContext;
  let originalSecret: Buffer | undefined;
  let materialized = 0;
  const hook = spyOn(authContextModule, "headersForCodexAuthContext").mockImplementation((...args) => {
    const headers = materialize(...args);
    materialized++;
    expect(headers.get(install)).not.toBe(callerId);
    originalSecret = readFileSync(home.path("codex-installation-secret"));
    writeFileSync(home.path("codex-installation-secret"), Buffer.from([0]));
    return headers;
  });
  try {
    const response = await call(surface, config("pool", true), true, true, 503);
    expect(materialized).toBe(1);
    expect(sent).toHaveLength(0);
    expect(await response.json()).toEqual({ error: {
      type: "server_error", code: "server_is_overloaded", message: "Codex installation identity unavailable",
    } });
  } finally {
    hook.mockRestore();
    if (originalSecret) writeFileSync(home.path("codex-installation-secret"), originalSecret);
  }
});
