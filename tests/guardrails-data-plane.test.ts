import { afterEach, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import {
  GuardrailsOutputCapacityError,
  demaskGuardrailsJsonPayload,
  demaskGuardrailsResponse,
  extendGuardrailsTurnText,
  prepareGuardrailsTurn,
  rescanGuardrailsResponsesBody,
  restoreGuardrailsResponsesParsedRequest,
} from "../src/guardrails/turn";
import { GuardrailsDemaskCapacityError } from "../src/guardrails/placeholders";
import { guardrailsSseDemaskRewrite } from "../src/guardrails/sse-demask";
import { clearGuardrailsContinuationsForTests } from "../src/guardrails/continuations";
import {
  compileGuardrailsRuntimeSnapshot,
  publishGuardrailsRuntimeSnapshot,
} from "../src/guardrails/runtime";
import {
  clearGuardrailsTelemetryForTests,
  guardrailsActivity,
} from "../src/guardrails/telemetry";
import { expandPreviousResponseInput } from "../src/responses/state";
import { parseRequest } from "../src/responses/parser";
import { handleResponses } from "../src/server/responses/core";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const originalFetch = globalThis.fetch;
const STALE_INTEGRITY_HEADERS = [
  "content-md5",
  "content-digest",
  "digest",
  "etag",
  "repr-digest",
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGuardrailsContinuationsForTests();
  clearGuardrailsTelemetryForTests();
});

function config(): OcxConfig {
  const provider = {
    ...providerConfigSeed(getProviderRegistryEntry("deepseek")!),
    apiKey: "test-key",
  } as OcxProviderConfig;
  return {
    defaultProvider: "deepseek",
    providers: { deepseek: provider },
    guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" },
  } as unknown as OcxConfig;
}

function request(input: string, stream = false): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", input, stream }),
  });
}

test("disabled Guardrails is byte-identical to baseline for every inbound walker", async () => {
  const baseline = config();
  delete baseline.guardrails;
  const disabled = config();
  disabled.guardrails = { enabled: false };
  const cases: Array<{
    body: Record<string, unknown>;
    protocol: "anthropic" | "chat" | "responses";
  }> = [
    {
      protocol: "responses",
      body: {
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "sk_live_abcdefghijklmnopqrstuvwx" }],
        }],
      },
    },
    {
      protocol: "chat",
      body: {
        messages: [{
          role: "user",
          content: "sk_live_abcdefghijklmnopqrstuvwx",
        }],
      },
    },
    {
      protocol: "anthropic",
      body: {
        system: "sk_live_abcdefghijklmnopqrstuvwx",
        messages: [{
          role: "user",
          content: [{ type: "text", text: "sk_live_abcdefghijklmnopqrstuvwx" }],
        }],
      },
    },
  ];

  for (const item of cases) {
    const baselineBody = structuredClone(item.body);
    const disabledBody = structuredClone(item.body);
    const baselineResult = await prepareGuardrailsTurn(
      baseline,
      item.protocol,
      baselineBody,
    );
    const disabledResult = await prepareGuardrailsTurn(
      disabled,
      item.protocol,
      disabledBody,
    );

    expect(baselineResult.turn, item.protocol).toBeUndefined();
    expect(disabledResult.turn, item.protocol).toBeUndefined();
    expect(JSON.stringify(disabledResult.body), item.protocol)
      .toBe(JSON.stringify(baselineResult.body));
    expect(JSON.stringify(disabledResult.body), item.protocol)
      .toBe(JSON.stringify(item.body));
  }
});

test("disabled Guardrails matches baseline Responses JSON and SSE handlers", async () => {
  const baseline = config();
  delete baseline.guardrails;
  const disabled = config();
  disabled.guardrails = { enabled: false };
  const upstreamBodies: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    upstreamBodies.push(body);
    const parsed = JSON.parse(body) as { stream?: boolean };
    if (parsed.stream === true) {
      return new Response([
        "event: response.output_text.delta\n",
        "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"baseline\"}\n\n",
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-disabled-sse\",\"status\":\"completed\",\"output\":[]}}\n\n",
      ].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "resp-disabled-json",
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "baseline" }],
      }],
    });
  }) as typeof fetch;

  for (const stream of [false, true]) {
    const baselineResponse = await handleResponses(
      request("sk_live_abcdefghijklmnopqrstuvwx", stream),
      baseline,
      { model: "", provider: "" },
    );
    const disabledResponse = await handleResponses(
      request("sk_live_abcdefghijklmnopqrstuvwx", stream),
      disabled,
      { model: "", provider: "" },
    );
    const baselineBody = await baselineResponse.text();
    const disabledBody = await disabledResponse.text();
    const captured = upstreamBodies.splice(0, 2);

    expect(disabledResponse.status, `stream=${stream}`).toBe(baselineResponse.status);
    expect(disabledResponse.headers.get("content-type"), `stream=${stream}`)
      .toBe(baselineResponse.headers.get("content-type"));
    expect(disabledBody, `stream=${stream}`).toBe(baselineBody);
    expect(captured[1], `stream=${stream}`).toBe(captured[0]);
  }
});

test("Guardrails masks Responses input upstream and demasks a JSON response to the client", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  let upstreamBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return Response.json({
      id: "resp-guardrails-json",
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "echo <STRIPE_ACCESS_TOKEN_1>" }],
      }],
    }, {
      headers: Object.fromEntries(STALE_INTEGRITY_HEADERS.map(name => [name, "stale"])),
    });
  }) as typeof fetch;

  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request(secret), config(), logCtx);
  expect(upstreamBody).toMatchObject({ input: "<STRIPE_ACCESS_TOKEN_1>" });
  expect(JSON.stringify(await response.json())).toContain(secret);
  expect(JSON.stringify(upstreamBody)).not.toContain(secret);
  expect(logCtx.sensitiveDataProtectionActive).toBe(true);
  for (const name of STALE_INTEGRITY_HEADERS) expect(response.headers.get(name)).toBeNull();
});

test("password assignment separators cannot bypass prepared upstream masking", async () => {
  const password = "qwerty";
  const cases = [
    `password > ${password}`,
    `password{${password}}`,
    `password: ${password}`,
    `password=${password}`,
  ] as const;

  for (const input of cases) {
    const prepared = await prepareGuardrailsTurn(config(), "responses", { input });
    const serialized = JSON.stringify(prepared.body);

    expect(serialized, input).toContain("<OPENCODEX_PASSWORD_1>");
    expect(serialized, input).not.toContain(password);
  }
});

test("provider scope leaves an excluded Responses route unchanged", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  let upstreamBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return Response.json({
      id: "resp-guardrails-excluded",
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "literal <STRIPE_ACCESS_TOKEN_1>" }],
      }],
    });
  }) as typeof fetch;
  const scoped = config();
  scoped.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["other"],
  };

  const response = await handleResponses(
    request(secret),
    scoped,
    { model: "", provider: "" },
  );
  const responseText = JSON.stringify(await response.json());

  expect(upstreamBody).toMatchObject({ input: secret });
  expect(JSON.stringify(upstreamBody)).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(responseText).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(responseText).not.toContain(`literal ${secret}`);
});

test("mixed-scope combo children reuse one protected body and final child demasks once", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const comboConfig = config();
  comboConfig.providers.backup = {
    ...comboConfig.providers.deepseek!,
    apiKey: "backup-key",
  };
  comboConfig.combos = {
    guarded: {
      strategy: "failover",
      targets: [
        { provider: "deepseek", model: "deepseek-v4-flash" },
        { provider: "backup", model: "deepseek-v4-flash" },
      ],
    },
  };
  comboConfig.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["deepseek"],
  };
  const upstreamBodies: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBodies.push(String(init?.body ?? ""));
    if (upstreamBodies.length === 1) {
      return Response.json({ error: { message: "candidate unavailable" } }, { status: 404 });
    }
    return Response.json({
      id: "chatcmpl-guardrails-combo",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "echo <STRIPE_ACCESS_TOKEN_1>",
        },
        finish_reason: "stop",
      }],
    });
  }) as typeof fetch;
  const comboRequest = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/guarded", input: secret }),
  });

  const response = await handleResponses(
    comboRequest,
    comboConfig,
    { model: "", provider: "" },
  );

  expect(upstreamBodies).toHaveLength(2);
  expect(upstreamBodies.every(body => body.includes("<STRIPE_ACCESS_TOKEN_1>"))).toBe(true);
  expect(upstreamBodies.every(body => !body.includes(secret))).toBe(true);
  expect(JSON.stringify(await response.json())).toContain(secret);
});

test("mixed-scope combo keeps its parent runtime snapshot pinned across hot reload", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const comboConfig = config();
  comboConfig.providers.backup = {
    ...comboConfig.providers.deepseek!,
    apiKey: "backup-key",
  };
  comboConfig.combos = {
    "guarded-hot-reload": {
      strategy: "failover",
      targets: [
        { provider: "deepseek", model: "deepseek-v4-flash" },
        { provider: "backup", model: "deepseek-v4-flash" },
      ],
    },
  };
  comboConfig.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["deepseek"],
  };
  publishGuardrailsRuntimeSnapshot(
    comboConfig,
    compileGuardrailsRuntimeSnapshot(comboConfig.guardrails!),
  );
  const upstreamBodies: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBodies.push(String(init?.body ?? ""));
    if (upstreamBodies.length === 1) {
      publishGuardrailsRuntimeSnapshot(
        comboConfig,
        compileGuardrailsRuntimeSnapshot({
          ...comboConfig.guardrails!,
          disabledBuiltinRuleIds: ["stripe-access-token"],
        }),
      );
      return Response.json({ error: { message: "candidate unavailable" } }, { status: 404 });
    }
    return Response.json({
      id: "chatcmpl-guardrails-combo-hot-reload",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "echo <STRIPE_ACCESS_TOKEN_1>",
        },
        finish_reason: "stop",
      }],
    });
  }) as typeof fetch;

  try {
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/guarded-hot-reload", input: secret }),
      }),
      comboConfig,
      { model: "", provider: "" },
    );

    expect(response.status).toBe(200);
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies.every(body => body.includes("<STRIPE_ACCESS_TOKEN_1>"))).toBe(true);
    expect(upstreamBodies.every(body => !body.includes(secret))).toBe(true);
    expect(await response.text()).toContain(secret);
  } finally {
    publishGuardrailsRuntimeSnapshot(comboConfig, undefined);
  }
});

test("provider scope leaves an all-excluded combo unchanged", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const comboConfig = config();
  comboConfig.combos = {
    excluded: {
      strategy: "failover",
      targets: [
        { provider: "deepseek", model: "deepseek-v4-flash" },
      ],
    },
  };
  comboConfig.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["other"],
  };
  let upstreamBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBody = String(init?.body ?? "");
    return Response.json({
      id: "resp-guardrails-combo-excluded",
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "literal <STRIPE_ACCESS_TOKEN_1>" }],
      }],
    });
  }) as typeof fetch;

  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/excluded", input: secret }),
    }),
    comboConfig,
    { model: "", provider: "" },
  );
  const responseText = JSON.stringify(await response.json());

  expect(upstreamBody).toContain(secret);
  expect(upstreamBody).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(responseText).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(responseText).not.toContain(`literal ${secret}`);
});

test("Guardrails sibling turn snapshots consume one aggregate semantic ledger", async () => {
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: "initial" });
  const parent = prepared.turn!;
  const first = extendGuardrailsTurnText("a".repeat(32 * 1024), parent);
  const second = extendGuardrailsTurnText("b".repeat(32 * 1024), parent);

  expect(first.turn.ledger).toBe(parent.ledger);
  expect(second.turn.ledger).toBe(parent.ledger);
  expect(parent.ledger.scannedTextBytes).toBe(
    Buffer.byteLength("initial") + 64 * 1024,
  );
});

test("Guardrails preserves SSE framing while demasking streamed payload JSON", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  globalThis.fetch = (async () => new Response([
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"echo <STRIPE_ACCESS_TOKEN_1>\"}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-guardrails-sse\",\"status\":\"completed\",\"output\":[]}}\n\n",
  ].join(""), {
    headers: {
      "content-type": "text/event-stream",
      ...Object.fromEntries(STALE_INTEGRITY_HEADERS.map(name => [name, "stale"])),
    },
  })) as typeof fetch;

  const response = await handleResponses(request(secret, true), config(), { model: "", provider: "" });
  const text = await response.text();
  expect(text).toContain("event: response.output_text.delta");
  expect(text).toContain(secret);
  expect(text).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
  for (const name of STALE_INTEGRITY_HEADERS) expect(response.headers.get(name)).toBeNull();
});

test("Guardrails demasks a placeholder split across Responses SSE delta events", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  globalThis.fetch = (async () => new Response([
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"echo <STRIPE_ACCESS\"}\n\n",
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"_TOKEN_1>\"}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-guardrails-sse-split\",\"status\":\"completed\",\"output\":[]}}\n\n",
  ].join(""), {
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  const response = await handleResponses(request(secret, true), config(), { model: "", provider: "" });
  const text = await response.text();
  const deltas = [...text.matchAll(/^data: (\{.*\})$/gm)]
    .map(match => JSON.parse(match[1]!) as { delta?: unknown })
    .map(payload => typeof payload.delta === "string" ? payload.delta : "")
    .join("");
  expect(deltas).toBe(`echo ${secret}`);
  expect(text).not.toContain("<STRIPE_ACCESS");
  expect(text).not.toContain("_TOKEN_1>");
});

test("Guardrails sniffs mislabeled SSE and demasks split refusal deltas", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  const budget = createTestTranslatorBudget();
  const response = await demaskGuardrailsResponse(
    new Response([
      "event: response.refusal.delta\n",
      'data: {"type":"response.refusal.delta","item_id":"refusal-1","delta":"<STRIPE_ACCESS"}\n\n',
      "event: response.refusal.delta\n",
      'data: {"type":"response.refusal.delta","item_id":"refusal-1","delta":"_TOKEN_1>"}\n\n',
      "event: response.refusal.done\n",
      'data: {"type":"response.refusal.done","item_id":"refusal-1","refusal":"<STRIPE_ACCESS_TOKEN_1>"}\n\n',
    ].join(""), { headers: { "content-type": "application/json" } }),
    prepared.turn,
    budget,
  );
  const text = await response.text();
  const deltas = [...text.matchAll(/^data: (\{.*\})$/gm)]
    .map(match => JSON.parse(match[1]!) as { type?: string; delta?: unknown })
    .filter(payload => payload.type === "response.refusal.delta")
    .map(payload => typeof payload.delta === "string" ? payload.delta : "")
    .join("");

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(deltas).toBe(secret);
  expect(text).toContain(`"refusal":"${secret}"`);
  expect(text).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
  budget.dispose();
});

test("Guardrails demasks message arrays and refusal fields in structured-suffix JSON", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "chat", {
    messages: [{ role: "user", content: secret }],
  });
  const budget = createTestTranslatorBudget();
  const response = await demaskGuardrailsResponse(
    new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: [{ type: "text", text: "visible <STRIPE_ACCESS_TOKEN_1>" }],
          refusal: "refused <STRIPE_ACCESS_TOKEN_1>",
        },
      }],
    }), { headers: { "content-type": "text/event-stream" } }),
    prepared.turn,
    budget,
  );
  const body = await response.json() as {
    choices: Array<{ message: { content: Array<{ text: string }>; refusal: string } }>;
  };

  expect(body.choices[0]?.message.content[0]?.text).toBe(`visible ${secret}`);
  expect(body.choices[0]?.message.refusal).toBe(`refused ${secret}`);
  expect(response.headers.get("content-type")).toContain("application/json");
  budget.dispose();
});

test("Guardrails classifies an open SSE stream without waiting for EOF or the prefix cap", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  const encoder = new TextEncoder();
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
      controller.enqueue(encoder.encode(
        'data: {"type":"response.output_text.delta","delta":"<STRIPE_ACCESS_TOKEN_1>"}\n\n',
      ));
    },
  });
  const budget = createTestTranslatorBudget();
  const forcedClose = setTimeout(() => sourceController.close(), 1_000);
  const startedAt = performance.now();
  const response = await demaskGuardrailsResponse(
    new Response(source, { headers: { "content-type": "text/plain" } }),
    prepared.turn,
    budget,
  );
  const elapsedMs = performance.now() - startedAt;
  clearTimeout(forcedClose);
  const reader = response.body!.getReader();
  const first = await reader.read();

  expect(elapsedMs).toBeLessThan(500);
  expect(new TextDecoder().decode(first.value)).toContain(secret);
  await reader.cancel();
  budget.dispose();
});

test("Guardrails returns declared SSE headers before a delayed first event", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  const encoder = new TextEncoder();
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
      controller.enqueue(encoder.encode(" \n"));
    },
  });
  const budget = createTestTranslatorBudget();
  const startedAt = performance.now();
  const response = await demaskGuardrailsResponse(
    new Response(source, { headers: { "content-type": "text/event-stream" } }),
    prepared.turn,
    budget,
  );
  const elapsedMs = performance.now() - startedAt;
  sourceController.enqueue(encoder.encode(
    'data: {"type":"response.output_text.delta","delta":"<STRIPE_ACCESS_TOKEN_1>"}\n\n',
  ));
  sourceController.close();

  expect(elapsedMs).toBeLessThan(500);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toContain(secret);
  budget.dispose();
});

test("Guardrails preserves declared JSON demask after the common sniff deadline", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  const payload = JSON.stringify({
    output: [{
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "visible <STRIPE_ACCESS_TOKEN_1>",
      }],
    }],
  });
  const encoder = new TextEncoder();
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
  });
  const release = setTimeout(() => {
    sourceController.enqueue(encoder.encode(payload));
    sourceController.close();
  }, 75);
  const budget = createTestTranslatorBudget();
  const response = await demaskGuardrailsResponse(
    new Response(source, { headers: { "content-type": "application/json" } }),
    prepared.turn,
    budget,
  );
  const body = await response.json() as {
    output: Array<{ content: Array<{ text: string }> }>;
  };

  expect(response.headers.get("content-type")).toContain("application/json");
  expect(body.output[0]?.content[0]?.text).toBe(`visible ${secret}`);
  clearTimeout(release);
  budget.dispose();
});

test("Guardrails bounds missing-MIME sniff before a delayed first byte", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const placeholder = "<STRIPE_ACCESS_TOKEN_1>";
  const raw = `data: {"type":"response.output_text.delta","delta":"${placeholder}"}\n\n`;
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  const encoder = new TextEncoder();
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
  });
  const release = setTimeout(() => {
    sourceController.enqueue(encoder.encode(raw));
    sourceController.close();
  }, 200);
  const budget = createTestTranslatorBudget();
  const startedAt = performance.now();
  let warnings = 0;
  const response = await demaskGuardrailsResponse(
    new Response(source),
    prepared.turn,
    budget,
    () => { warnings += 1; },
  );
  const elapsedMs = performance.now() - startedAt;

  expect(elapsedMs).toBeLessThan(150);
  expect(response.headers.get("content-type")).toBeNull();
  expect(await response.text()).toBe(raw);
  expect(warnings).toBe(1);
  clearTimeout(release);
  budget.dispose();
});

test("Guardrails bounds an incomplete missing-MIME prefix and replays its pending tail", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const placeholder = "<STRIPE_ACCESS_TOKEN_1>";
  const prefix = "da";
  const suffix = `ta: {"type":"response.output_text.delta","delta":"${placeholder}"}\n\n`;
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  const encoder = new TextEncoder();
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
      controller.enqueue(encoder.encode(prefix));
    },
  });
  const release = setTimeout(() => {
    sourceController.enqueue(encoder.encode(suffix));
    sourceController.close();
  }, 200);
  const budget = createTestTranslatorBudget();
  const startedAt = performance.now();
  let warnings = 0;
  const response = await demaskGuardrailsResponse(
    new Response(source),
    prepared.turn,
    budget,
    () => { warnings += 1; },
  );
  const elapsedMs = performance.now() - startedAt;

  expect(elapsedMs).toBeLessThan(150);
  expect(response.headers.get("content-type")).toBeNull();
  expect(await response.text()).toBe(prefix + suffix);
  expect(warnings).toBe(1);
  clearTimeout(release);
  budget.dispose();
});

test("Guardrails recognizes SSE control fields under a conflicting JSON MIME", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  const encoder = new TextEncoder();
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
      controller.enqueue(encoder.encode(": keepalive\nid: 1\nretry: 1000\n"));
    },
  });
  const budget = createTestTranslatorBudget();
  const response = await demaskGuardrailsResponse(
    new Response(source, { headers: { "content-type": "application/json" } }),
    prepared.turn,
    budget,
  );
  sourceController.enqueue(encoder.encode(
    'data: {"type":"response.output_text.delta","delta":"<STRIPE_ACCESS_TOKEN_1>"}\n\n',
  ));
  sourceController.close();

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toContain(secret);
  budget.dispose();
});

test("Guardrails waits for a split UTF-8 BOM before classifying missing-MIME JSON", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  const payload = JSON.stringify({
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "visible <STRIPE_ACCESS_TOKEN_1>" }],
    }],
  });
  const bytes = new TextEncoder().encode(`\uFEFF${payload}`);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1));
      queueMicrotask(() => {
        controller.enqueue(bytes.subarray(1));
        controller.close();
      });
    },
  });
  const budget = createTestTranslatorBudget();
  const response = await demaskGuardrailsResponse(new Response(source), prepared.turn, budget);

  expect(await response.text()).toContain(`visible ${secret}`);
  budget.dispose();
});

test("Guardrails rejects placeholder expansion before constructing an oversized string", async () => {
  const prepared = await prepareGuardrailsTurn(
    config(),
    "responses",
    { input: "sk_live_abcdefghijklmnopqrstuvwx" },
  );
  const replacement = prepared.turn!.state.replacements[0]!;
  const amplifiedTurn = {
    ...prepared.turn!,
    state: {
      ...prepared.turn!.state,
      replacements: [{
        ...replacement,
        original: "x".repeat(256 * 1024),
      }],
    },
  };
  const payload = JSON.stringify({
    output: [{
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "<STRIPE_ACCESS_TOKEN_1>".repeat(129),
      }],
    }],
  });

  expect(() => demaskGuardrailsJsonPayload(payload, amplifiedTurn))
    .toThrow(GuardrailsDemaskCapacityError);
});

test("Guardrails restores assistant text at every issued-placeholder SSE boundary", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const placeholder = "<STRIPE_ACCESS_TOKEN_1>";

  for (let split = 1; split < placeholder.length; split += 1) {
    const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
    const rewrite = guardrailsSseDemaskRewrite(prepared.turn!.state, payload => payload);
    const frames = [
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: `message-${split}`,
        output_index: 0,
        content_index: 0,
        delta: placeholder.slice(0, split),
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: `message-${split}`,
        output_index: 0,
        content_index: 0,
        delta: placeholder.slice(split),
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const output = frames.flatMap(frame => rewrite(frame)).join("");
    const restored = [...output.matchAll(/^data: (\{.*\})$/gm)]
      .map(match => JSON.parse(match[1]!) as {
        type?: string;
        delta?: unknown;
      })
      .filter(payload => payload.type === "response.output_text.delta")
      .map(payload => typeof payload.delta === "string" ? payload.delta : "")
      .join("");

    expect(restored, `split=${split}`).toBe(secret);
    expect(output, `split=${split}`).not.toContain(placeholder);
  }
});

test("Guardrails preserves executable SSE frames at every issued-placeholder boundary", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const placeholder = "<STRIPE_ACCESS_TOKEN_1>";

  for (let split = 1; split < placeholder.length; split += 1) {
    const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
    const rewrite = guardrailsSseDemaskRewrite(prepared.turn!.state, payload => payload);
    const frames = [
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: `call-${split}`,
        delta: placeholder.slice(0, split),
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: `call-${split}`,
        delta: placeholder.slice(split),
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    expect(
      frames.flatMap(frame => rewrite(frame)).join(""),
      `split=${split}`,
    ).toBe(frames.join(""));
  }
});

test("Guardrails never restores originals inside reasoning SSE", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  globalThis.fetch = (async () => new Response([
    "event: response.reasoning_text.delta\n",
    "data: {\"type\":\"response.reasoning_text.delta\",\"item_id\":\"reasoning-1\",\"delta\":\"private <STRIPE_ACCESS_TOKEN_1>\"}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-guardrails-reasoning\",\"status\":\"completed\",\"output\":[]}}\n\n",
  ].join(""), {
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  const response = await handleResponses(request(secret, true), config(), { model: "", provider: "" });
  const text = await response.text();
  expect(text).toContain("private <STRIPE_ACCESS_TOKEN_1>");
  expect(text).not.toContain(secret);
});

test("Guardrails SSE capacity fallback keeps the stream alive and masked", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const deltas = Array.from({ length: 129 }, (_, index) => [
    "event: response.output_text.delta\n",
    `data: {"type":"response.output_text.delta","item_id":"item-${index}","output_index":${index},"content_index":0,"delta":"<STRIPE_ACCESS"}\n\n`,
  ].join(""));
  globalThis.fetch = (async () => new Response([
    ...deltas,
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-guardrails-capacity\",\"status\":\"completed\",\"output\":[]}}\n\n",
  ].join(""), {
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  const response = await handleResponses(request(secret, true), config(), { model: "", provider: "" });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain("response.completed");
  expect(text).toContain("<STRIPE_ACCESS");
  expect(text).not.toContain(secret);
});

test("Guardrails pending Chat choice flush never duplicates neighboring choices", async () => {
  const prepared = await prepareGuardrailsTurn(
    config(),
    "responses",
    { input: "sk_live_abcdefghijklmnopqrstuvwx" },
  );
  const rewrite = guardrailsSseDemaskRewrite(prepared.turn!.state, payload => payload);
  const first = rewrite(`data: ${JSON.stringify({
    choices: [
      { index: 0, delta: { content: "<STRIPE_ACCESS" } },
      { index: 1, delta: { content: "neighbor" } },
    ],
  })}\n\n`);
  expect(first).toHaveLength(1);

  const flushed = rewrite("data: [DONE]\n\n");
  expect(flushed).toHaveLength(2);
  const pendingPayload = JSON.parse(flushed[0]!.match(/^data: (.*)$/m)?.[1] ?? "{}") as {
    choices: Array<{ index: number; delta: { content: string } }>;
  };
  expect(pendingPayload.choices).toEqual([
    { index: 0, delta: { content: "<STRIPE_ACCESS" } },
  ]);
});

test("Guardrails Chat finish flushes only the completed choice", async () => {
  const prepared = await prepareGuardrailsTurn(
    config(),
    "chat",
    { messages: [{ role: "user", content: "sk_live_abcdefghijklmnopqrstuvwx" }] },
  );
  const rewrite = guardrailsSseDemaskRewrite(prepared.turn!.state, payload => payload);
  rewrite('data: {"choices":[{"index":0,"delta":{"content":"<STRIPE_ACCESS"}},{"index":1,"delta":{"content":"<STRIPE_ACCESS"}}]}');

  const choiceOneFinished = rewrite(
    'data: {"choices":[{"index":1,"delta":{},"finish_reason":"stop"}]}',
  );
  expect(choiceOneFinished).toHaveLength(2);
  expect(choiceOneFinished.join("")).toContain('"index":1');
  expect(choiceOneFinished.join("")).not.toContain('"index":0,"delta":{"content":"<STRIPE_ACCESS"}');

  const final = rewrite("data: [DONE]");
  expect(final).toHaveLength(2);
  expect(final[0]).toContain('"index":0');
});

test("Guardrails demasks a placeholder split across Chat refusal deltas", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "chat", {
    messages: [{ role: "user", content: secret }],
  });
  const rewrite = guardrailsSseDemaskRewrite(prepared.turn!.state, payload => payload);
  const output = [
    'data: {"choices":[{"index":0,"delta":{"refusal":"<STRIPE_ACCESS"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"refusal":"_TOKEN_1>"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ].flatMap(frame => rewrite(frame)).join("");
  const refusal = [...output.matchAll(/^data: (\{.*\})$/gm)]
    .map(match => JSON.parse(match[1]!) as {
      choices?: Array<{ delta?: { refusal?: string } }>;
    })
    .map(payload => payload.choices?.[0]?.delta?.refusal ?? "")
    .join("");

  expect(refusal).toBe(secret);
  expect(output).not.toContain("<STRIPE_ACCESS");
});

test("Guardrails pending Chat content and refusal flush without cross-field duplication", async () => {
  const prepared = await prepareGuardrailsTurn(
    config(),
    "chat",
    { messages: [{ role: "user", content: "sk_live_abcdefghijklmnopqrstuvwx" }] },
  );
  const rewrite = guardrailsSseDemaskRewrite(prepared.turn!.state, payload => payload);
  const output = [
    'data: {"choices":[{"index":0,"delta":{"content":"<STRIPE_ACCESS","refusal":"<STRIPE_ACCESS"}}]}\n\n',
    "data: [DONE]\n\n",
  ].flatMap(frame => rewrite(frame)).join("");
  const payloads = [...output.matchAll(/^data: (\{.*\})$/gm)]
    .map(match => JSON.parse(match[1]!) as {
      choices?: Array<{ delta?: { content?: string; refusal?: string } }>;
    });
  const content = payloads
    .map(payload => payload.choices?.[0]?.delta?.content)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const refusal = payloads
    .map(payload => payload.choices?.[0]?.delta?.refusal)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  expect(content).toEqual(["<STRIPE_ACCESS"]);
  expect(refusal).toEqual(["<STRIPE_ACCESS"]);
});

test("Guardrails SSE traversal capacity falls back to the current masked block", async () => {
  const prepared = await prepareGuardrailsTurn(
    config(),
    "responses",
    { input: "sk_live_abcdefghijklmnopqrstuvwx" },
  );
  const capacityError = new GuardrailsOutputCapacityError();
  let warnings = 0;
  const rewrite = guardrailsSseDemaskRewrite(
    prepared.turn!.state,
    () => {
      throw capacityError;
    },
    () => {
      warnings += 1;
    },
    undefined,
    error => error === capacityError,
  );
  const block = 'data: {"type":"response.completed","response":{"status":"completed"}}';

  expect(rewrite(block)).toEqual([block]);
  expect(warnings).toBe(1);
});

test("Guardrails pending capacity fallback emits a multi-choice Chat block exactly once", async () => {
  const prepared = await prepareGuardrailsTurn(
    config(),
    "chat",
    { messages: [{ role: "user", content: "sk_live_abcdefghijklmnopqrstuvwx" }] },
  );
  let warnings = 0;
  const rewrite = guardrailsSseDemaskRewrite(
    prepared.turn!.state,
    payload => payload,
    () => {
      warnings += 1;
    },
  );
  const block = `data: ${JSON.stringify({
    choices: Array.from({ length: 129 }, (_, index) => ({
      index,
      delta: { content: "<STRIPE_ACCESS" },
    })),
  })}`;

  expect(rewrite(block)).toEqual([block]);
  expect(warnings).toBe(1);
  expect(rewrite("data: [DONE]")).toEqual(["data: [DONE]"]);
});

test("Guardrails restores assistant text but never executable function-call arguments", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  expect(prepared.turn).toBeDefined();
  let skipped = 0;
  const payload = demaskGuardrailsJsonPayload(JSON.stringify({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible <STRIPE_ACCESS_TOKEN_1>" }],
      },
      { type: "function_call", name: "run", arguments: '{"token":"<STRIPE_ACCESS_TOKEN_1>"}' },
    ],
  }), prepared.turn!, count => { skipped += count; });
  const parsed = JSON.parse(payload) as { output: Array<{ arguments?: string }> };

  expect(payload).toContain(`visible ${secret}`);
  expect(parsed.output[1]?.arguments).toBe('{"token":"<STRIPE_ACCESS_TOKEN_1>"}');
  expect(payload).not.toContain(`{"token":"${secret}"}`);
  expect(skipped).toBe(1);
});

test("Guardrails never restores Responses prose attributed to a non-assistant role", async () => {
  const prepared = await prepareGuardrailsTurn(
    config(),
    "responses",
    { input: "sk_live_abcdefghijklmnopqrstuvwx" },
  );
  const payload = JSON.stringify({
    output: [{
      type: "message",
      role: "user",
      content: [{ type: "output_text", text: "visible <STRIPE_ACCESS_TOKEN_1>" }],
    }],
  });

  expect(demaskGuardrailsJsonPayload(payload, prepared.turn!)).toBe(payload);
});

test("Guardrails restores Chat assistant prose but never content attributed to another role", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(
    config(),
    "chat",
    { messages: [{ role: "user", content: secret }] },
  );
  const payload = demaskGuardrailsJsonPayload(JSON.stringify({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "visible <STRIPE_ACCESS_TOKEN_1>" },
      },
      {
        index: 1,
        message: { role: "user", content: "hidden <STRIPE_ACCESS_TOKEN_1>" },
      },
    ],
  }), prepared.turn!);
  const parsed = JSON.parse(payload) as {
    choices: Array<{ message: { role: string; content: string } }>;
  };

  expect(parsed.choices[0]?.message.content).toBe(`visible ${secret}`);
  expect(parsed.choices[1]?.message.content).toBe("hidden <STRIPE_ACCESS_TOKEN_1>");
});

test("Guardrails restores top-level assistant content but not content attributed to another role", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "anthropic", {
    messages: [{ role: "user", content: secret }],
  });
  const assistant = demaskGuardrailsJsonPayload(JSON.stringify({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "visible <STRIPE_ACCESS_TOKEN_1>" }],
  }), prepared.turn!);
  const user = demaskGuardrailsJsonPayload(JSON.stringify({
    type: "message",
    role: "user",
    content: [{ type: "text", text: "hidden <STRIPE_ACCESS_TOKEN_1>" }],
  }), prepared.turn!);

  expect(assistant).toContain(secret);
  expect(user).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(user).not.toContain(secret);
});

test("Guardrails fail-open rollback restores only admitted request fields", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const literal = "<STRIPE_ACCESS_TOKEN_1>";
  const prepared = await prepareGuardrailsTurn(config(), "responses", {
    model: literal,
    input: [
      { type: "message", role: "user", content: secret },
      { type: "function_call", call_id: "call-1", name: "run", arguments: `{"token":"${secret}"}` },
    ],
    opaque: { label: literal, nodes: Array.from({ length: 1_001 }, () => null) },
  });
  const restored = restoreGuardrailsResponsesParsedRequest(
    parseRequest(prepared.body),
    prepared.turn!,
  );
  const raw = restored._rawBody as {
    model: string;
    input: Array<{ content?: string; arguments?: string }>;
    opaque: { label: string; nodes: unknown[] };
  };

  expect(restored.modelId).toBe(literal);
  expect(restored.context.messages[0]?.content).toBe(secret);
  expect(restored.context.messages[1]?.role).toBe("assistant");
  if (restored.context.messages[1]?.role !== "assistant") throw new Error("expected assistant tool call");
  expect(restored.context.messages[1].content[0]).toMatchObject({
    type: "toolCall",
    arguments: { token: secret },
  });
  expect(raw.model).toBe(literal);
  expect(raw.input[0]?.content).toBe(secret);
  expect(raw.input[1]?.arguments).toBe(`{"token":"${secret}"}`);
  expect(raw.opaque.label).toBe(literal);
  expect(raw.opaque.nodes).toHaveLength(1_001);
});

test("Guardrails counts a placeholder split across executable deltas without changing bytes", async () => {
  const prepared = await prepareGuardrailsTurn(
    config(),
    "responses",
    { input: "sk_live_abcdefghijklmnopqrstuvwx" },
  );
  let skipped = 0;
  const first = JSON.stringify({
    type: "response.function_call_arguments.delta",
    item_id: "call-1",
    delta: "{\"token\":\"<STRIPE_ACCESS",
  });
  const second = JSON.stringify({
    type: "response.function_call_arguments.delta",
    item_id: "call-1",
    delta: "_TOKEN_1>\"}",
  });

  expect(demaskGuardrailsJsonPayload(first, prepared.turn!, count => { skipped += count; }))
    .toBe(first);
  expect(skipped).toBe(0);
  expect(demaskGuardrailsJsonPayload(second, prepared.turn!, count => { skipped += count; }))
    .toBe(second);
  expect(skipped).toBe(1);
});

test("Guardrails counts but does not restore Chat and Anthropic tool inputs", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const prepared = await prepareGuardrailsTurn(config(), "responses", { input: secret });
  let skipped = 0;

  const chat = demaskGuardrailsJsonPayload(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: "visible <STRIPE_ACCESS_TOKEN_1>",
        tool_calls: [{
          type: "function",
          function: { name: "run", arguments: '{"token":"<STRIPE_ACCESS_TOKEN_1>"}' },
        }],
      },
    }],
  }), prepared.turn!, count => { skipped += count; });
  const anthropic = demaskGuardrailsJsonPayload(JSON.stringify({
    content: [
      { type: "text", text: "visible <STRIPE_ACCESS_TOKEN_1>" },
      { type: "tool_use", name: "run", input: { token: "<STRIPE_ACCESS_TOKEN_1>" } },
    ],
  }), prepared.turn!, count => { skipped += count; });

  const parsedChat = JSON.parse(chat) as {
    choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
  };
  const parsedAnthropic = JSON.parse(anthropic) as {
    content: Array<{ input?: { token?: string } }>;
  };
  expect(chat).toContain(`visible ${secret}`);
  expect(parsedChat.choices[0]?.message.tool_calls[0]?.function.arguments)
    .toBe('{"token":"<STRIPE_ACCESS_TOKEN_1>"}');
  expect(anthropic).toContain(`visible ${secret}`);
  expect(parsedAnthropic.content[1]?.input?.token).toBe("<STRIPE_ACCESS_TOKEN_1>");
  expect(skipped).toBe(2);
});

test("detect mode never persists matched input in the Responses continuation cache", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const detectConfig = config();
  detectConfig.guardrails = { enabled: true, mode: "detect", failurePolicy: "block" };
  globalThis.fetch = (async () => Response.json({
    id: "resp-guardrails-detect-private",
    object: "response",
    status: "completed",
    output: [],
  })) as typeof fetch;
  const initial = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-parent-thread-id": "detect-thread" },
    body: JSON.stringify({ model: "deepseek-v4-flash", input: secret }),
  });

  expect((await handleResponses(initial, detectConfig, { model: "", provider: "" })).status).toBe(200);
  const continuation = { previous_response_id: "resp-guardrails-detect-private", input: "follow up" };
  expect(expandPreviousResponseInput(continuation, "detect-thread")).toBe(continuation);
});

test("Responses continuation keeps inherited mappings across enforce policy revisions", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const nextSecret = "sk_live_zyxwvutsrqponmlkjihgfedc";
  const guardedConfig = config();
  const upstreamBodies: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBodies.push(String(init?.body ?? ""));
    return Response.json({
    id: upstreamBodies.length === 1 ? "resp-policy-revision" : "resp-policy-revision-next",
    object: "response",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ack <STRIPE_ACCESS_TOKEN_1>" }],
    }],
  });
  }) as typeof fetch;
  const first = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-parent-thread-id": "policy-revision-thread",
    },
    body: JSON.stringify({ model: "deepseek-v4-flash", input: secret }),
  });
  expect((await handleResponses(
    first,
    guardedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  )).status).toBe(200);

  guardedConfig.guardrails = {
    ...guardedConfig.guardrails!,
    disabledBuiltinRuleIds: ["credentials.url_with_creds"],
  };
  const continued = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-parent-thread-id": "policy-revision-thread",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        previous_response_id: "resp-policy-revision",
        input: nextSecret,
      }),
    }),
    guardedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  );

  expect(continued.status).toBe(200);
  expect(upstreamBodies[1]).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(upstreamBodies[1]).toContain("<STRIPE_ACCESS_TOKEN_2>");
  expect(upstreamBodies[1]).not.toContain(secret);
  expect(upstreamBodies[1]).not.toContain(nextSecret);
  expect(JSON.stringify(await continued.json())).toContain(secret);
});

test("Responses continuation still rejects enforce to disabled transitions", async () => {
  const guardedConfig = config();
  globalThis.fetch = (async () => Response.json({
    id: "resp-policy-disabled",
    object: "response",
    status: "completed",
    output: [],
  })) as typeof fetch;
  const headers = {
    "content-type": "application/json",
    "x-codex-parent-thread-id": "policy-disabled-thread",
  };
  expect((await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        input: "sk_live_abcdefghijklmnopqrstuvwx",
      }),
    }),
    guardedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  )).status).toBe(200);

  guardedConfig.guardrails = { enabled: false };
  const continued = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        previous_response_id: "resp-policy-disabled",
        input: "continue",
      }),
    }),
    guardedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  );
  expect(continued.status).toBe(409);
  expect(await continued.json()).toMatchObject({
    error: { code: "guardrails_policy_changed" },
  });
});

test("Responses continuation rejects a provider excluded after an enforced turn", async () => {
  const guardedConfig = config();
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    return Response.json({
      id: "resp-provider-scope",
      object: "response",
      status: "completed",
      output: [],
    });
  }) as typeof fetch;
  const headers = {
    "content-type": "application/json",
    "x-codex-parent-thread-id": "provider-scope-thread",
  };
  expect((await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        input: "sk_live_abcdefghijklmnopqrstuvwx",
      }),
    }),
    guardedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  )).status).toBe(200);

  guardedConfig.guardrails = {
    ...guardedConfig.guardrails!,
    providerScope: { mode: "selected", providerIds: ["other"] },
  };
  const continued = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        previous_response_id: "resp-provider-scope",
        input: "continue",
      }),
    }),
    guardedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  );

  expect(continued.status).toBe(409);
  expect(await continued.json()).toMatchObject({
    error: { code: "guardrails_policy_changed" },
  });
  expect(upstreamCalls).toBe(1);
});

test("missing continuation mappings create a privacy-safe warning event", async () => {
  const guardedConfig = config();
  globalThis.fetch = (async () => Response.json({
    id: "resp-mapping-loss",
    object: "response",
    status: "completed",
    output: [],
  })) as typeof fetch;
  const headers = {
    "content-type": "application/json",
    "x-codex-parent-thread-id": "mapping-loss-thread",
  };
  expect((await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        input: "sk_live_abcdefghijklmnopqrstuvwx",
      }),
    }),
    guardedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  )).status).toBe(200);
  clearGuardrailsContinuationsForTests();
  clearGuardrailsTelemetryForTests();

  const continued = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        previous_response_id: "resp-mapping-loss",
        input: "continue",
      }),
    }),
    guardedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  );
  expect(continued.status).toBe(200);
  expect(guardrailsActivity({ result: "demask_warning" })).toMatchObject({
    totalMatching: 1,
    events: [expect.objectContaining({
      surface: "responses",
      result: "demask_warning",
      severity: "warning",
      ruleIds: [],
      categoryIds: [],
    })],
  });
});

test("detect mode records plaintext introduced after the initial Guardrails pass without changing it", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const detectConfig = config();
  detectConfig.guardrails = { enabled: true, mode: "detect", failurePolicy: "block" };
  const prepared = await prepareGuardrailsTurn(detectConfig, "responses", { input: "initial" });
  const rescanned = rescanGuardrailsResponsesBody({ input: secret }, prepared.turn!);

  expect(rescanned.body).toEqual({ input: secret });
  expect(rescanned.turn.findings).toHaveLength(1);
  expect(rescanned.turn.state.replacements).toHaveLength(1);
});
