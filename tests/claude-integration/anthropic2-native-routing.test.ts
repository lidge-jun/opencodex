import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { OcxConfig } from "../../src/types";
import {
  anthropicInstanceBarrier, createAnthropicInstanceFixture, instanceFixtureCredential, instanceFixtureUuid,
  type AnthropicInstanceFixture,
} from "../helpers/anthropic-instance-fixture";

type Rec = Record<string, unknown>;
type Sent = { instance: AnthropicInstanceId; url: string; headers: Headers; body: Rec };
const INSTANCES = ["anthropic", "anthropic2"] as const;
const CALLER = "sk-ant-synthetic-caller-never-forward";
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
    return response ? await response(entry) : Response.json(answer(f.model));
  }) as typeof fetch;
}

function body(model = `anthropic2/${f.model}`, extra: Rec = {}): Rec {
  return { model, max_tokens: 64, stream: false,
    metadata: { user_id: JSON.stringify({ account_uuid: instanceFixtureUuid("anthropic", 1), device_id: "fixture-device", session_id: f.sessionKey }) },
    messages: [{ role: "user", content: "fixture question" }], ...extra };
}

async function send(model = `anthropic2/${f.model}`, extra: Rec = {}) {
  const requestId = crypto.randomUUID();
  const logCtx = { model: "", provider: "" };
  const response = await ingress.handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${CALLER}`,
      "x-api-key": CALLER, "x-session-id": f.sessionKey },
    body: JSON.stringify(body(model, extra)),
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
      const { response, text, rows } = await send(selector);
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
        expect(rows[0]?.protocolTrace).toMatchObject({ mode: "legacy-bridge" });
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
      const { response } = await send();
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
      const candidates = INSTANCES.map(instance => {
        f.config.providers[instance]!.baseUrl = baseUrl;
        return planner.buildProtocolPlanSnapshot(f.config, { model: `${instance}/${f.model}`, inbound: "messages", features: [] }).candidates[0]!;
      });
      expect(candidates[1]!.nativeEligible).toBe(candidates[0]!.nativeEligible);
      expect(candidates[1]!.declineReasons).toEqual(candidates[0]!.declineReasons);
      expect(candidates[1]!.nativeEligible).toBe(baseUrl === "https://api.anthropic.com/v1");
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
          status, headers: status === 429 ? { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" } : {},
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
        expect(f.quota.getCachedProviderAccountQuota("anthropic2", f.ids[0])).not.toBeNull();
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

describe("A/B native wire features", () => {
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
        const { response, text } = await send(`${instance}/${f.model}`, feature.extra);
        expect(response.status, text).toBe(200);
        const wire = sent.at(-1)!.body;
        const normalized = structuredClone(wire);
        const metadata = normalized.metadata as { user_id?: string } | undefined;
        if (metadata?.user_id) {
          const user = JSON.parse(metadata.user_id) as Rec;
          if (user.account_uuid) user.account_uuid = "normalized-provider-uuid";
          metadata.user_id = JSON.stringify(user);
        }
        // Compare complete A/B upstream bodies in each lane; only provider UUID is normalized.
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
