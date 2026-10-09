import { rotateAnthropicAccountOn429 } from "../helpers/anthropic-shared-quota";
/**
 * Anthropic OAuth on the managed native Messages lane (PF-10) against an in-process transport.
 * With `managedMessagesNative` and `managedMessagesNativeOAuth` on, an Anthropic OAuth
 * route sends the caller's Messages body with the access token of the account the existing OAuth
 * selection commits at dispatch — never the caller's credential — and maps the OAuth tool-name
 * prefix back in the answer. Pooled accounts keep the native wire with shared recovery. Every credential here is
 * synthetic, and any real network call fails the case.
 */
import { afterEach, beforeEach, describe, expect, test, spyOn, mock } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureSharedSpendLedger, DEFAULT_SPEND_RESERVATION_POLICY, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { saveConfig } from "../../src/config";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../src/oauth/anthropic";
import { clearAnthropicAccountPoolState, resetAnthropicRoutingForManualSelection, forgetAnthropicFailoverQuorum, formatAnthropicProviderForLog, getAnthropicAccountHealthSnapshot,} from "../../src/oauth/anthropic-routing";
import { captureOAuthAccountSelection, getAccountCredential, getAccountSet, markAccountNeedsReauth, replaceProviderAccountSet, saveAccountCredential, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { clearUpstreamHostHealth, getUpstreamHostHealth, upstreamHostHealthKey } from "../../src/codex/upstream-host-health";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import * as familyQuota from "../../src/oauth/anthropic-model-quota";
import { anthropicSessionAffinitySizeForTests } from "../../src/oauth/anthropic-routing";
import { nativeOAuthBindingIsCurrent, resolveNativeOAuthBinding } from "../../src/server/messages-native-oauth";
import { getRequestLogEntries } from "../../src/server/request-log";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ALLOWED_BETA = "interleaved-thinking-2025-05-14";
const UNKNOWN_BETA = "fixture-unlisted-beta-2099-01-01";
const SIGNATURE = "fixture-signature-CCCCCCCCCCCCCCCCCCCC";

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

let sent: Sent[] = [];
let home = "";
let previousHome: string | undefined;
let originalFetch: typeof globalThis.fetch;
let unexpectedFetches = 0;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-messages-native-oauth-"));
  process.env.OPENCODEX_HOME = home;
  sent = [];
  originalFetch = globalThis.fetch;
  unexpectedFetches = 0;
  globalThis.fetch = (async () => {
    unexpectedFetches += 1;
    throw new Error("unexpected global fetch in the native OAuth Messages test");
  }) as unknown as typeof fetch;
  clearAnthropicAccountPoolState();
  clearUpstreamHostHealth();
  forgetAnthropicFailoverQuorum();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  clearUpstreamHostHealth();
  resetProviderRequestPacingForTest();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  try {
    expect(unexpectedFetches).toBe(0);
  } finally {
    clearAnthropicAccountPoolState();
    forgetAnthropicFailoverQuorum();
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
  }
});

function credential(index: number) {
  return {
    access: `synthetic-anthropic-access-${index}`,
    refresh: `synthetic-anthropic-refresh-${index}`,
    expires: Date.now() + 3_600_000,
    accountId: `synthetic-account-${index}`,
    source: "oauth" as const,
  };
}

async function seed(count: number): Promise<string[]> {
  for (let index = 0; index < count; index++) await saveCredential("anthropic", credential(index));
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  forgetAnthropicFailoverQuorum();
  return ids;
}

const MESSAGE = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "tool_use", id: "toolu_fixture", name: "custom_lookup", input: {} }],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 9, output_tokens: 4 },
};

function sse(): string {
  return [
    { type: "message_start", message: { ...MESSAGE, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: "custom_lookup", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

function fixtureConfig(options: { oauthSwitch?: boolean } = {}): OcxConfig {
  const transport = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url: String(input), headers: new Headers(init?.headers), body });
    if (body.stream === true) return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
    return Response.json(MESSAGE);
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
    models: ["claude-sonnet-4-5"],
    fetch: transport,
  };
  const config = {
    port: 0,
    defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: false },
    providers: { anthropic: provider },
    protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: options.oauthSwitch ?? true } },
  } as OcxConfig;
  saveConfig(config);
  return config;
}

const BODY = {
  model: "anthropic/claude-sonnet-4-5",
  max_tokens: 64,
  system: "fixture system",
  tools: [{ name: "lookup", description: "fixture", input_schema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: "fixture question" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "fixture reasoning", signature: SIGNATURE },
      { type: "tool_use", id: "toolu_prev", name: "lookup", input: {} },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_prev", content: "fixture result" }] },
  ],
};

// Neither value is an `sk-ant-` credential, so the caller-forward passthrough is not taken; both
// must still be kept away from the provider.
const CALLER_HEADERS = {
  authorization: "Bearer fixture-admission-token",
  "x-api-key": "fixture-caller-key",
  "anthropic-beta": `${ALLOWED_BETA},${UNKNOWN_BETA}`,
};

async function send(config: OcxConfig, body: Record<string, unknown>, identityHeaders: Record<string, string> = {}, signal?: AbortSignal) {
  const requestId = `pf10-oauth-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...CALLER_HEADERS, ...identityHeaders },
    body: JSON.stringify(body),
    signal,
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  const text = await response.text();
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  return { response, text, row: rows[0]! };
}

describe("managed native Messages over Anthropic OAuth", () => {
  for (const native of [true, false]) for (const enabled of [true, false]) {
    for (const state of ["needs-reauth", "unusable", "cooled", "paused-cooled", "healthy"] as const) {
      test(`Messages native=${native}, pool=${enabled}: pacing ${state} preserves fresh admission`, async () => {
        const ids = await seed(2);
        await markAccountNeedsReauth("anthropic", ids[1]!, true);
        forgetAnthropicFailoverQuorum();
        const cfg = fixtureConfig({ oauthSwitch: native });
        cfg.anthropicAccountPool = { enabled };
        cfg.providers.anthropic!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
        const slot = await waitForProviderRequestSlot("anthropic", cfg.providers.anthropic!, "claude-sonnet-4-5");
        const pending = send(cfg, { ...BODY, stream: false });
        let setupFailed = false;
        let setupError: unknown;
        let health: ReturnType<typeof getAnthropicAccountHealthSnapshot>[] = [];
        let roster: ReturnType<typeof getAccountSet>;
        try {
          for (let i = 0; i < 100 && providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued === 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          expect(providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued).toBe(1);
          const coolingConfig = { ...cfg, anthropicAccountPool: { enabled: true } };
          if (state === "cooled") rotateAnthropicAccountOn429(coolingConfig, ids[0]!, "60");
          else {
            await markAccountNeedsReauth("anthropic", ids[1]!, false);
            await setAccountPaused("anthropic", ids[0]!, true);
            if (state === "needs-reauth") await markAccountNeedsReauth("anthropic", ids[1]!, true);
            if (state === "paused-cooled") rotateAnthropicAccountOn429(coolingConfig, ids[1]!, "60");
            if (state === "unusable") {
              await saveAccountCredential("anthropic", ids[1]!, { ...credential(1), source: "local-cli", expires: 0 });
              await replaceProviderAccountSet("anthropic", { ...getAccountSet("anthropic")!, activeAccountId: ids[0]! });
            }
          }
          health = ids.map(id => getAnthropicAccountHealthSnapshot(id));
          roster = getAccountSet("anthropic");
        } catch (error) { setupFailed = true; setupError = error; }
        finally { slot.release(); if (setupFailed) await pending.catch(() => undefined); }
        if (setupFailed) throw setupError;
        const result = await pending;
        const initial = await send(cfg, { ...BODY, stream: false });
        const expected = state === "healthy" ? 200 : state === "cooled" || state === "paused-cooled" ? 429
          : state === "unusable" && !enabled ? 403 : 401;
        expect(initial.response.status).toBe(expected);
        expect(result.response.status).toBe(initial.response.status);
        if (expected !== 200) {
          expect(JSON.parse(result.text).error.type).toBe(JSON.parse(initial.text).error.type);
          expect(sent).toEqual([]);
          expect(getAccountSet("anthropic")).toEqual(roster!);
        } else {
          expect(sent).toHaveLength(2);
          expect(sent.every(entry => entry.headers.get("authorization") === `Bearer ${credential(1).access}`)).toBe(true);
          expect(result.row.provider).toBe(formatAnthropicProviderForLog("anthropic", ids[1]));
        }
        if (expected === 429) {
          expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(50);
          expect(Number(result.response.headers.get("retry-after"))).toBeLessThanOrEqual(60);
        }
        expect(ids.map(id => getAnthropicAccountHealthSnapshot(id))).toEqual(health);
        expect(getUpstreamHostHealth(upstreamHostHealthKey("anthropic", "api.anthropic.com"))).toBeNull();
      });
    }
  }

  test("a singleton paused during native pacing returns 403 without dispatch", async () => {
    const [id] = await seed(1);
    const cfg = fixtureConfig();
    cfg.providers.anthropic!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
    const slot = await waitForProviderRequestSlot("anthropic", cfg.providers.anthropic!, "claude-sonnet-4-5");
    const pending = send(cfg, { ...BODY, stream: false });
    let setupFailed = false;
    let setupError: unknown;
    try {
      for (let i = 0; i < 100 && providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(providerRequestPacingStatus("anthropic", cfg.providers.anthropic!).queued).toBe(1);
      await setAccountPaused("anthropic", id!, true);
    } catch (error) {
      setupFailed = true;
      setupError = error;
    } finally {
      slot.release();
      // A failed queue assertion must not leave this request running into afterEach. Drain it,
      // but keep the assertion as the useful failure if teardown also rejects.
      if (setupFailed) await pending.catch(() => undefined);
    }
    if (setupFailed) throw setupError;
    const { response, text } = await pending;
    expect(response.status).toBe(403);
    expect(text).toContain("Resume");
    expect(sent).toEqual([]);
  });

  test("an operator-paused singleton returns 403 and never sends", async () => {
    const [id] = await seed(1);
    await setAccountPaused("anthropic", id!, true);
    const { response, text } = await send(fixtureConfig(), { ...BODY, stream: false });
    expect(response.status).toBe(403);
    expect(text).toContain("Resume");
    expect(sent).toEqual([]);
  });

  test("sends with the selected account's token and the OAuth shape, never the caller's credential", async () => {
    await seed(1);
    const { response, text, row } = await send(fixtureConfig(), { ...BODY, stream: true });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    const wire = sent[0]!;
    expect(wire.url).toBe("https://api.anthropic.com/v1/messages");
    expect(wire.headers.get("authorization")).toBe(`Bearer ${credential(0).access}`);
    expect(wire.headers.get("x-api-key")).toBeNull();
    expect(wire.headers.get("anthropic-beta")).toBe(`${ANTHROPIC_OAUTH_BETA},${ALLOWED_BETA}`);
    expect((wire.body.system as { text: string }[])[0]!.text).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
    expect((wire.body.tools as { name: string }[])[0]!.name).toBe("custom_lookup");
    // First-party Anthropic receives the signature it minted.
    expect(JSON.stringify(wire.body)).toContain(SIGNATURE);

    // The answer names the caller's tool, not the wire name.
    expect(text).toContain("\"name\":\"lookup\"");
    expect(text).not.toContain("custom_lookup");

    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "native", requestPath: ["messages", "messages"] });
    expect(row.protocolTrace?.reasonCodes).toContain("anthropic-beta-dropped");
    expect(row.protocolTrace?.reasonCodes).not.toContain("opaque-state-stripped");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("synthetic-anthropic-access-0");
    expect(serialized).not.toContain(UNKNOWN_BETA);
    expect(serialized).not.toContain(SIGNATURE);
  });

  test("genuine client identity survives credential refresh and selected account switch", async () => {
    const ids = await seed(2);
    await markAccountNeedsReauth("anthropic", ids[1]!, true);
    const uuidA = "11111111-1111-4111-8111-111111111111";
    const uuidB = "22222222-2222-4222-8222-222222222222";
    await saveAccountCredential("anthropic", ids[0]!, { ...credential(0), accountId: uuidA });
    const headers = {
      "User-Agent": "claude-cli/2.1.282 (external, cli)", "X-App": "cli",
      "X-Claude-Code-Session-Id": "33333333-3333-4333-8333-333333333333",
      "X-Stainless-Lang": "js", "X-Stainless-Runtime": "node", "X-Stainless-Package-Version": "9.9.9",
    };
    const metadata = { user_id: JSON.stringify({ account_uuid: uuidA, device_id: "fixture-device", session_id: "fixture-session" }) };
    const cfg = fixtureConfig();
    forgetAnthropicFailoverQuorum();
    expect((await send(cfg, { ...BODY, stream: false, metadata }, headers)).response.status).toBe(200);
    const refreshed = "fixture-refreshed-access";
    await saveAccountCredential("anthropic", ids[0]!, { ...credential(0), accountId: uuidA, access: refreshed });
    expect((await send(cfg, { ...BODY, stream: false, metadata }, headers)).response.status).toBe(200);
    await markAccountNeedsReauth("anthropic", ids[0]!, true);
    await saveAccountCredential("anthropic", ids[1]!, { ...credential(1), accountId: uuidB });
    await markAccountNeedsReauth("anthropic", ids[1]!, false);
    await setActiveAccount("anthropic", ids[1]!);
    forgetAnthropicFailoverQuorum();
    expect((await send(cfg, { ...BODY, stream: false, metadata }, headers)).response.status).toBe(200);
    expect(sent.map(entry => entry.headers.get("authorization"))).toEqual([
      `Bearer ${credential(0).access}`, `Bearer ${refreshed}`, `Bearer ${credential(1).access}`,
    ]);
    expect(sent.map(entry => JSON.parse((entry.body.metadata as typeof metadata).user_id).account_uuid)).toEqual([uuidA, uuidA, uuidB]);
    for (const entry of sent) {
      for (const [name, value] of Object.entries(headers)) expect(entry.headers.get(name)).toBe(value);
      expect(entry.headers.has("x-api-key")).toBe(false);
      expect(entry.headers.get("anthropic-beta")).not.toContain(UNKNOWN_BETA);
      expect(entry.body).not.toHaveProperty("clientIdentity");
    }
    expect(JSON.parse(metadata.user_id).account_uuid).toBe(uuidA);
  });

  test("physical send binds metadata to the UUID in the serving credential, never the local slot", async () => {
    const [id] = await seed(1);
    const uuid = "22222222-2222-4222-8222-222222222222";
    await saveAccountCredential("anthropic", id!, { ...credential(0), accountId: uuid });
    const metadata = { user_id: JSON.stringify({ account_uuid: "11111111-1111-4111-8111-111111111111", device_id: "fixture-device", session_id: "fixture-session" }) };
    const { response } = await send(fixtureConfig(), { ...BODY, stream: false, metadata });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${credential(0).access}`);
    const wire = sent[0]!.body.metadata as typeof metadata;
    expect(JSON.parse(wire.user_id)).toEqual({ account_uuid: uuid, device_id: "fixture-device", session_id: "fixture-session" });
    expect(wire.user_id).not.toContain(id!);
    expect(JSON.parse(metadata.user_id).account_uuid).not.toBe(uuid);
  });

  test("a JSON answer maps the tool name back too", async () => {
    await seed(1);
    const { response, text } = await send(fixtureConfig(), { ...BODY, stream: false });
    expect(response.status).toBe(200);
    expect(JSON.parse(text).content[0]).toMatchObject({ type: "tool_use", name: "lookup" });
  });

  test("the account is the one the selection holds, not merely the first stored", async () => {
    const ids = await seed(2);
    // One usable account remains, so no rotation quorum: the lane serves the selected one.
    await markAccountNeedsReauth("anthropic", ids[0]!, true);
    await setActiveAccount("anthropic", ids[1]!);
    forgetAnthropicFailoverQuorum();
    const { response, row } = await send(fixtureConfig(), { ...BODY, stream: false });
    expect(response.status).toBe(200);
    expect(row.protocolTrace).toMatchObject({ mode: "native" });
    expect(sent.map(entry => entry.headers.get("authorization"))).toEqual([`Bearer ${credential(1).access}`]);
  });

  test("two usable accounts retain the native wire lane", async () => {
    await seed(2);
    const { row } = await send(fixtureConfig(), { ...BODY, stream: false });
    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "native" });
  });

  test("with the OAuth switch off the route stays on the bridge", async () => {
    await seed(1);
    const { row } = await send(fixtureConfig({ oauthSwitch: false }), { ...BODY, stream: false });
    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "legacy-bridge" });
    expect(row.protocolTrace?.reasonCodes).toContain("auth-mode-not-native");
  });

  test("no stored account answers 401 in Anthropic shape and sends nothing", async () => {
    const { response, text } = await send(fixtureConfig(), { ...BODY, stream: false });
    expect(response.status).toBe(401);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    expect(sent).toHaveLength(0);
  });
});


describe("native OAuth pooled binding", () => {
  test("round-robin binds each session and restores its own account after another session", async () => {
    await seed(2);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true, strategy: "round-robin" };
    const first = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-session-a", model: "claude-sonnet-4-5" });
    const second = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-session-b", model: "claude-sonnet-4-5" });
    expect(second.snapshot.accountId).not.toBe(first.snapshot.accountId);
    expect(nativeOAuthBindingIsCurrent(first)).toBe(true);
    const resumed = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-session-a", model: "claude-sonnet-4-5" });
    expect(resumed.snapshot.accountId).toBe(first.snapshot.accountId);
    expect(nativeOAuthBindingIsCurrent(resumed)).toBe(true);
  });

  test("a recovery candidate commits its credential and rebinds the session", async () => {
    const ids = await seed(2);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true };
    const first = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-session", model: "claude-sonnet-4-5" });
    const alternate = ids.find(id => id !== first.snapshot.accountId)!;
    const recovered = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-session", model: "claude-sonnet-4-5", candidateAccountId: alternate, expectedRecoverySelection: captureOAuthAccountSelection("anthropic") });
    expect(recovered.snapshot.accountId).toBe(alternate);
    expect((await resolveNativeOAuthBinding(config, { sessionKey: "fixture-session", model: "claude-sonnet-4-5" })).snapshot.accountId).toBe(alternate);
  });
});


describe("native pooled Messages dispatch", () => {
  test("shared quota 429 rebuilds from the source body with the replacement bearer and account UUID", async () => {
    const ids = await seed(2);
    const uuids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    for (const [index, id] of ids.entries()) await saveAccountCredential("anthropic", id, { ...credential(index), accountId: uuids[index] });
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true };
    config.providers.anthropic!.fetch = (async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      if (sent.length === 1) return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture quota" } }, {
        status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" },
      });
      return Response.json(MESSAGE);
    }) as typeof fetch;
    const metadata = { user_id: JSON.stringify({ account_uuid: uuids[0], session_id: "fixture-recovery-session" }) };
    const body = { ...BODY, stream: false, metadata, system: [{ type: "text", text: "fixture cache prefix", cache_control: { type: "ephemeral" } }] };
    const { response, row } = await send(config, body);
    expect(response.status).toBe(200);
    expect(row.protocolTrace?.mode).toBe("native");
    expect(sent).toHaveLength(2);
    expect(sent.map(entry => entry.headers.get("authorization"))).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
    for (const [index, entry] of sent.entries()) {
      expect(entry.headers.has("x-api-key")).toBe(false);
      expect(JSON.parse((entry.body.metadata as typeof metadata).user_id).account_uuid).toBe(uuids[index]);
      expect(entry.body.messages).toEqual(body.messages.map(message => message.role !== "assistant" ? message : { ...message, content: (message.content as Record<string, unknown>[]).map(block => block.type === "tool_use" ? { ...block, name: "custom_lookup" } : block) }));
      expect((entry.body.system as Record<string, unknown>[])[1]).toEqual(body.system[0]);
    }
    expect(getAnthropicAccountHealthSnapshot(ids[0]!)).not.toBeNull();
    expect(JSON.parse(metadata.user_id).account_uuid).toBe(uuids[0]);
    expect(row.attempts?.[1]?.recoveryKinds).toEqual(["rate-limit-429"]);
  });

  test("account-refusal 403 rebuild is attributed as OAuth account recovery", async () => {
    await seed(2);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true };
    config.providers.anthropic!.fetch = (async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return sent.length === 1
        ? Response.json({ type: "error", error: { type: "permission_error", message: "Your account does not have access to Claude Code" } }, { status: 403 })
        : Response.json(MESSAGE);
    }) as typeof fetch;

    const { response, row } = await send(config, { ...BODY, stream: false });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(row.attempts?.[1]?.recoveryKinds).toEqual(["oauth-account-403"]);
  });

  test("two conversations retain sticky account routing after global selection moves", async () => {
    await seed(2);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true, strategy: "round-robin" };
    for (const session of ["fixture-a", "fixture-b", "fixture-a"]) {
      expect((await send(config, { ...BODY, stream: false }, { session_id: session })).response.status).toBe(200);
    }
    const bearers = sent.map(entry => entry.headers.get("authorization"));
    expect(bearers[0]).not.toBe(bearers[1]);
    expect(bearers[2]).toBe(bearers[0]);
  });

  test("blank session_id retains affinity through the Claude Code session header", async () => {
    await seed(2);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true, strategy: "round-robin" };
    for (const session of ["fallback-a", "fallback-b", "fallback-a"]) {
      expect((await send(config, { ...BODY, stream: false }, { session_id: " ", "x-claude-code-session-id": session })).response.status).toBe(200);
    }
    const bearers = sent.map(entry => entry.headers.get("authorization"));
    expect(bearers[0]).not.toBe(bearers[1]);
    expect(bearers[2]).toBe(bearers[0]);
  });

  test("strict model routes admit only their declared account", async () => {
    const ids = await seed(2);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true, routes: [{ name: "fixture-route", match: "claude-sonnet-*", accounts: [ids[1]!] }] };
    const { response, row } = await send(config, { ...BODY, stream: false });
    expect(response.status).toBe(200);
    expect(row.protocolTrace?.mode).toBe("native");
    expect(sent.map(entry => entry.headers.get("authorization"))).toEqual([`Bearer ${credential(1).access}`]);
    await expect(resolveNativeOAuthBinding(config, { model: "claude-sonnet-4-5", candidateAccountId: ids[0], expectedRecoverySelection: captureOAuthAccountSelection("anthropic") })).rejects.toThrow("OAuth account selection changed");
  });

  test("an error inside a stream after assistant output never rotates or replays", async () => {
    await seed(2);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true };
    config.providers.anthropic!.fetch = (async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const prefix = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...MESSAGE, content: [] } })}\n\nevent: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "fixture output" } })}\n\n`;
      return new Response(prefix + 'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"fixture quota"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const { response, text } = await send(config, { ...BODY, stream: true });
    expect(response.status).toBe(200);
    expect(text).toContain("fixture output");
    expect(text).toContain("rate_limit_error");
    expect(sent).toHaveLength(1);
  });

  test("a concurrent manual selection wins over a stale recovery candidate", async () => {
    const ids = await seed(3);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true };
    const pending = resolveNativeOAuthBinding(config, { sessionKey: "fixture-manual-race", candidateAccountId: ids[1], expectedRecoverySelection: captureOAuthAccountSelection("anthropic") });
    await setActiveAccount("anthropic", ids[2]!);
    resetAnthropicRoutingForManualSelection(ids[2]!);
    const binding = await pending;
    expect(binding.snapshot.accountId).toBe(ids[2]!);
    expect(nativeOAuthBindingIsCurrent(binding)).toBe(true);
  });
});


describe("overlapping native pool dispatch", () => {
  test("queued conversations send their own affine bearer and body without global selection churn", async () => {
    await seed(2);
    const config = fixtureConfig();
    config.anthropicAccountPool = { enabled: true, strategy: "round-robin" };
    config.providers.anthropic!.requestPacing = { enabled: true, maxConcurrentRequests: 2 };
    const first = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-overlap-a", model: "claude-sonnet-4-5" });
    const second = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-overlap-b", model: "claude-sonnet-4-5" });
    const slots = await Promise.all([0, 1].map(() => waitForProviderRequestSlot("anthropic", config.providers.anthropic!, "claude-sonnet-4-5")));
    const bodyA = { ...BODY, stream: false, messages: [{ role: "user", content: "fixture conversation a" }] };
    const bodyB = { ...BODY, stream: false, messages: [{ role: "user", content: "fixture conversation b" }] };
    const pending = [send(config, bodyA, { session_id: "fixture-overlap-a" }), send(config, bodyB, { session_id: "fixture-overlap-b" })];
    let revision: string | undefined;
    try {
      for (let i = 0; i < 100 && providerRequestPacingStatus("anthropic", config.providers.anthropic!).queued < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(providerRequestPacingStatus("anthropic", config.providers.anthropic!).queued).toBe(2);
      revision = captureOAuthAccountSelection("anthropic")?.revision;
    } finally { slots.forEach(slot => slot.release()); }
    const results = await Promise.all(pending);
    expect(results.map(result => result.response.status)).toEqual([200, 200]);
    expect(sent).toHaveLength(2);
    for (const [body, binding] of [[bodyA, first], [bodyB, second]] as const) {
      const entry = sent.find(entry => JSON.stringify(entry.body.messages) === JSON.stringify(body.messages));
      expect(entry).toBeDefined();
      expect(entry!.headers.get("authorization")).toBe(`Bearer ${binding.snapshot.accessToken}`);
    }
    expect(captureOAuthAccountSelection("anthropic")?.revision).toBe(revision);
  });
});


test("manual selection before recovery resolution defeats a pre-wait candidate", async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  const expectedRecoverySelection = captureOAuthAccountSelection("anthropic");
  await setActiveAccount("anthropic", ids[1]!);
  resetAnthropicRoutingForManualSelection(ids[1]!);
  const binding = await resolveNativeOAuthBinding(config, {
    sessionKey: "fixture-before-resolve", candidateAccountId: ids[0], expectedRecoverySelection,
  });
  expect(binding.snapshot.accountId).toBe(ids[1]!);
  expect(nativeOAuthBindingIsCurrent(binding)).toBe(true);
});


test("manual override revokes pooled affinity while unbound bindings retain the global fence", async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  const bound = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-manual-invalidation" });
  const unbound = await resolveNativeOAuthBinding(config);
  const alternate = ids.find(id => id !== bound.snapshot.accountId)!;
  await setActiveAccount("anthropic", alternate);
  resetAnthropicRoutingForManualSelection(alternate);
  expect(nativeOAuthBindingIsCurrent(bound)).toBe(false);
  expect(nativeOAuthBindingIsCurrent(unbound)).toBe(false);
  expect((await resolveNativeOAuthBinding(config, { sessionKey: "fixture-manual-invalidation" })).snapshot.accountId).toBe(alternate);
});

test("manual switch while native throttle waits must win", async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  config.providers.anthropic!.fetch = (async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (sent.length === 1) {
      setTimeout(async () => {
        await setActiveAccount("anthropic", ids[1]!);
        resetAnthropicRoutingForManualSelection(ids[1]!);
      }, 20);
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture throttle" } }, { status: 429, headers: { "retry-after": "0.3" } });
    }
    return Response.json(MESSAGE);
  }) as typeof fetch;
  const { response } = await send(config, { ...BODY, stream: false }, { session_id: "review-manual-race" });
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${credential(1).access}`);
});


test("two bound conversations can send together", async () => {
  await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true, strategy: "round-robin" };
  await send(config, { ...BODY, stream: false }, { session_id: "review-concurrent-a" });
  await send(config, { ...BODY, stream: false }, { session_id: "review-concurrent-b" });
  const statuses = await Promise.all(Array.from({ length: 10 }, (_, i) => send(config, { ...BODY, stream: false }, { session_id: i % 2 ? "review-concurrent-b" : "review-concurrent-a" })));
  expect(statuses.map(s => s.response.status)).toEqual(Array(10).fill(200));
});


test("manual switch before native response headers must win", async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  config.providers.anthropic!.fetch = (async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (sent.length === 1) {
      await setActiveAccount("anthropic", ids[1]!);
      resetAnthropicRoutingForManualSelection(ids[1]!);
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture throttle" } }, { status: 429, headers: { "retry-after": "0.1" } });
    }
    return Response.json(MESSAGE);
  }) as typeof fetch;
  const { response } = await send(config, { ...BODY, stream: false }, { session_id: "review-headers-manual-race" });
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${credential(1).access}`);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("manual ABA followed by renewed same-account affinity revokes the old binding", async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  const old = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-aba" });
  await setActiveAccount("anthropic", ids[1]!);
  resetAnthropicRoutingForManualSelection(ids[1]!);
  await setActiveAccount("anthropic", old.snapshot.accountId);
  resetAnthropicRoutingForManualSelection(old.snapshot.accountId);
  const fresh = await resolveNativeOAuthBinding(config, { sessionKey: "fixture-aba" });
  expect(nativeOAuthBindingIsCurrent(fresh)).toBe(true);
  expect(nativeOAuthBindingIsCurrent(old)).toBe(false);
});

for (const fallback of [false, true]) test(`route change across binding await re-admits before affinity effects (fallback=${fallback})`, async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true, routes: [{ name: "fixture-route", match: "claude-sonnet-*", accounts: [ids[0]!] }] };
  const pending = resolveNativeOAuthBinding(config, { model: "claude-sonnet-4-5", sessionKey: "fixture-route-await" });
  config.anthropicAccountPool.routes = [{ name: "fixture-route", match: "claude-sonnet-*", accounts: fallback ? ["fixture-missing"] : [ids[1]!], fallback }];
  const binding = await pending;
  expect(binding.routeDecision).toMatchObject({ accounts: fallback ? ["fixture-missing"] : [ids[1]!], fallback });
  if (!fallback) expect(binding.snapshot.accountId).toBe(ids[1]);
  expect(anthropicSessionAffinitySizeForTests()).toBe(1);
  expect(nativeOAuthBindingIsCurrent(binding)).toBe(true);
  config.anthropicAccountPool.routes = [{ name: "fixture-route", match: "claude-sonnet-*", accounts: ["fixture-missing"] }];
  expect(nativeOAuthBindingIsCurrent(binding)).toBe(false);
});

test("malformed route after an asynchronous admission is a request error", async () => {
  await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  const pending = resolveNativeOAuthBinding(config, { model: "claude-sonnet-4-5" });
  config.anthropicAccountPool.routes = [{ name: "bad", match: "claude-sonnet-*", accounts: [] }];
  await expect(pending).rejects.toThrow("Invalid Anthropic model routes");
  expect(anthropicSessionAffinitySizeForTests()).toBe(0);
});

function mockPrimaryFamilyClaim(implementation: typeof familyQuota.claimAnthropicFamilyRevalidation) {
  const claim = mock(implementation);
  const resolve = familyQuota.anthropicModelQuotaFor;
  const factory = spyOn(familyQuota, "anthropicModelQuotaFor").mockImplementation(instance => {
    const facade = resolve(instance);
    return instance === "anthropic" ? { ...facade, claimAnthropicFamilyRevalidation: claim } : facade;
  });
  return { claim, restoreClaim: () => factory.mockRestore() };
}

test("denied family lease records no physical send and creates no spend journal", async () => {
  await seed(1);
  const { claim: denied, restoreClaim } = mockPrimaryFamilyClaim(() => null);
  try {
    const { response, row } = await send(fixtureConfig(), { ...BODY, stream: false });
    expect(response.status).toBe(429);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(row.attempts?.reduce((sum, attempt) => sum + attempt.sendCount, 0) ?? 0).toBe(0);
    expect(existsSync(join(home, "spend-ledger.jsonl"))).toBe(false);
  } finally { restoreClaim(); }
});

test("family lease is released on physical transport failure", async () => {
  await seed(1);
  let releases = 0;
  const { claim: claimed, restoreClaim } = mockPrimaryFamilyClaim(() => () => { releases++; });
  const config = fixtureConfig();
  config.providers.anthropic!.fetch = (async () => { throw new Error("fixture transport failed"); }) as typeof fetch;
  try {
    const { response } = await send(config, { ...BODY, stream: false });
    expect(response.status).toBe(502);
    expect(claimed).toHaveBeenCalledTimes(1);
    expect(releases).toBe(1);
  } finally { restoreClaim(); }
});

test("refusal cancellation starts before replacement selection without awaiting deferred disposal", async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  const cancellationFinished = deferred<void>();
  let cancelled = false;
  let selectedAtCancellation: string | undefined;
  config.providers.anthropic!.fetch = (async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (sent.length > 1) {
      expect(cancelled).toBe(true);
      return Response.json(MESSAGE);
    }
    return new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        selectedAtCancellation = captureOAuthAccountSelection("anthropic")?.accountId;
        return cancellationFinished.promise;
      },
    }), { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" } });
  }) as typeof fetch;
  try {
    expect((await send(config, { ...BODY, stream: false })).response.status).toBe(200);
    expect(selectedAtCancellation).toBe(ids[0]);
    expect(sent).toHaveLength(2);
  } finally { cancellationFinished.resolve(); }
});

test("late replaced sending credential cannot attribute refusal to its replacement", async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  config.providers.anthropic!.fetch = (async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    await saveAccountCredential("anthropic", ids[0]!, { ...credential(0), access: "fixture-new-generation", accountId: "fixture-new-uuid" });
    return Response.json({ type: "error", error: { type: "permission_error", message: "Your account does not have access to Claude Code" } }, { status: 403 });
  }) as typeof fetch;
  const { response } = await send(config, { ...BODY, stream: false });
  expect(response.status).toBe(403);
  expect(sent).toHaveLength(1);
  expect(getAnthropicAccountHealthSnapshot(ids[0]!)).toBeNull();
  expect(getAnthropicAccountHealthSnapshot(ids[1]!)).toBeNull();
});

test("shared quota exhaustion is bounded and never resends an already-tried alternate", async () => {
  await seed(5);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  config.providers.anthropic!.fetch = (async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture quota" } }, {
      status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" },
    });
  }) as typeof fetch;
  const { response } = await send(config, { ...BODY, stream: false });
  expect(response.status).toBe(429);
  expect(sent.length).toBeLessThanOrEqual(4);
  expect(new Set(sent.map(entry => entry.headers.get("authorization"))).size).toBe(sent.length);
});

test("family lease releases when spend admission refuses without a physical send", async () => {
  await seed(1);
  const config = fixtureConfig();
  let releases = 0;
  const { claim: claimed, restoreClaim } = mockPrimaryFamilyClaim(() => () => { releases++; });
  configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: 1 } }));
  try {
    const { response, row } = await send(config, { ...BODY, stream: false });
    expect(response.status).toBe(429);
    expect(claimed).toHaveBeenCalledTimes(1);
    expect(releases).toBe(1);
    expect(sent).toHaveLength(0);
    expect(row.attempts?.reduce((sum, attempt) => sum + attempt.sendCount, 0) ?? 0).toBe(0);
  } finally {
    restoreClaim();
    configureSharedSpendLedger(DEFAULT_SPEND_RESERVATION_POLICY);
  }
});

test("family lease releases when cancellation arrives at admission before accounting", async () => {
  await seed(1);
  const config = fixtureConfig();
  const controller = new AbortController();
  let releases = 0;
  const { claim: claimed, restoreClaim } = mockPrimaryFamilyClaim(() => {
    controller.abort(new Error("fixture cancellation"));
    return () => { releases++; };
  });
  try {
    const { response, row } = await send(config, { ...BODY, stream: false }, {}, controller.signal);
    expect(response.status).toBe(499);
    expect(claimed).toHaveBeenCalledTimes(1);
    expect(releases).toBe(1);
    expect(sent).toHaveLength(0);
    expect(row.attempts?.reduce((sum, attempt) => sum + attempt.sendCount, 0) ?? 0).toBe(0);
    expect(existsSync(join(home, "spend-ledger.jsonl"))).toBe(false);
  } finally { restoreClaim(); }
});

test("a late UUID-only replacement cannot receive the sender's refusal attribution", async () => {
  const ids = await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true };
  config.providers.anthropic!.fetch = (async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const previous = getAccountCredential("anthropic", ids[0]!)!;
    await saveAccountCredential("anthropic", ids[0]!, { ...previous, accountId: "fixture-replaced-uuid" });
    return Response.json({ type: "error", error: { type: "permission_error", message: "Your account does not have access to Claude Code" } }, { status: 403 });
  }) as typeof fetch;
  expect((await send(config, { ...BODY, stream: false })).response.status).toBe(403);
  expect(sent).toHaveLength(1);
  expect(getAnthropicAccountHealthSnapshot(ids[0]!)).toBeNull();
  expect(getAnthropicAccountHealthSnapshot(ids[1]!)).toBeNull();
});

test("malformed native model routes answer 400 rather than an authentication refusal", async () => {
  await seed(2);
  const config = fixtureConfig();
  config.anthropicAccountPool = { enabled: true, routes: [{ name: "bad", match: "claude-sonnet-*", accounts: [] }] };
  const { response, text } = await send(config, { ...BODY, stream: false });
  expect(response.status).toBe(400);
  expect(JSON.parse(text).error.type).toBe("invalid_request_error");
  expect(sent).toHaveLength(0);
});
