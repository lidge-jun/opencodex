import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import * as oauth from "../../src/oauth";
import { getAccountSet, saveAccountCredential, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { clearPoolRotationState } from "../../src/oauth/pool-kernel";
import { clearAntigravityAccountRosters, recordAntigravityAccountRoster } from "../../src/providers/antigravity-account-roster";
import { rotateGenericOAuthAccountOn429 } from "../../src/oauth/generic-account-failover";
import { subscribeAccountSelections } from "../../src/lib/account-selection-events";
import { encodeMessage } from "../../src/lib/eventstream-decoder";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as pacing from "../../src/providers/request-pacing";
import * as retry from "../../src/lib/upstream-retry";

const provider = "google-antigravity";
const origin = "https://daily-cloudcode-pa.googleapis.com";
let home: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let release: () => void;
let originalFetch: typeof fetch;
let sleep: ReturnType<typeof spyOn>;
let cfg: OcxConfig;
let accounts: Array<{ id: string; auth: string; project: string }>;
let seen: Array<{ auth: string; project: string }>;
let refreshCount: number;
let refuse: ((auth: string) => Response | undefined) | undefined;

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-generic-affinity-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-affinity-codex-");
  release = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
  clearPoolRotationState();
  originalFetch = globalThis.fetch;
  sleep = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
  for (const slot of ["one", "two", "three"]) {
    await saveCredential(provider, { access: `synthetic-${slot}`, refresh: `synthetic-refresh-${slot}`,
      expires: Date.now() + 3_600_000, accountId: `synthetic-${slot}`, projectId: `synthetic-project-${slot}` });
  }
  accounts = getAccountSet(provider)!.accounts.map(row => ({ id: row.id,
    auth: `Bearer ${row.credential.access}`, project: row.credential.projectId! }));
  await setActiveAccount(provider, accounts[0]!.id);
  cfg = { defaultProvider: provider, pool: { kernel: true }, providers: { [provider]: {
    adapter: "google", authMode: "oauth", baseUrl: origin, googleMode: "cloud-code-assist",
    models: ["gemini-3.8-flash"], oauthAccountFailover: {
      enabled: true, strategy: "round-robin", sessionAffinity: "conversation",
    },
  } } } as unknown as OcxConfig;
  saveConfig(cfg);
  seen = [];
  refuse = undefined;
  refreshCount = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://oauth2.googleapis.com/token") {
      refreshCount++;
      return Response.json({ access_token: "synthetic-refreshed", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.origin !== origin || !["/v1internal:generateContent", "/v1internal:streamGenerateContent"].includes(url.pathname))
      throw new Error("Unexpected external request in affinity regression");
    const auth = new Headers(init?.headers).get("authorization")!;
    const body = JSON.parse(String(init?.body)) as { project: string };
    seen.push({ auth, project: body.project });
    return refuse?.(auth) ?? Response.json({ response: {
      candidates: [{ content: { role: "model", parts: [{ text: "synthetic result" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  sleep.mockRestore();
  release();
  clearGenericFailoverHealth();
  clearAntigravityAccountRosters();
  clearPoolRotationState();
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function turn(session?: string, extra: Record<string, unknown> = {}, options: Parameters<typeof handleResponses>[3] = {}, expectedStatus = 200): Promise<Response> {
  const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", ...(session ? { "session-id": session } : {}) },
    body: JSON.stringify({ model: `${provider}/gemini-3.8-flash`, input: "synthetic input", stream: false, ...extra }),
  }), cfg, { model: "gemini-3.8-flash", provider }, options);
  const status = response.status;
  await response.text();
  expect(status).toBe(expectedStatus);
  return response;
}

function assertPairing(): void {
  for (const send of seen) expect(send.project).toBe(accounts.find(row => row.auth === send.auth)!.project);
}

test("interleaved conversations retain their bearer/project without moving manual selection", async () => {
  let selections = 0;
  const unsubscribe = subscribeAccountSelections(() => { selections++; });
  try {
    await turn("conversation-a");
    const first = seen.at(-1)!.auth;
    await turn("conversation-b");
    const second = seen.at(-1)!.auth;
    expect(second).not.toBe(first);
    await turn("conversation-a");
    expect(seen.at(-1)!.auth).toBe(first);
    await turn("conversation-b");
    expect(seen.at(-1)!.auth).toBe(second);
    expect(getAccountSet(provider)!.activeAccountId).toBe(accounts[0]!.id);
    expect(selections).toBe(0);
    assertPairing();
  } finally { unsubscribe(); }
});

test("429 replacement stays bound after other conversations and cooldown expiry", async () => {
  await turn("conversation-a");
  const failed = seen.at(-1)!.auth;
  refuse = auth => auth === failed ? Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for quota metric" } }, { status: 429, headers: { "retry-after": "60" } }) : undefined;
  await turn("conversation-a");
  const replacement = seen.at(-1)!.auth;
  expect(replacement).not.toBe(failed);
  refuse = undefined;
  clearGenericFailoverHealth();
  await turn("conversation-b");
  await turn("conversation-a");
  expect(seen.at(-1)!.auth).toBe(replacement);
  assertPairing();
});

test("manual selection invalidates existing conversations including same-account reselection", async () => {
  await turn("conversation-a");
  await turn("conversation-b");
  const selected = accounts.find(row => row.auth !== seen.at(-1)!.auth)!;
  await setActiveAccount(provider, selected.id);
  cfg.providers[provider]!.oauthAccountFailover!.strategy = "quota";
  await turn("conversation-b");
  expect(seen.at(-1)!.auth).toBe(selected.auth);
  await setActiveAccount(provider, selected.id);
  await turn("conversation-a");
  expect(seen.at(-1)!.auth).toBe(selected.auth);
});

test("a paused bound account is replaced and the survivor remains bound", async () => {
  await turn("conversation-a");
  const bound = accounts.find(row => row.auth === seen.at(-1)!.auth)!;
  await setAccountPaused(provider, bound.id, true);
  await turn("conversation-a");
  const replacement = seen.at(-1)!.auth;
  expect(replacement).not.toBe(bound.auth);
  await turn("conversation-b");
  await turn("conversation-a");
  expect(seen.at(-1)!.auth).toBe(replacement);
});

test("none retains the existing per-request round-robin behavior", async () => {
  (cfg.providers[provider]!.oauthAccountFailover as Record<string, unknown>).sessionAffinity = "none";
  await turn("conversation-a");
  const first = seen.at(-1)!.auth;
  await turn("conversation-a");
  expect(seen.at(-1)!.auth).not.toBe(first);
});


test("401 on an off-active bound account refreshes that account and retains its project", async () => {
  await turn("conversation-a");
  await turn("conversation-b");
  const before = seen.at(-1)!;
  const bound = accounts.find(row => row.auth === before.auth)!;
  expect(bound.id).not.toBe(getAccountSet(provider)!.activeAccountId);
  refuse = auth => auth === before.auth ? Response.json({ error: { code: 401,
    status: "UNAUTHENTICATED", message: "synthetic rejection" } }, { status: 401 }) : undefined;
  await turn("conversation-b");
  expect(refreshCount).toBe(1);
  expect(seen.at(-1)!.auth).toBe("Bearer synthetic-refreshed");
  expect(seen.at(-1)!.project).toBe(before.project);
  await turn("conversation-b");
  expect(seen.at(-1)!.auth).toBe("Bearer synthetic-refreshed");
});

test.each(["manual", "credential"])("%s change during a bound credential wait preserves the correct authority", async change => {
  await turn("conversation-a");
  await turn("conversation-b");
  const bound = accounts.find(row => row.auth === seen.at(-1)!.auth)!;
  const ready = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const resolve = oauth.getValidAccessSnapshotForAccount;
  let held = false;
  const delay = spyOn(oauth, "getValidAccessSnapshotForAccount").mockImplementation(async (...args) => {
    const snapshot = await resolve(...args);
    if (!held && args[1] === bound.id) { held = true; ready.resolve(); await resume.promise; }
    return snapshot;
  });
  try {
    const pending = turn("conversation-b");
    await ready.promise;
    if (change === "manual") {
      await setActiveAccount(provider, accounts[0]!.id);
    } else {
      const row = getAccountSet(provider)!.accounts.find(row => row.id === bound.id)!;
      await saveAccountCredential(provider, bound.id, { ...row.credential, access: "synthetic-renewed" });
    }
    resume.resolve();
    await pending;
    expect(seen.at(-1)!.auth).toBe(change === "manual" ? accounts[0]!.auth : "Bearer synthetic-renewed");
    expect(seen.at(-1)!.project).toBe(change === "manual" ? accounts[0]!.project : bound.project);
  } finally { resume.resolve(); delay.mockRestore(); }
});


test("the same session marker is isolated by authenticated principal", async () => {
  const admission = (principal: string) => ({ kind: "configured" as const, keyId: "synthetic-scope",
    source: "bearer" as const, contextPrincipalId: principal });
  await turn("same-marker", {}, { admission: admission("principal-a") });
  const first = seen.at(-1)!.auth;
  await turn("same-marker", {}, { admission: admission("principal-b") });
  const second = seen.at(-1)!.auth;
  expect(second).not.toBe(first);
  await turn("same-marker", {}, { admission: admission("principal-a") });
  expect(seen.at(-1)!.auth).toBe(first);
});

test("unkeyed and shared-cohort turns do not acquire affinity or move the active selection", async () => {
  const before = getAccountSet(provider)!.selectionRevision;
  await turn();
  const unkeyed = seen.at(-1)!.auth;
  await turn();
  expect(seen.at(-1)!.auth).not.toBe(unkeyed);
  await turn(undefined, { prompt_cache_key: "shared-cohort" }, { promptCacheKeyIsSharedCohort: true });
  const shared = seen.at(-1)!.auth;
  await turn(undefined, { prompt_cache_key: "shared-cohort" }, { promptCacheKeyIsSharedCohort: true });
  expect(seen.at(-1)!.auth).not.toBe(shared);
  expect(getAccountSet(provider)!.selectionRevision).toBe(before);
});

test.each(["interleave", "manual", "credential", "pause", "disable"])("%s during pacing rebuilds the serving binding correctly", async change => {
  await turn("conversation-a");
  const first = seen.at(-1)!.auth;
  await turn("conversation-b");
  const bound = accounts.find(row => row.auth === seen.at(-1)!.auth)!;
  const ready = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const withSlot = pacing.withProviderRequestSlot;
  let held = false;
  const delayed: typeof pacing.withProviderRequestSlot = async (...args) => {
    if (!held) { held = true; ready.resolve(); await resume.promise; }
    return withSlot(...args);
  };
  const delay = spyOn(pacing, "withProviderRequestSlot").mockImplementation(delayed);
  try {
    const pending = turn("conversation-b");
    await ready.promise;
    const sendsBefore = seen.length;
    if (change === "interleave") {
      await turn("conversation-a");
      expect(seen.at(-1)!.auth).toBe(first);
    } else if (change === "disable") cfg.providers[provider]!.oauthAccountFailover!.enabled = false;
    else if (change === "manual") await setActiveAccount(provider, accounts[0]!.id);
    else if (change === "pause") await setAccountPaused(provider, bound.id, true);
    else {
      const row = getAccountSet(provider)!.accounts.find(row => row.id === bound.id)!;
      await saveAccountCredential(provider, bound.id, { ...row.credential, access: "synthetic-renewed" });
    }
    resume.resolve();
    await pending;
    expect(seen.length).toBeGreaterThan(sendsBefore);
    if (change === "manual") expect(seen.at(-1)!.auth).toBe(accounts[0]!.auth);
    else if (change === "credential") expect(seen.at(-1)!.auth).toBe("Bearer synthetic-renewed");
    else if (change === "pause") expect(seen.at(-1)!.auth).not.toBe(bound.auth);
    else expect(seen.at(-1)!.auth).toBe(bound.auth);
  } finally { resume.resolve(); delay.mockRestore(); }
});


test("disabling affinity during a refusal preserves reactive recovery and the manual selection", async () => {
  await turn("conversation-a");
  const before = getAccountSet(provider)!.selectionRevision;
  const failed = seen.at(-1)!.auth;
  refuse = auth => {
    if (auth !== failed) return;
    cfg.providers[provider]!.oauthAccountFailover!.enabled = false;
    return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric" } },
      { status: 429, headers: { "retry-after": "60" } });
  };
  await turn("conversation-a");
  expect(seen.at(-1)!.auth).not.toBe(failed);
  expect(getAccountSet(provider)!.selectionRevision).toBe(before);
});


test("an all-cooled pool retains the upstream 429 and Retry-After rather than a local conflict", async () => {
  for (const row of accounts) rotateGenericOAuthAccountOn429(cfg, provider, row.id, "60", Date.now(), "gemini-3.8-flash");
  refuse = () => Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for quota metric" } }, { status: 429, headers: { "retry-after": "60" } });
  const response = await turn("conversation-a", {}, {}, 429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(seen).toHaveLength(1);
});

test("existing classified 403 recovery binds the replacement for the next turn", async () => {
  await turn("conversation-a");
  const failed = seen.at(-1)!.auth;
  refuse = auth => auth === failed ? Response.json({ error: { code: 403, status: "PERMISSION_DENIED",
    message: "synthetic validation required", details: [{ reason: "VALIDATION_REQUIRED" }] } }, { status: 403 }) : undefined;
  await turn("conversation-a");
  const replacement = seen.at(-1)!.auth;
  expect(replacement).not.toBe(failed);
  refuse = undefined;
  clearGenericFailoverHealth();
  await turn("conversation-b");
  await turn("conversation-a");
  expect(seen.at(-1)!.auth).toBe(replacement);
  assertPairing();
});

test("a newly incompatible account model roster releases the conversation to a listing sibling", async () => {
  await turn("conversation-a");
  const bound = accounts.find(row => row.auth === seen.at(-1)!.auth)!;
  for (const row of accounts) {
    const model = row.id === bound.id ? "other-model" : "gemini-3.8-flash";
    recordAntigravityAccountRoster(provider, row.id, [{ id: model, wireModelId: model } as never]);
  }
  await turn("conversation-a");
  expect(seen.at(-1)!.auth).not.toBe(bound.auth);
});


test("Kiro terminal refresh on the active first choice still recovers to a sibling with affinity enabled", async () => {
  for (const slot of ["a", "b"]) await saveCredential("kiro", {
    access: `synthetic-${slot}`, refresh: `synthetic-refresh-${slot}`,
    expires: slot === "a" ? Date.now() - 1000 : Date.now() + 3_600_000,
    accountId: `synthetic-${slot}`, source: "oauth", kiro: { apiRegion: "us-east-1",
      profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/synthetic-${slot}` },
  });
  const rows = getAccountSet("kiro")!.accounts;
  await setActiveAccount("kiro", rows[0]!.id);
  const config = { defaultProvider: "kiro", providers: { kiro: {
    adapter: "kiro", authMode: "oauth", baseUrl: "https://runtime.us-east-1.kiro.dev",
    models: ["claude-sonnet-4.5"], oauthAccountFailover: { enabled: true, sessionAffinity: "conversation" },
  } } } as OcxConfig;
  saveConfig(config);
  const before = getAccountSet("kiro")!.selectionRevision;
  const sends: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/refreshToken")) return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (!url.startsWith("https://runtime.") || !url.endsWith(".kiro.dev/"))
      throw new Error("Unexpected request in Kiro terminal-refresh regression");
    sends.push(new Headers(init?.headers).get("authorization")!);
    return new Response(encodeMessage({ ":message-type": "event", ":event-type": "assistantResponseEvent" },
      new TextEncoder().encode(JSON.stringify({ content: "synthetic result" }))),
    { headers: { "content-type": "application/vnd.amazon.eventstream" } });
  }) as typeof fetch;
  const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "session-id": "kiro-session" },
    body: JSON.stringify({ model: "kiro/claude-sonnet-4.5", input: "synthetic input", stream: false }),
  }), config, { provider: "kiro", model: "claude-sonnet-4.5" });
  await response.text();
  expect(response.status).toBe(200);
  expect(sends).toEqual(["Bearer synthetic-b"]);
  expect(getAccountSet("kiro")!.selectionRevision).toBe(before);
});


test("project-less Antigravity credentials preserve the authentication refusal without dispatch", async () => {
  for (const row of getAccountSet(provider)!.accounts) {
    const credential = { ...row.credential };
    delete credential.projectId;
    await saveAccountCredential(provider, row.id, credential);
  }
  await turn("conversation-a", {}, {}, 401);
  expect(seen).toHaveLength(0);
});
