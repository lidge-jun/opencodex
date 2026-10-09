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

afterEach(() => {
  for (const restore of restorations.splice(0).reverse()) restore();
  pacing?.resetProviderRequestPacingForTest();
  releaseSpend?.();
  releaseSpend = undefined;
  f?.dispose();
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

describe("B managed native Messages and caller-forward exclusion", () => {
  for (const qualified of ["raw", "provider-alias", "model-map"] as const) {
    test(`${qualified} B uses B bearer and verified UUID with a caller Anthropic bearer present`, async () => {
      await seed();
      f.config.providers.anthropic2!.alias = "claude-pool-b";
      f.config.claudeCode = { modelMap: { "claude-pool-selector": `anthropic2/${f.model}` } };
      f.publishConfig();
      const selector = qualified === "raw" ? `anthropic2/${f.model}`
        : qualified === "provider-alias" ? `claude-pool-b/${f.model}` : "claude-pool-selector";
      const { response, text, rows } = await send(selector, {}, { nativeCaller: true });
      expect(response.status, text).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.instance).toBe("anthropic2");
      expect(sent[0]!.body.model).toBe(f.model);
      const metadata = sent[0]!.body.metadata as { user_id: string };
      expect(JSON.parse(metadata.user_id)).toMatchObject({ account_uuid: instanceFixtureUuid("anthropic2", 1), session_id: f.sessionKey });
      expect(rows[0]?.protocolTrace).toMatchObject({ mode: "native" });
      expect(planner.buildProtocolPlanSnapshot(f.config, { model: selector, inbound: "messages", features: [] }).reasonCodes)
        .not.toContain("caller-credential-required");
    });
  }

  test("H03 intentional A binding for requested B is caught by the shared ledger", async () => {
    await seed();
    const wrong = await binding.resolveNativeOAuthBinding(f.config, { model: f.model });
    expect(() => f.ledger.record({ instance: "anthropic2", accountId: wrong.snapshot.accountId,
      token: wrong.snapshot.accessToken, uuid: wrong.providerAccountUuid })).toThrow("wrong instance");
    expect(() => f.ledger.record({ instance: "anthropic2", accountId: f.ids[0],
      token: instanceFixtureCredential("anthropic2", 1).access, uuid: instanceFixtureUuid("anthropic", 1) })).toThrow("wrong instance");
    expect(f.ledger.sends).toHaveLength(0);
  });

  test("marked B first-party endpoint override sends by the same URL policy as A", async () => {
    await seed();
    for (const instance of INSTANCES) {
      f.config.providers[instance]!.baseUrl = "https://api.anthropic.com/fixture-endpoint/v1";
      f.publishConfig();
      const { response, text, rows } = await send(`${instance}/${f.model}`);
      expect(response.status, text).toBe(200);
      expect(rows[0]?.protocolTrace?.mode).toBe("native");
      expect(sent.at(-1)!.url).toBe("https://api.anthropic.com/fixture-endpoint/v1/messages");
    }
  });

  test("unmarked custom B key gateway keeps its own native key-auth policy", async () => {
    const provider = f.config.providers.anthropic2!;
    delete provider.anthropicOAuthInstance;
    provider.authMode = "key";
    provider.apiKey = "synthetic-custom-gateway-key";
    provider.baseUrl = "https://gateway.example/v1";
    let keySends = 0;
    provider.fetch = (async (_input, init) => {
      keySends++;
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("synthetic-custom-gateway-key");
      expect(headers.has("authorization")).toBe(false);
      return Response.json(answer(f.model));
    }) as typeof fetch;
    const { response, text } = await send();
    expect(response.status, text).toBe(200);
    expect(keySends).toBe(1);
    expect(f.ledger.sends).toHaveLength(0);
  });

  test("bare Claude retains caller-forward to A and planner's credential-required result", async () => {
    await seed();
    let callerSends = 0;
    globalThis.fetch = (async (_input, init) => {
      callerSends++;
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CALLER}`);
      return Response.json(answer(f.model));
    }) as typeof fetch;
    const response = await ingress.handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${CALLER}` },
      body: JSON.stringify(body(f.model)),
    }), f.config, { model: "", provider: "" });
    expect(response.status, await response.text()).toBe(200);
    expect(callerSends).toBe(1);
    expect(sent).toHaveLength(0);
    expect(planner.buildProtocolPlanSnapshot(f.config, { model: f.model, inbound: "messages", features: [] }).reasonCodes)
      .toContain("caller-credential-required");
  });

  for (const nativeFlag of [false, null, "true"] as const) {
    test(`native preference ${JSON.stringify(nativeFlag)} has identical A/B bridge policy`, async () => {
      await seed();
      f.config.anthropicAccountPool = { enabled: true, nativeMessages: nativeFlag } as OcxConfig["anthropicAccountPool"];
      f.config.providers.anthropic2!.anthropicAccountPool = { enabled: true, nativeMessages: nativeFlag } as OcxConfig["anthropicAccountPool"];
      f.publishConfig();
      for (const instance of INSTANCES) {
        const { response, text, rows } = await send(`${instance}/${f.model}`);
        expect(response.status, text).toBe(200);
        expect(JSON.parse(text).content).toEqual([{ type: "text", text: "fixture reply" }]);
        expect(rows[0]?.protocolTrace).toMatchObject({ mode: "legacy-bridge" });
        expect(sent.at(-1)!.body.stream).toBe(true);
        expect(sent.at(-1)!.instance).toBe(instance);
      }
    });
  }

  for (const kind of ["no-B-account", "unmarked", "disabled", "orphan"] as const) {
    test(`${kind} B cannot use A or caller credentials`, async () => {
      await seed(kind === "no-B-account" ? ["anthropic"] : INSTANCES);
      if (kind === "unmarked") delete f.config.providers.anthropic2!.anthropicOAuthInstance;
      if (kind === "disabled") f.config.providers.anthropic2!.disabled = true;
      if (kind === "orphan") delete f.config.providers.anthropic2;
      f.publishConfig();
      const { response } = await send(`anthropic2/${f.model}`, {}, { nativeCaller: true });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(sent).toHaveLength(0);
      expect(f.ledger.sends).toHaveLength(0);
      if (kind !== "no-B-account") {
        const preview = planner.buildProtocolPlanSnapshot(f.config, { model: `anthropic2/${f.model}`, inbound: "messages", features: [] });
        expect(preview.candidates).toHaveLength(0);
        expect(native.nativeMessagesCountBody(f.config, f.config.claudeCode, body(), {})).toBeUndefined();
      }
    });
  }
});

describe("pure native settings, count and preview parity", () => {
  for (const customName of ["ANTHROPIC2", "CLAUDE-POOL-B", "anthropic-custom"]) {
    test(`exact custom ${customName} precedes B aliases and keeps caller-forward preview`, async () => {
      const selectors = await import("../../src/server/messages-native-selector");
      const before = existsSync(f.store.getAuthStorePath()) ? readFileSync(f.store.getAuthStorePath(), "utf8") : null;
      f.config.providers.anthropic2!.alias = customName.toLowerCase();
      f.config.providers[customName] = { adapter: "anthropic", authMode: "key", baseUrl: "https://custom.example",
        apiKey: "fixture-custom-key", models: [f.model] };
      const model = `${customName}/${f.model}`;
      expect(selectors.messagesSelectorTargetsSecondaryInstance(f.config, model)).toBe(false);
      expect(selectors.messagesSecondaryInstanceUnavailable(f.config, model)).toBe(false);
      const custom = planner.buildProtocolPlanSnapshot(f.config, { model, inbound: "messages", features: [] });
      expect(custom.candidates[0]).toMatchObject({ provider: customName, nativeEligible: true });
      expect(custom.reasonCodes).toContain("caller-credential-required");
      expect(selectors.messagesSelectorTargetsSecondaryInstance(f.config, `anthropic2/${f.model}`)).toBe(true);

      // A disabled exact key still owns its spelling; an alias cannot adopt that selector.
      f.config.providers[customName]!.disabled = true;
      expect(selectors.messagesSelectorTargetsSecondaryInstance(f.config, model)).toBe(false);
      expect(selectors.messagesSecondaryInstanceUnavailable(f.config, model)).toBe(false);
      const disabled = planner.buildProtocolPlanSnapshot(f.config, { model, inbound: "messages", features: [] });
      expect(disabled.candidates).toHaveLength(0);
      expect(disabled.reasonCodes).toContain("caller-credential-required");

      // Without an exact key, the existing case-insensitive provider-alias rule reaches B.
      delete f.config.providers[customName];
      expect(selectors.messagesSelectorTargetsSecondaryInstance(f.config, model)).toBe(true);
      const aliased = planner.buildProtocolPlanSnapshot(f.config, { model, inbound: "messages", features: [] });
      expect(aliased.candidates[0]).toMatchObject({ provider: "anthropic2", nativeEligible: true });
      expect(aliased.reasonCodes).not.toContain("caller-credential-required");
      expect(existsSync(f.store.getAuthStorePath()) ? readFileSync(f.store.getAuthStorePath(), "utf8") : null).toBe(before);
      expect(sent).toHaveLength(0);
    });
  }

  test("orphan lowercase B does not reserve a configured uppercase custom provider", async () => {
    const selectors = await import("../../src/server/messages-native-selector");
    delete f.config.providers.anthropic2;
    f.config.providers.ANTHROPIC2 = { adapter: "anthropic", authMode: "key", baseUrl: "https://custom.example",
      apiKey: "fixture-custom-key", models: [f.model] };
    const upper = `ANTHROPIC2/${f.model}`;
    expect(selectors.messagesSelectorTargetsSecondaryInstance(f.config, upper)).toBe(false);
    expect(selectors.messagesSecondaryInstanceUnavailable(f.config, upper)).toBe(false);
    const preview = planner.buildProtocolPlanSnapshot(f.config, { model: upper, inbound: "messages", features: [] });
    expect(preview.candidates[0]?.provider).toBe("ANTHROPIC2");
    expect(preview.reasonCodes).toContain("caller-credential-required");
    expect(selectors.messagesSecondaryInstanceUnavailable(f.config, `anthropic2/${f.model}`)).toBe(true);
  });

  test("B pool never inherits A native preference and revision tracks ownership/raw policy", () => {
    delete f.config.protocols;
    f.config.anthropicAccountPool = { enabled: true, nativeMessages: false };
    f.config.providers.anthropic2!.anthropicAccountPool = { enabled: true };
    expect(settings.resolveProtocolSettings(f.config, "anthropic").rollout.managedMessagesNative).toBe(false);
    expect(settings.resolveProtocolSettings(f.config, "anthropic2").rollout.managedMessagesNative).toBe(true);
    const revision = settings.protocolPolicyRevision(f.config);
    for (const change of [
      (config: OcxConfig) => { delete config.providers.anthropic2!.anthropicOAuthInstance; },
      (config: OcxConfig) => { config.providers.anthropic2!.disabled = true; },
      (config: OcxConfig) => { config.providers.anthropic2!.anthropicAccountPool = { enabled: true, nativeMessages: false }; },
      (config: OcxConfig) => { config.providers.anthropic2!.anthropicAccountPool = null as unknown as NonNullable<OcxConfig["anthropicAccountPool"]>; },
    ]) {
      const config = structuredClone({ ...f.config, providers: Object.fromEntries(Object.entries(f.config.providers)
        .map(([name, provider]) => [name, { ...provider, fetch: undefined }])) });
      change(config);
      expect(settings.protocolPolicyRevision(config)).not.toBe(revision);
    }
  });

  test("count retains A quorum contract; A/B count and preview do not select/refresh", async () => {
    await seed();
    const commit = spyOn(f.store, "commitOAuthAccountSelection");
    restorations.push(() => commit.mockRestore());
    const oauth = await import("../../src/oauth");
    const refresh = spyOn(oauth, "getValidAccessSnapshotForAccount");
    restorations.push(() => refresh.mockRestore());
    const stored = readFileSync(f.store.getAuthStorePath(), "utf8");
    for (const instance of INSTANCES) {
      const selected = f.store.captureOAuthAccountSelection(instance);
      const quorum = f.routing.anthropicRoutingFor(instance).hasAnthropicFailoverQuorum();
      expect(quorum).toBe(true);
      const counted = native.nativeMessagesCountBody(f.config, f.config.claudeCode, body(`${instance}/${f.model}`), {});
      expect(counted?.model).toBe(f.model);
      const preview = planner.buildProtocolPlanSnapshot(f.config, { model: `${instance}/${f.model}`, inbound: "messages", features: [] });
      expect(preview.candidates[0]).toMatchObject({ provider: instance, nativeEligible: true });
      expect(f.store.captureOAuthAccountSelection(instance)).toEqual(selected);
      expect(f.routing.anthropicRoutingFor(instance).hasAnthropicFailoverQuorum()).toBe(quorum);
    }
    expect(commit).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(readFileSync(f.store.getAuthStorePath(), "utf8")).toBe(stored);
    expect(sent).toHaveLength(0);
  });

  test("first-party wire eligibility is identical for marked overrides and A", () => {
    for (const baseUrl of ["https://api.anthropic.com/v1", "https://compatible.example", "http://api.anthropic.com", "https://api.anthropic.com:8443"]) {
      const plans = INSTANCES.map(instance => {
        f.config.providers[instance]!.baseUrl = baseUrl;
        const route = { providerName: instance, provider: f.config.providers[instance]!, modelId: f.model,
          routeKind: "direct", routeReason: "fixture" } as RouteResult;
        expect(native.nativeMessagesDeclineReason(route, body(), f.config)).toBe(
          baseUrl === "https://api.anthropic.com/v1" ? undefined : "auth-mode-not-native");
        return planner.buildProtocolPlanSnapshot(f.config, { model: `${instance}/${f.model}`, inbound: "messages", features: [] });
      });
      // Public cleartext OAuth targets are refused by the router before eligibility planning.
      if (baseUrl.startsWith("http:")) {
        for (const plan of plans) { expect(plan.routeKind).toBe("unknown"); expect(plan.candidates).toHaveLength(0); }
      } else {
        for (const plan of plans) expect(plan.candidates).toHaveLength(1);
        expect(plans[1]!.candidates[0]!.nativeEligible).toBe(plans[0]!.candidates[0]!.nativeEligible);
        expect(plans[1]!.candidates[0]!.declineReasons).toEqual(plans[0]!.candidates[0]!.declineReasons);
        expect(plans[1]!.candidates[0]!.nativeEligible).toBe(baseUrl === "https://api.anthropic.com/v1");
      }
    }
  });
});

describe("binding and physical dispatch await fences", () => {
  test("manual B reselection during pacing rebuilds the whole request with B's token/UUID", async () => {
    await seed();
    const a = await binding.resolveNativeOAuthBinding(f.config, { model: f.model });
    const entered = anthropicInstanceBarrier();
    const resume = anthropicInstanceBarrier();
    const real = pacing.waitForProviderRequestSlot;
    const wait = spyOn(pacing, "waitForProviderRequestSlot").mockImplementation(async (...args) => {
      if (args[0] === "anthropic2") { entered.release(); await resume.wait; }
      return real(...args);
    });
    restorations.push(() => wait.mockRestore());
    const pending = send();
    try {
      await entered.wait;
      await f.store.setActiveAccount("anthropic2", f.ids[1]);
      f.routing.anthropicRoutingFor("anthropic2").resetAnthropicRoutingForManualSelection(f.ids[1]);
    } finally { resume.release(); }
    const { response, text } = await pending;
    expect(response.status, text).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${instanceFixtureCredential("anthropic2", 2).access}`);
    expect(JSON.parse((sent[0]!.body.metadata as { user_id: string }).user_id).account_uuid).toBe(instanceFixtureUuid("anthropic2", 2));
    expect(binding.nativeOAuthBindingIsCurrent(a)).toBe(true);
  });

  for (const change of ["marker", "disabled", "target"] as const) {
    test(`${change} replacement across admission await refuses before token resolution`, async () => {
      await seed();
      const entered = anthropicInstanceBarrier();
      const resume = anthropicInstanceBarrier();
      const real = f.routing.anthropicRoutingFor;
      const facade = real("anthropic2");
      let tokenLookups = 0;
      const scoped = { ...facade,
        resolveAnthropicDispatchAccountId: async (...args: Parameters<typeof facade.resolveAnthropicDispatchAccountId>) => {
          const id = await facade.resolveAnthropicDispatchAccountId(...args);
          entered.release(); await resume.wait; return id;
        },
        getAnthropicPoolAccessSnapshot: (...args: Parameters<typeof facade.getAnthropicPoolAccessSnapshot>) => {
          tokenLookups++; return facade.getAnthropicPoolAccessSnapshot(...args);
        },
      };
      const factory = spyOn(f.routing, "anthropicRoutingFor").mockImplementation(instance => instance === "anthropic2" ? scoped : real(instance));
      restorations.push(() => factory.mockRestore());
      const pending = binding.resolveNativeOAuthBindingForInstance("anthropic2", f.config, { model: f.model });
      try {
        await entered.wait;
        if (change === "marker") delete f.config.providers.anthropic2!.anthropicOAuthInstance;
        if (change === "disabled") f.config.providers.anthropic2!.disabled = true;
        if (change === "target") f.config.providers.anthropic2!.baseUrl = "https://api.anthropic.com/replacement";
      } finally { resume.release(); }
      await expect(pending).rejects.toThrow(binding.NativeOAuthSelectionChangedError);
      expect(tokenLookups).toBe(0);
      expect(sent).toHaveLength(0);
    });
  }

  test("a provider UUID replacement invalidates only that instance's binding", async () => {
    await seed();
    const a = await binding.resolveNativeOAuthBinding(f.config, { model: f.model });
    const b = await binding.resolveNativeOAuthBindingForInstance("anthropic2", f.config, { model: f.model });
    const credential = f.store.getAccountCredential("anthropic2", b.snapshot.accountId)!;
    const replacementUuid = "55555555-5555-4555-8555-555555555555";
    await f.store.saveAccountCredential("anthropic2", b.snapshot.accountId, { ...credential,
      accountId: replacementUuid,
      anthropicIdentity: identity.bindAnthropicIdentity(credential.access, replacementUuid) });
    expect(binding.nativeOAuthBindingIsCurrent(b)).toBe(false);
    expect(binding.nativeOAuthBindingIsCurrent(a)).toBe(true);
  });

  test("A binding follows routed adapter/auth normalization while B keeps its raw row shape", async () => {
    await seed();
    const canonical = await binding.resolveNativeOAuthBinding(f.config, { model: f.model });
    // Routing canonicalizes the primary row from the registry, so a legacy adapter/auth field is not a lane change.
    f.config.providers.anthropic!.adapter = "openai-chat";
    delete f.config.providers.anthropic!.authMode;
    const legacy = await binding.resolveNativeOAuthBinding(f.config, { model: f.model, routeTarget: canonical.routeTarget });
    expect(legacy.instance).toBe("anthropic");
    expect(legacy.routeTarget).toBe(canonical.routeTarget);
    f.config.providers.anthropic2!.adapter = "openai-chat";
    await expect(binding.resolveNativeOAuthBindingForInstance("anthropic2", f.config, { model: f.model }))
      .rejects.toThrow(binding.NativeOAuthSelectionChangedError);
  });

  test("a legacy primary adapter field still reaches one physical A send", async () => {
    await seed();
    f.config.providers.anthropic!.adapter = "openai-chat";
    delete f.config.providers.anthropic!.authMode;
    const before = f.ledger.sends.length;
    const { response } = await send(`anthropic/${f.model}`);
    expect(response.status).toBe(200);
    expect(f.ledger.sends.slice(before).map(row => row.instance)).toEqual(["anthropic"]);
  });

  for (const change of ["marker", "target", "native-off"] as const) {
    test(`${change} mutation while pacing prevents physical send`, async () => {
      await seed();
      const entered = anthropicInstanceBarrier();
      const resume = anthropicInstanceBarrier();
      const real = pacing.waitForProviderRequestSlot;
      const wait = spyOn(pacing, "waitForProviderRequestSlot").mockImplementation(async (...args) => {
        if (args[0] === "anthropic2") { entered.release(); await resume.wait; }
        return real(...args);
      });
      restorations.push(() => wait.mockRestore());
      const pending = send();
      try {
        await entered.wait;
        if (change === "marker") delete f.config.providers.anthropic2!.anthropicOAuthInstance;
        if (change === "target") f.config.providers.anthropic2!.baseUrl = "https://api.anthropic.com/replacement";
        if (change === "native-off") f.config.protocols!.rollout!.managedMessagesNativeOAuth = false;
      } finally { resume.release(); }
      const { response } = await pending;
      expect(response.status).toBe(409);
      expect(sent).toHaveLength(0);
    });
  }
});

describe("native recovery stays in the sending instance", () => {
  for (const fallback of [false, true]) test(`B model-route fallback=${fallback} widens only inside B`, async () => {
    await seed();
    f.config.providers.anthropic2!.anthropicAccountPool = { enabled: true,
      routes: [{ name: "fixture-only-first", match: "claude-sonnet-*", accounts: [f.ids[0]], fallback }] };
    f.publishConfig();
    f.config.providers.anthropic2!.fetch = transport("anthropic2", () => sent.length === 1
      ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture quota" } }, {
        status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" },
      }) : Response.json(answer(f.model)));
    const { response } = await send();
    expect(response.status).toBe(fallback ? 200 : 429);
    expect(sent).toHaveLength(fallback ? 2 : 1);
    expect(sent.every(entry => entry.instance === "anthropic2")).toBe(true);
    expect(f.routing.anthropicRoutingFor("anthropic").getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
  });

  test("B family lease denial precedes send accounting and leaves A untouched", async () => {
    await seed();
    const real = f.modelQuota.anthropicModelQuotaFor;
    const requested: AnthropicInstanceId[] = [];
    const factory = spyOn(f.modelQuota, "anthropicModelQuotaFor").mockImplementation(instance => {
      requested.push(instance);
      const facade = real(instance);
      return instance === "anthropic2" ? { ...facade, claimAnthropicFamilyRevalidation: () => null } : facade;
    });
    restorations.push(() => factory.mockRestore());
    const { response, rows } = await send();
    expect(response.status).toBe(429);
    expect(requested).toContain("anthropic2");
    expect(sent).toHaveLength(0);
    expect(rows[0]?.attempts?.reduce((sum, attempt) => sum + attempt.sendCount, 0) ?? 0).toBe(0);
    expect(f.routing.anthropicRoutingFor("anthropic").getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
  });

  for (const status of [403, 429] as const) {
    test(`pool-off B ${status} recovery changes only B and rebuilds verified metadata`, async () => {
      await seed();
      f.config.providers.anthropic2!.fetch = transport("anthropic2", () => sent.length === 1
        ? Response.json({ type: "error", error: status === 403
          ? { type: "permission_error", message: "Your account does not have access to Claude Code" }
          : { type: "rate_limit_error", message: "fixture quota" } }, {
          status, headers: status === 429 ? { "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-utilization": "1",
            "anthropic-ratelimit-unified-5h-reset": String(Math.ceil(Date.now() / 1000) + 3600), "retry-after": "30" } : {},
        }) : Response.json(answer(f.model)));
      const aSelection = f.store.captureOAuthAccountSelection("anthropic");
      const { response, text, rows } = await send();
      expect(response.status, text).toBe(200);
      expect(rows[0]?.protocolTrace?.mode).toBe("native");
      expect(sent.map(entry => entry.instance)).toEqual(["anthropic2", "anthropic2"]);
      expect(sent.map(entry => entry.headers.get("authorization"))).toEqual([1, 2]
        .map(slot => `Bearer ${instanceFixtureCredential("anthropic2", slot).access}`));
      expect(sent.map(entry => JSON.parse((entry.body.metadata as { user_id: string }).user_id).account_uuid))
        .toEqual([instanceFixtureUuid("anthropic2", 1), instanceFixtureUuid("anthropic2", 2)]);
      expect(f.store.captureOAuthAccountSelection("anthropic")).toEqual(aSelection);
      expect(f.routing.anthropicRoutingFor("anthropic").getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
      expect(f.routing.anthropicRoutingFor("anthropic2").getAnthropicAccountHealthSnapshot(f.ids[0])).not.toBeNull();
      if (status === 429) {
        expect(f.quota.getCachedProviderAccountQuota("anthropic", f.ids[0])).toBeNull();
        expect(f.quota.getCachedProviderAccountQuota("anthropic2", f.ids[0])).toMatchObject({ fiveHourPercent: 100 });
      }
    });
  }

  test("a request error after the first output cannot trigger account replay", async () => {
    await seed();
    f.config.providers.anthropic2!.fetch = transport("anthropic2", () => {
      const frames = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...answer(f.model), content: [], stop_reason: null } })}\n\n`,
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first output"}}\n\n',
        'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"fixture after output"}}\n\n',
      ];
      return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const { response, text } = await send(`anthropic2/${f.model}`, { stream: true });
    expect(response.status).toBe(200);
    expect(text).toContain("first output");
    expect(sent).toHaveLength(1);
    expect(f.routing.anthropicRoutingFor("anthropic2").getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
  });
});

describe("native physical response incarnation ownership", () => {
  for (const instance of INSTANCES) for (const reserved of [false, true]) for (const status of [200, 403, 429] as const) {
    test(`${instance}: pending ${status}, prior reservation=${reserved}, identical re-add cannot own the old response`, async () => {
      await seed();
      const [recovery, cache, sweeper] = await Promise.all([
        import("../../src/providers/quota/anthropic-cooldown-recovery"),
        import("../../src/providers/quota/account-cache"),
        import("../../src/lib/state-store-sweeper"),
      ]);
      const other = instance === "anthropic" ? "anthropic2" : "anthropic";
      const id = f.ids[0];
      const original = structuredClone(f.store.getAccountSet(instance)!.accounts.find(row => row.id === id)!);
      const ownRecovery = recovery.anthropicCooldownRecoveryFor(instance);
      const siblingRecovery = recovery.anthropicCooldownRecoveryFor(other);
      const family = f.modelQuota.anthropicModelQuotaFor(instance);
      const ownRouting = f.routing.anthropicRoutingFor(instance);
      const siblingRouting = f.routing.anthropicRoutingFor(other);
      if (reserved) {
        ownRecovery.anthropicCooldownFlightKey("fixture-existing-reservation", id);
        ownRecovery.reserveAnthropicAccountIncarnation(id);
      }
      const priorIncarnation = ownRecovery.anthropicAccountIncarnation(id);
      const siblingGeneration = siblingRecovery.anthropicCooldownGeneration(id);
      const siblingSelection = f.store.captureOAuthAccountSelection(other);
      const siblingCredential = structuredClone(f.store.getAccountCredential(other, id)!);
      const entered = anthropicInstanceBarrier();
      const resume = anthropicInstanceBarrier();
      const freshEntered = anthropicInstanceBarrier();
      const freshResume = anthropicInstanceBarrier();
      f.config.providers[instance]!.fetch = transport(instance, async () => {
        if (sent.length > 1) {
          freshEntered.release();
          await freshResume.wait;
          return Response.json(answer(f.model), { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.42" } });
        }
        entered.release();
        await resume.wait;
        const headers = { "anthropic-ratelimit-unified-5h-utilization": "0.81",
          ...(status === 429 ? { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" } : {}) };
        return status === 200 ? Response.json(answer(f.model), { headers }) : Response.json({ type: "error", error: status === 403
          ? { type: "permission_error", message: "Your account does not have access to Claude Code" }
          : { type: "rate_limit_error", message: "fixture retired quota" } }, { status, headers });
      });
      let contextGeneration = sweeper.captureConfigGeneration() + 100;
      const reconcile = () => {
        const context: GenerationContext = { generation: ++contextGeneration,
          providerNames: new Set(INSTANCES), oauthAccountKeys: new Set(INSTANCES.flatMap(pool =>
            f.store.getAccountSet(pool)!.accounts.map(row => cache.accountCacheKey(pool, row.id)))),
          comboIds: new Set(), comboTargets: new Set(), codexAccountIds: new Set(), configRoots: new Set() };
        f.modelQuota.reconcileAllAnthropicFamilyQuota(context);
        f.ratePolicy.reconcileAllAnthropicRatePauses(context);
        recovery.reconcileAllAnthropicCooldownGenerations(context);
        cache.reconcileProviderAccountQuotaRows(context);
        f.routing.reconcileAnthropicRoutingState(context, f.config);
      };
      const oldWriterGeneration = sweeper.captureConfigGeneration();
      let freshPending: ReturnType<typeof send> | undefined;
      const pending = send(`${instance}/${f.model}`);
      try {
        await Promise.race([entered.wait, pending.then(() => { throw new Error("native request ended before physical fetch barrier"); })]);
        try {
          expect(sent).toHaveLength(1);
          expect(sent[0]!.instance).toBe(instance);
          if (reserved) expect(ownRecovery.anthropicAccountIncarnation(id)).toBe(priorIncarnation);
          else expect(ownRecovery.anthropicAccountIncarnation(id)).toBeGreaterThan(priorIncarnation);
          await f.store.removeAccount(instance, id);
          reconcile();
          expect(ownRecovery.anthropicAccountIncarnation(id)).toBeGreaterThan(priorIncarnation);
          // Copy the complete original row so credential bytes, UUID, login metadata and expiry
          // all match; the response must be rejected by the send incarnation rather than hashes.
          await f.store.mutateStore(auth => {
            auth[instance]!.accounts.unshift(structuredClone(original));
            auth[instance]!.activeAccountId = id;
          });
          reconcile();
          expect(f.store.getAccountCredential(instance, id)).toEqual(original.credential);
          expect(cache.mayCommitAccountQuotaKey(cache.accountCacheKey(instance, id), oldWriterGeneration)).toBe(true);
          cache.setCachedProviderAccountQuotaForTests(instance, id, { fiveHourPercent: 17, updatedAt: Date.now() });
          cache.setCachedProviderAccountQuotaForTests(other, id, { fiveHourPercent: 23, updatedAt: Date.now() });
          family.observeAnthropicFamilyQuota(id, [{ label: "Sonnet", scope: "model", percent: 100,
            rejected: true, resetAt: Date.now() + 60_000 }], Date.now());
        } finally { resume.release(); }
        const familyGeneration = family.anthropicFamilyQuotaGeneration(id);
        const ownGeneration = ownRecovery.anthropicCooldownGeneration(id);
        const replacementSelection = f.store.captureOAuthAccountSelection(instance);
        const { response, text } = await pending;
        expect(response.status, text).toBe(status);
        expect(sent).toHaveLength(1);
        expect(cache.getCachedProviderAccountQuota(instance, id)?.fiveHourPercent).toBe(17);
        expect(family.anthropicFamilyRejected(id, f.model)).toBe(true);
        expect(family.anthropicFamilyQuotaGeneration(id)).toBe(familyGeneration);
        expect(ownRecovery.anthropicCooldownGeneration(id)).toBe(ownGeneration);
        expect(ownRouting.getAnthropicAccountHealthSnapshot(id)).toBeNull();
        expect(f.ratePolicy.anthropicRatePolicyFor(instance).anthropicRatePauseUntil(id)).toBeUndefined();
        expect(f.store.captureOAuthAccountSelection(instance)).toEqual(replacementSelection);
        expect(cache.getCachedProviderAccountQuota(other, id)?.fiveHourPercent).toBe(23);
        expect(siblingRecovery.anthropicCooldownGeneration(id)).toBe(siblingGeneration);
        expect(siblingRouting.getAnthropicAccountHealthSnapshot(id)).toBeNull();
        expect(f.ratePolicy.anthropicRatePolicyFor(other).anthropicRatePauseUntil(id)).toBeUndefined();
        expect(f.store.captureOAuthAccountSelection(other)).toEqual(siblingSelection);
        expect(f.store.getAccountCredential(other, id)).toEqual(siblingCredential);

        // A newly dispatched response still has publication authority for the replacement.
        family.clearAnthropicRequestedFamilyQuota(id, f.model);
        freshPending = send(`${instance}/${f.model}`);
        try {
          await Promise.race([freshEntered.wait, freshPending.then(() => { throw new Error("fresh native request ended before fetch barrier"); })]);
          family.observeAnthropicFamilyQuota(id, [{ label: "Sonnet", scope: "model", percent: 100,
            rejected: true, resetAt: Date.now() + 60_000 }], Date.now());
        } finally { freshResume.release(); }
        const fresh = await freshPending;
        expect(fresh.response.status, fresh.text).toBe(200);
        expect(sent).toHaveLength(2);
        expect(sent[1]!.headers.get("authorization")).toBe(sent[0]!.headers.get("authorization"));
        expect(sent[1]!.body.metadata).toEqual(sent[0]!.body.metadata);
        expect(cache.getCachedProviderAccountQuota(instance, id)?.fiveHourPercent).toBe(42);
        expect(family.anthropicFamilyRejected(id, f.model)).toBe(false);
        expect(cache.getCachedProviderAccountQuota(other, id)?.fiveHourPercent).toBe(23);
        f.ledger.assertNoCrossSend();
      } finally {
        resume.release();
        freshResume.release();
        await pending.catch(() => {});
        await freshPending?.catch(() => {});
        cache.resetProviderQuotaReconcileStateForTests();
      }
    });
  }
});

describe("A/B native wire features", () => {
  test("translated opaque replay is retained for one serving identity and omitted after a pool switch", async () => {
    await seed();
    f.config.protocols!.rollout!.managedMessagesNativeOAuth = false;
    f.publishConfig();
    const replay = { messages: [{ role: "assistant", content: [
      { type: "thinking", thinking: "fixture reasoning", signature: "synthetic-thinking-signature" },
      { type: "redacted_thinking", data: "synthetic-redacted-data" },
      { type: "text", text: "fixture earlier response" },
    ] }, { role: "user", content: "continue" }] };
    const sessionKey = "fixture-opaque-pool-switch";
    for (const instance of ["anthropic", "anthropic", "anthropic2"] as const) {
      const result = await send(`${instance}/${f.model}`, replay, { sessionKey });
      expect(result.response.status, result.text).toBe(200);
      const observed = JSON.stringify(sent.at(-1)!.body.messages);
      expect(observed).toContain("fixture earlier response");
      if (instance === "anthropic") {
        expect(observed).toContain("synthetic-thinking-signature");
        expect(observed).toContain("synthetic-redacted-data");
      } else {
        expect(observed).not.toContain("synthetic-thinking-signature");
        expect(observed).not.toContain("synthetic-redacted-data");
      }
    }
  });
  const signature = "synthetic-thinking-signature";
  const cases: Array<{ label: string; extra: Rec; inspect: (wire: Rec) => unknown }> = [
    { label: "images", extra: {
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } },
        { type: "text", text: "fixture image" }] }],
    }, inspect: wire => wire.messages },
    { label: "thinking signatures and redacted blocks", extra: {
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "fixture reasoning", signature },
        { type: "redacted_thinking", data: "synthetic-redacted-data" },
        { type: "text", text: "fixture earlier response" },
      ] }, { role: "user", content: "continue" }],
    }, inspect: wire => wire.messages },
    { label: "tools, parallel uses and tool results", extra: {
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "fixture" }, { role: "assistant", content: [
        { type: "tool_use", id: "toolu_one", name: "lookup", input: {} },
        { type: "tool_use", id: "toolu_two", name: "lookup", input: {} },
      ] }, { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_one", content: "first" },
        { type: "tool_result", tool_use_id: "toolu_two", content: "second" },
      ] }],
    }, inspect: wire => ({ tools: wire.tools, messages: wire.messages }) },
    { label: "cache markers and TTL", extra: {
      system: [{ type: "text", text: "fixture cached prefix", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }] }],
    }, inspect: wire => ({ system: (wire.system as Rec[]).filter(block => block.text === "fixture cached prefix"), messages: wire.messages }) },
  ];
  for (const feature of cases) test(`${feature.label} have A/B parity on both native and translated lanes`, async () => {
    await seed();
    for (const nativeLane of [true, false]) {
      const wires: Rec[] = [];
      for (const instance of INSTANCES) {
        f.config.protocols!.rollout!.managedMessagesNativeOAuth = nativeLane;
        f.publishConfig();
        // Independent parity scenarios must not look like a provider switch in one conversation.
        const { response, text } = await send(`${instance}/${f.model}`, feature.extra,
          { sessionKey: `${f.sessionKey}-${instance}-${nativeLane}` });
        expect(response.status, text).toBe(200);
        expect(JSON.parse(text).content).toEqual([{ type: "text", text: "fixture reply" }]);
        const wire = sent.at(-1)!.body;
        expect(wire.stream).toBe(!nativeLane);
        const normalized = structuredClone(wire);
        const metadata = normalized.metadata as { user_id?: string } | undefined;
        if (metadata?.user_id) {
          const user = JSON.parse(metadata.user_id) as Rec;
          if (user.account_uuid) user.account_uuid = "normalized-provider-uuid";
          if (user.session_id) user.session_id = "normalized-conversation-id";
          metadata.user_id = JSON.stringify(user);
        }
        // Normalize the explicit fixture UUID/conversation mapping, preserving the complete wire structure.
        wires.push(normalized);
        const serialized = JSON.stringify(feature.inspect(wire));
        if (feature.label.startsWith("thinking")) {
          expect(serialized).toContain(signature);
          expect(serialized).toContain("synthetic-redacted-data");
        }
        if (feature.label.startsWith("tools")) {
          expect(serialized).toContain("custom_lookup");
          expect(serialized).toContain("toolu_one");
          expect(serialized).toContain("toolu_two");
        }
        // The established translated lane tolerates cache marker degradation; native preserves it.
        if (nativeLane && feature.label.startsWith("cache")) expect(serialized).toContain('"ttl":"1h"');
      }
      expect(wires[1]).toEqual(wires[0]);
    }
  });
});
