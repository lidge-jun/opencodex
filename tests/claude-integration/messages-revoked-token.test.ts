import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { OcxConfig } from "../../src/types";
import type { RouteResult } from "../../src/router";
import type { GenerationContext } from "../../src/lib/state-store-sweeper";
import {
  anthropicInstanceBarrier, createAnthropicInstanceFixture, instanceFixtureCredential, instanceFixtureUuid,
  type AnthropicInstanceFixture,
} from "../helpers/anthropic-instance-fixture";

type Rec = Record<string, unknown>;
type Sent = { instance: AnthropicInstanceId; url: string; headers: Headers; body: Rec };
const INSTANCES = ["anthropic", "anthropic2"] as const;
const CALLER = "sk-ant-fixture-caller";
let f: AnthropicInstanceFixture;
let sent: Sent[];
let ingress: typeof import("../../src/server/claude-messages");
let native: typeof import("../../src/server/messages-native");
let binding: typeof import("../../src/server/messages-native-oauth");
let planner: typeof import("../../src/protocols/plan-snapshot");
let settings: typeof import("../../src/protocols/settings");
let identity: typeof import("../../src/oauth/anthropic-identity");
let pacing: typeof import("../../src/providers/request-pacing");
let logs: typeof import("../../src/server/request-log");
let releaseSpend: (() => void) | undefined;
const restorations: Array<() => void> = [];

beforeEach(async () => {
  // The shared fixture creates all homes and blocks network before runtime imports.
  f = await createAnthropicInstanceFixture({ anthropic: { enabled: false }, anthropic2: { enabled: false } });
  [ingress, native, binding, planner, settings, identity, pacing, logs] = await Promise.all([
    import("../../src/server/claude-messages"), import("../../src/server/messages-native"),
    import("../../src/server/messages-native-oauth"), import("../../src/protocols/plan-snapshot"),
    import("../../src/protocols/settings"), import("../../src/oauth/anthropic-identity"),
    import("../../src/providers/request-pacing"), import("../../src/server/request-log"),
  ]);
  releaseSpend = (await import("../helpers/owned-spend-home")).acquireOwnedSpendHome();
  (await import("../../src/responses/reasoning-replay-cache")).clearReasoningReplayCacheForTests();
  sent = [];
  f.config.protocols = { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } };
  for (const instance of INSTANCES) {
    f.config.providers[instance]!.models = [f.model];
  }
  f.publishConfig();
});

afterEach(async () => {
  for (const restore of restorations.splice(0).reverse()) restore();
  pacing?.resetProviderRequestPacingForTest();
  releaseSpend?.();
  releaseSpend = undefined;
  await f?.dispose();
});

async function seed(instances: readonly AnthropicInstanceId[] = INSTANCES) {
  await f.seed(instances);
  // Seed clones the pure config; attach in-process transports only after that operation.
  for (const instance of INSTANCES) f.config.providers[instance]!.fetch = transport(instance);
}

function answer(model: string): Rec {
  return { id: "msg_instance_fixture", type: "message", role: "assistant", model,
    content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 9, output_tokens: 3 } };
}

/** Responses forces streaming upstream even for a non-streaming Messages caller. */
function answerForWire(send: Sent): Response {
  if (send.body.stream !== true) return Response.json(answer(f.model));
  const frames: Rec[] = [
    { type: "message_start", message: { ...answer(f.model), content: [], stop_reason: null,
      usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture reply" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

function transport(instance: AnthropicInstanceId, response?: (send: Sent) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => {
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const slot = [1, 2].find(candidate => token === instanceFixtureCredential(instance, candidate).access);
    // Independent shared ledger detects wrong-instance physical bearer even for equal IDs.
    const parsedBody = JSON.parse(String(init?.body)) as Rec;
    const metadata = parsedBody.metadata as { user_id?: string } | undefined;
    const uuid = metadata?.user_id ? (JSON.parse(metadata.user_id) as { account_uuid?: string }).account_uuid : undefined;
    f.ledger.record({ instance, accountId: slot ? f.ids[slot - 1]! : f.ids[0], token, uuid });
    expect(headers.has("x-api-key")).toBe(false);
    expect(token).not.toBe(CALLER);
    const entry = { instance, url: String(input), headers, body: parsedBody };
    sent.push(entry);
    return response ? await response(entry) : answerForWire(entry);
  }) as typeof fetch;
}

function body(model = `anthropic2/${f.model}`, extra: Rec = {}): Rec {
  return { model, max_tokens: 64, stream: false,
    metadata: { user_id: JSON.stringify({ account_uuid: instanceFixtureUuid("anthropic", 1), device_id: "fixture-device", session_id: f.sessionKey }) },
    messages: [{ role: "user", content: "fixture question" }], ...extra };
}

async function send(model = `anthropic2/${f.model}`, extra: Rec = {}, options: { nativeCaller?: boolean; sessionKey?: string } = {}) {
  const requestId = crypto.randomUUID();
  const logCtx = { model: "", provider: "" };
  const requestBody = body(model, extra);
  if (options.sessionKey) {
    const metadata = requestBody.metadata as { user_id: string };
    metadata.user_id = JSON.stringify({ ...JSON.parse(metadata.user_id), session_id: options.sessionKey });
  }
  const response = await ingress.handleClaudeMessages(new Request("http://localhost/v1/messages", {
    // Managed parity cases use ordinary admission fixtures. Caller-forward exclusion cases
    // explicitly supply a classified Anthropic caller bearer while passthrough stays enabled.
    method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${options.nativeCaller ? CALLER : "fixture-admission-token"}`,
      "x-api-key": options.nativeCaller ? CALLER : "fixture-caller-key", "x-session-id": options.sessionKey ?? f.sessionKey },
    body: JSON.stringify(requestBody),
  }), f.config, logCtx, { requestId, start: Date.now() });
  const text = await response.text();
  const rows = logs.getRequestLogEntries().filter(row => row.requestId === requestId);
  expect(JSON.stringify(rows)).not.toContain(CALLER);
  if (existsSync(f.store.getAuthStorePath())) expect(readFileSync(f.store.getAuthStorePath(), "utf8")).not.toContain(CALLER);
  expect(JSON.stringify(f.config)).not.toContain(CALLER);
  f.ledger.assertNoCrossSend();
  return { response, text, rows };
}

function revoked() {
  return Response.json({ type: "error", error: { type: "authentication_error",
    message: "OAuth access token has been revoked." } }, { status: 401 });
}
for (const instance of INSTANCES) for (const enabled of [true, false]) {
  for (const nativeMode of [true, false]) for (const stream of [true, false]) {
    test("revoked recovery pool=" + enabled + " native=" + nativeMode + " stream=" + stream + " " + instance, async () => {
      await seed();
      if (instance === "anthropic") f.config.anthropicAccountPool = { enabled };
      else f.config.providers.anthropic2!.anthropicAccountPool = { enabled };
      f.config.protocols = { rollout: { managedMessagesNative: nativeMode, managedMessagesNativeOAuth: nativeMode } };
      f.config.providers[instance]!.fetch = transport(instance, row => sent.length === 1 ? revoked() : answerForWire(row));
      const { response, text, rows } = await send(instance + "/" + f.model, { stream });
      expect(response.status, text).toBe(200);
      expect(text).toContain("fixture reply");
      expect(sent).toHaveLength(2);
      expect(f.ledger.sends.map(row => row.accountId)).toEqual([f.ids[0], f.ids[1]]);
      expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(true);
      const other = instance === "anthropic" ? "anthropic2" : "anthropic";
      expect(f.store.getAccountCredentialWithStatus(other, f.ids[0])?.needsReauth).toBe(false);
      expect(f.store.getAccountSet(other)?.activeAccountId).toBe(f.ids[0]);
      expect(JSON.stringify(rows)).toContain("oauth-401");
      expect(rows[0]?.protocolTrace?.mode).toBe(nativeMode ? "native" : "legacy-bridge");
      if (nativeMode) expect(f.ledger.sends.map(row => row.uuid)).toEqual([
        instanceFixtureUuid(instance, 1), instanceFixtureUuid(instance, 2),
      ]);
      const subsequent = await send(instance + "/" + f.model, { stream });
      expect(subsequent.response.status).toBe(200);
      expect(sent).toHaveLength(3);
      expect(f.ledger.sends[2]!.accountId).toBe(f.ids[1]);
    });
  }
  test(instance + ": both revoked accounts retain the final upstream 401", async () => {
    await seed();
    if (instance === "anthropic") f.config.anthropicAccountPool = { enabled };
    else f.config.providers.anthropic2!.anthropicAccountPool = { enabled };
    f.config.providers[instance]!.fetch = transport(instance, () => revoked());
    const { response, text } = await send(instance + "/" + f.model);
    expect(response.status, text).toBe(401);
    expect(text).toContain("OAuth access token has been revoked.");
    expect(sent).toHaveLength(2);
    for (const id of f.ids) expect(f.store.getAccountCredentialWithStatus(instance, id)?.needsReauth).toBe(true);
    await send(instance + "/" + f.model);
    expect(sent).toHaveLength(2);
  });
  test(instance + ": unavailable sibling preserves original 401", async () => {
    await seed();
    if (instance === "anthropic") f.config.anthropicAccountPool = { enabled };
    else f.config.providers.anthropic2!.anthropicAccountPool = { enabled };
    await f.store.setAccountPaused(instance, f.ids[1], true);
    f.config.providers[instance]!.fetch = transport(instance, () => revoked());
    const { response, text } = await send(instance + "/" + f.model);
    expect(response.status, text).toBe(401);
    expect(sent).toHaveLength(1);
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(true);
  });
}
for (const instance of INSTANCES) {
  test(instance + ": stale recovery selection does not override a newer manual choice", async () => {
    await seed();
    const selection = f.store.captureOAuthAccountSelection(instance);
    await f.store.setActiveAccount(instance, f.ids[1]);
    const result = await binding.resolveNativeOAuthBindingForInstance(instance, f.config, {
      model: f.model, candidateAccountId: f.ids[0], expectedRecoverySelection: selection,
      expectedRecoveryRouteDecision: null,
    });
    expect(result.snapshot.accountId).toBe(f.ids[1]);
  });
  test(instance + ": recovery candidate still respects the current model route", async () => {
    await seed();
    const selection = f.store.captureOAuthAccountSelection(instance);
    const pool = { enabled: true, routes: [{ name: "strict", match: f.model, accounts: [f.ids[0]] }] };
    if (instance === "anthropic") f.config.anthropicAccountPool = pool;
    else f.config.providers.anthropic2!.anthropicAccountPool = pool;
    const route = (await import("../../src/oauth/anthropic-model-routes")).resolveAnthropicModelRouteForInstance(instance, f.config, f.model);
    await expect(binding.resolveNativeOAuthBindingForInstance(instance, f.config, {
      model: f.model, candidateAccountId: f.ids[1], expectedRecoverySelection: selection,
      expectedRecoveryRouteDecision: route.decision,
    })).rejects.toThrow();
    expect(sent).toHaveLength(0);
    expect(f.store.getAccountSet(instance)?.activeAccountId).toBe(f.ids[0]);
  });
}
