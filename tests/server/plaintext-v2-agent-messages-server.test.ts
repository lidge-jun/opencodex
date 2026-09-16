import { warnPlaintextV2AgentMessagesStartup } from "../../src/server";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import {
  PLAINTEXT_V2_AGENT_MESSAGE_RESTORE_OVERFLOW_MESSAGE,
  PLAINTEXT_V2_COLLABORATION_NAMESPACE,
} from "../../src/responses/plaintext-v2-agent-messages";
import { clearResponseStateForTests, expandPreviousResponseInput } from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
beforeEach(() => { clearResponseStateForTests(); });
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearResponseStateForTests();
});

function config(
  enabled: boolean,
  snapshotRepair = false,
  streamMode?: "auto" | "legacy-tee" | "eager-relay",
): OcxConfig {
  return {
    defaultProvider: "native",
    providers: {
      native: {
        adapter: "openai-responses",
        baseUrl: CODEX_FORWARD_BASE_URL,
        authMode: "forward",
        ...(snapshotRepair ? { responsesSnapshotRepair: true } : {}),
      },
    },
    plaintextV2AgentMessages: enabled,
    ...(streamMode ? { streamMode } : {}),
  } as OcxConfig;
}

function collaborationRequest(options: {
  input?: unknown[];
  model?: string;
  previousResponseId?: string;
  toolChoice?: unknown;
} = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model ?? "native/gpt-5.6-sol",
      store: false,
      stream: true,
      input: options.input ?? [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "delegate" }],
      }],
      ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [
          {
            type: "function",
            name: "spawn_agent",
            parameters: {
              type: "object",
              properties: { message: { type: "string", encrypted: true } },
              required: ["message"],
            },
          },
          { type: "function", name: "send_message", parameters: { type: "object" } },
        ],
      }],
    }),
  });
}

async function withPoolHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "ocx-plaintext-v2-pool-"));
  const previousOpencodexHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  try {
    return await run();
  } finally {
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountQuota();
    rmSync(home, { recursive: true, force: true });
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

function completedResponsePayload(id = "resp-plaintext-v2") {
  return {
    id,
    status: "completed",
    output: [{
      type: "function_call",
      call_id: "call-spawn",
      namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
      name: "start_delegated_task",
      arguments: JSON.stringify({ message: "plain assignment" }),
      encrypted_function_args: [],
    }],
  };
}

function overLimitResponsePayload(id = "resp-plaintext-v2-overflow") {
  return {
    id,
    status: "completed",
    output: Array.from({ length: 10_000 }, (_, index) => ({
      type: "function_call",
      call_id: `call-${index}`,
      namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
      name: "start_delegated_task",
      arguments: "{}",
    })),
  };
}

describe("plaintext v2 agent messages at the Responses server boundary", () => {
  test.each(["json", "legacy-tee", "eager-relay"] as const)("null namespace restores before %s delivery and continuation storage", async mode => {
    const id = `resp-null-namespace-${mode}`;
    const item = { ...completedResponsePayload(id).output[0]!, namespace: null };
    const payload = { id, status: "completed", output: [item] };
    globalThis.fetch = (async () => mode === "json" ? Response.json(payload) : new Response(
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item })}\n\n`
      + `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
    const response = await handleResponses(collaborationRequest(), config(true, false, mode === "json" ? undefined : mode), { model: "", provider: "" });
    const text = await response.text();
    expect(text).toContain('"namespace":"collaboration"');
    expect(text).toContain('"name":"spawn_agent"');
    expect(text).not.toContain('"name":"start_delegated_task"');
    const replay = expandPreviousResponseInput({ previous_response_id: id, input: [] }) as { input: Array<Record<string, unknown>> };
    expect(replay.input.find(value => value.type === "function_call")).toMatchObject({ namespace: "collaboration", name: "spawn_agent" });
    expect(JSON.stringify(replay)).not.toContain("start_delegated_task");
  });

  test("rewrites the canonical request and restores every SSE response snapshot", async () => {
    const sentBodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(typeof init?.body === "string" ? init.body : "");
      const response = completedResponsePayload();
      return new Response(
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: response.output[0],
        })}\n\nevent: response.function_call_arguments.done\ndata: ${JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "fc-spawn",
          namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
          name: `${PLAINTEXT_V2_COLLABORATION_NAMESPACE}__start_delegated_task`,
          arguments: JSON.stringify({ message: "plain assignment" }),
          encrypted_function_args: [],
        })}\n\nevent: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response,
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const response = await handleResponses(
      collaborationRequest(),
      config(true),
      { model: "", provider: "" },
    );
    const clientBody = await response.text();
    const sentBody = JSON.parse(sentBodies[0]!) as {
      tools: Array<{
        name: string;
        tools: Array<{
          name: string;
          parameters: { properties: { message: Record<string, unknown> } };
        }>;
      }>;
    };

    expect(sentBodies).toHaveLength(1);
    expect(sentBody.tools[0]!.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(sentBody.tools[0]!.tools[0]!.name).toBe("start_delegated_task");
    expect(sentBody.tools[0]!.tools[0]!.parameters.properties.message.encrypted).toBeUndefined();
    expect(clientBody).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(clientBody).toContain('"namespace":"collaboration"');
    expect(clientBody).toContain('"name":"spawn_agent"');
    expect(clientBody).toContain('"encrypted_function_args":[]');
  });

  test("restores the namespace in bounded JSON responses", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(completedResponsePayload()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    const response = await handleResponses(
      collaborationRequest(),
      config(true),
      { model: "", provider: "" },
    );
    const clientBody = await response.text();

    expect(clientBody).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(clientBody).toContain('"namespace":"collaboration"');
    expect(clientBody).toContain('"encrypted_function_args":[]');
  });

  test("rejects an unclassified successful response while restoration is required", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify(completedResponsePayload()),
      { status: 200 },
    )) as typeof fetch;

    const response = await handleResponses(
      collaborationRequest(),
      config(true),
      { model: "", provider: "" },
    );
    const clientBody = await response.text();

    expect(response.status).toBe(502);
    expect(clientBody).toContain("unsupported content type");
    expect(clientBody).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(clientBody).not.toContain("start_delegated_task");
  });

  test("restores aliases after SSE snapshot repair copies request tools and tool choice", async () => {
    globalThis.fetch = (async () => {
      const response = completedResponsePayload("resp-snapshot-sse");
      return new Response(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response,
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const response = await handleResponses(
      collaborationRequest({
        toolChoice: { type: "function", namespace: "collaboration", name: "spawn_agent" },
      }),
      config(true, true),
      { model: "", provider: "" },
    );
    const completedLine = (await response.text()).split("\n")
      .find(line => line.includes('"response.completed"'))!;
    const completed = JSON.parse(completedLine.replace(/^data: /, "")) as {
      response: {
        tool_choice: { namespace: string };
        tools: Array<{ name: string }>;
        output: Array<{ namespace: string; encrypted_function_args: unknown[] }>;
      };
    };

    expect(completed.response.tool_choice.namespace).toBe("collaboration");
    expect(completed.response.tools[0]!.name).toBe("collaboration");
    expect(completed.response.output[0]!.namespace).toBe("collaboration");
    expect(completed.response.output[0]!.encrypted_function_args).toEqual([]);
  });

  test("restores aliases after bounded JSON snapshot repair", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify(completedResponsePayload("resp-snapshot-json")),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

    const response = await handleResponses(
      collaborationRequest({
        toolChoice: { type: "function", namespace: "collaboration", name: "spawn_agent" },
      }),
      config(true, true),
      { model: "", provider: "" },
    );
    const completed = await response.json() as {
      tool_choice: { namespace: string };
      tools: Array<{ name: string }>;
      output: Array<{ namespace: string; encrypted_function_args: unknown[] }>;
    };

    expect(completed.tool_choice.namespace).toBe("collaboration");
    expect(completed.tools[0]!.name).toBe("collaboration");
    expect(completed.output[0]!.namespace).toBe("collaboration");
    expect(completed.output[0]!.encrypted_function_args).toEqual([]);
  });

  test("keeps the marker and reserved namespace when the option is disabled", async () => {
    const sentBodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    await handleResponses(collaborationRequest(), config(false), { model: "", provider: "" });
    const sentBody = JSON.parse(sentBodies[0]!) as {
      tools: Array<{ name: string; tools: Array<{ parameters: { properties: { message: Record<string, unknown> } } }> }>;
    };

    expect(sentBodies).toHaveLength(1);
    expect(sentBody.tools[0]!.name).toBe("collaboration");
    expect(sentBody.tools[0]!.tools[0]!.parameters.properties.message.encrypted).toBe(true);
  });

  test("keeps the whole request unchanged when tool-search history conflicts with the alias", async () => {
    const sentBodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    await handleResponses(collaborationRequest({
      input: [{
        type: "tool_search_output",
        tools: [{
          type: "namespace",
          name: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
          tools: [],
        }],
      }],
    }), config(true), { model: "", provider: "" });

    const sent = JSON.parse(sentBodies[0]!) as {
      tools: Array<{
        name: string;
        tools: Array<{ parameters: { properties: { message: Record<string, unknown> } } }>;
      }>;
    };
    expect(sent.tools[0]!.name).toBe("collaboration");
    expect(sent.tools[0]!.tools[0]!.parameters.properties.message.encrypted).toBe(true);
  });

  test("rebuilds the plaintext alias after a canonical pool quota retry", async () => {
    await withPoolHome(async () => {
      const poolConfig = {
        defaultProvider: "openai",
        activeCodexAccountId: "pool-a",
        autoSwitchThreshold: 0,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: CODEX_FORWARD_BASE_URL,
            authMode: "forward",
            codexAccountMode: "pool",
          },
        },
        codexAccounts: ["pool-a", "pool-b"].map(id => ({
          id,
          email: `${id}@example.test`,
          isMain: false,
          chatgptAccountId: `${id}_chatgpt`,
        })),
        plaintextV2AgentMessages: true,
      } as OcxConfig;
      for (const [index, id] of ["pool-a", "pool-b"].entries()) {
        saveCodexAccountCredential(id, {
          accessToken: `${id}-access-token`,
          refreshToken: `${id}-refresh-token`,
          expiresAt: Date.now() + 300_000,
          chatgptAccountId: `${id}_chatgpt`,
        });
        updateAccountQuota(id, 10 + index * 10);
      }

      const sentBodies: string[] = [];
      const entitlementSnapshot = {
        modelsByAccount: new Map([
          ["pool-a", new Set(["gpt-5.6-sol"])],
          ["pool-b", new Set(["gpt-5.6-sol"])],
        ]),
        confirmedAccountIds: new Set(["pool-a", "pool-b"]),
        credentialIdentities: new Map<string, string>(),
      };
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBodies.push(typeof init?.body === "string" ? init.body : "");
        if (sentBodies.length === 1) {
          return Response.json({ error: { message: "rate limited" } }, {
            status: 429,
            headers: { "retry-after": "1" },
          });
        }
        return Response.json(completedResponsePayload("resp-pool-retry"));
      }) as typeof fetch;

      const response = await handleResponses(
        collaborationRequest({ model: "gpt-5.6-sol" }),
        poolConfig,
        { model: "", provider: "" },
        { resolveCodexModelEntitlements: async () => entitlementSnapshot },
      );
      const clientBody = await response.text();

      expect(sentBodies).toHaveLength(2);
      for (const body of sentBodies) {
        const sent = JSON.parse(body) as { tools: Array<{ name: string }> };
        expect(sent.tools[0]!.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
      }
      expect(clientBody).toContain('"namespace":"collaboration"');
      expect(clientBody).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    });
  });

  test("fails closed for over-limit streamed responses in both relay modes", async () => {
    for (const streamMode of ["legacy-tee", "eager-relay"] as const) {
      globalThis.fetch = (async () => new Response(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: overLimitResponsePayload(`resp-${streamMode}`),
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch;

      const response = await handleResponses(
        collaborationRequest(),
        config(true, false, streamMode),
        { model: "", provider: "" },
      );
      const clientBody = await response.text();

      expect(response.status).toBe(200);
      expect(clientBody).toContain('"type":"response.failed"');
      expect(clientBody).toContain(PLAINTEXT_V2_AGENT_MESSAGE_RESTORE_OVERFLOW_MESSAGE);
      expect(clientBody).toContain("data: [DONE]");
      expect(clientBody).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
      expect(clientBody).not.toContain("start_delegated_task");
    }
  });

  test("rejects over-limit bounded JSON before HTTP or WebSocket reframing", async () => {
    const fixtureId = "plaintext-v2-bounded-json-fixture";
    const fixtureModel = "fixture-model";
    const mutableRegistry = PROVIDER_REGISTRY as unknown as Array<Record<string, unknown>>;
    mutableRegistry.push({
      id: fixtureId,
      label: "Plaintext V2 bounded JSON fixture",
      baseUrl: CODEX_FORWARD_BASE_URL,
      adapter: "openai-responses",
      authKind: "forward",
      models: [fixtureModel],
      defaultModel: fixtureModel,
      modelResponsesUpstreamStreaming: { [fixtureModel]: false },
    });
    const fixtureConfig = {
      defaultProvider: fixtureId,
      providers: {
        [fixtureId]: {
          adapter: "openai-responses",
          baseUrl: CODEX_FORWARD_BASE_URL,
          authMode: "forward",
        },
      },
      plaintextV2AgentMessages: true,
    } as OcxConfig;

    try {
      for (const inboundTransport of [undefined, "websocket"] as const) {
        globalThis.fetch = (async () => Response.json(overLimitResponsePayload())) as typeof fetch;
        const response = await handleResponses(
          collaborationRequest({ model: `${fixtureId}/${fixtureModel}` }),
          fixtureConfig,
          { model: "", provider: "" },
          inboundTransport
            ? { inboundWire: "responses", inboundTransport }
            : undefined,
        );
        const clientBody = await response.text();

        expect(response.status).toBe(502);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(clientBody).toContain(PLAINTEXT_V2_AGENT_MESSAGE_RESTORE_OVERFLOW_MESSAGE);
        expect(clientBody).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
        expect(clientBody).not.toContain("start_delegated_task");
        expect(clientBody).not.toContain("data: [DONE]");
      }
    } finally {
      const index = mutableRegistry.findIndex(entry => entry.id === fixtureId);
      if (index >= 0) mutableRegistry.splice(index, 1);
    }
  });

  test("rejects an over-limit JSON response and does not retain it for continuation", async () => {
    const sentBodies: string[] = [];
    let requestIndex = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(typeof init?.body === "string" ? init.body : "");
      requestIndex += 1;
      const payload = requestIndex === 1
        ? overLimitResponsePayload()
        : { id: "resp-after-overflow", status: "completed", output: [] };
      return Response.json(payload);
    }) as typeof fetch;

    const first = await handleResponses(
      collaborationRequest(),
      config(true),
      { model: "", provider: "" },
    );
    const firstBody = await first.text();
    expect(first.status).toBe(502);
    expect(firstBody).toContain(PLAINTEXT_V2_AGENT_MESSAGE_RESTORE_OVERFLOW_MESSAGE);
    expect(firstBody).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(firstBody).not.toContain("start_delegated_task");

    const second = await handleResponses(
      collaborationRequest({
        previousResponseId: "resp-plaintext-v2-overflow",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        }],
      }),
      config(false),
      { model: "", provider: "" },
    );
    const secondBody = await second.text();
    expect({ status: second.status, body: secondBody, sends: sentBodies.length }).toEqual({
      status: 400,
      body: expect.stringContaining("continuation state is unavailable or expired"),
      sends: 1,
    });
  });

  test.each([undefined, "websocket"] as const)("stores the client namespace across an option change on %s", async inboundTransport => {
    const sentBodies: string[] = [];
    let requestIndex = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(typeof init?.body === "string" ? init.body : "");
      requestIndex += 1;
      const payload = requestIndex === 1
        ? completedResponsePayload("resp-toggle-plaintext-v2")
        : { id: "resp-after-toggle", status: "completed", output: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const first = await handleResponses(
      collaborationRequest(),
      config(true),
      { model: "", provider: "" },
      { inboundWire: "responses", inboundTransport },
    );
    await first.text();
    const second = await handleResponses(
      collaborationRequest({
        previousResponseId: "resp-toggle-plaintext-v2",
        input: [{ type: "function_call_output", call_id: "call-spawn", output: "done" }],
      }),
      config(false),
      { model: "", provider: "" },
      { inboundWire: "responses", inboundTransport },
    );
    await second.text();

    const replay = JSON.parse(sentBodies[1]!) as { input: Array<Record<string, unknown>> };
    const replayedCall = replay.input.find(item => item.type === "function_call");
    expect(replayedCall?.namespace).toBe("collaboration");
    expect(JSON.stringify(replay)).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
  });
});


test("plaintext startup warning requires explicit opt-in and names retention", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    warnPlaintextV2AgentMessagesStartup({});
    warnPlaintextV2AgentMessagesStartup({ plaintextV2AgentMessages: false });
    expect(warnings).toEqual([]);
    warnPlaintextV2AgentMessagesStartup({ plaintextV2AgentMessages: true });
    expect(warnings.join(" ")).toContain("Codex history");
    expect(warnings.join(" ")).toContain("HTTPS");
    expect(warnings.join(" ")).toContain("local response/debug state");
  } finally { console.warn = original; }
});

for (const streamMode of ["legacy-tee", "eager-relay"] as const) {
  for (const refusal of ["malformed", "unknown-alias", "conflicting-binding"] as const) {
    test(`${streamMode} ${refusal} is refused without caching or retry`, async () => {
      let sends = 0;
      const sent: string[] = [];
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        sends += 1;
        sent.push(String(init?.body));
        if (sends > 1) return new Response(JSON.stringify({ id: "after-refusal", status: "completed", output: [] }), { headers: { "content-type": "application/json" } });
        const completed = completedResponsePayload("refused-plaintext");
        const first = { type: "response.output_item.added", output_index: 0, item: completed.output[0] };
        const invalid = refusal === "malformed" ? "{malformed"
          : JSON.stringify({ type: "response.output_item.done", output_index: 0, item: {
            ...completed.output[0], name: refusal === "unknown-alias" ? "unknown_private" : "deliver_delegated_message",
          } });
        return new Response(`data: ${JSON.stringify(first)}\n\ndata: ${invalid}\n\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      const response = await handleResponses(collaborationRequest(), config(true, false, streamMode), { model: "", provider: "" });
      const text = await response.text();
      expect(text).toContain("response.failed");
      expect(text).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
      expect(text).not.toContain("start_delegated_task");
      expect(sends).toBe(1);
      const next = await handleResponses(collaborationRequest({ previousResponseId: "refused-plaintext", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }] }), config(false), { model: "", provider: "" });
      expect(next.status).toBe(400);
      expect(await next.text()).toContain("previous_response_not_found");
      expect(sent).toHaveLength(1);
      expect(sends).toBe(1);
    });
  }
}

test("malformed bounded JSON is a single-attempt 502", async () => {
  let sends = 0;
  globalThis.fetch = (async () => { sends += 1; return new Response("{malformed", { headers: { "content-type": "application/json" } }); }) as typeof fetch;
  const response = await handleResponses(collaborationRequest(), config(true), { model: "", provider: "" });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("{malformed");
  expect(sends).toBe(1);
});

test("cross-coordinate namespace conflict cannot publish continuation", async () => {
  let sends = 0;
  globalThis.fetch = (async () => {
    sends += 1;
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "start_delegated_task", arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: "fc1", namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE, name: "start_delegated_task", arguments: "{}" },
      { type: "response.completed", response: { id: "refused-coordinates", status: "completed", output: [{ type: "function_call", call_id: "c1", namespace: "foreign", name: "spawn_agent", arguments: "{}" }] } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const response = await handleResponses(collaborationRequest(), config(true, false, "eager-relay"), { model: "", provider: "" });
  expect(await response.text()).toContain("response.failed");
  const next = await handleResponses(collaborationRequest({ previousResponseId: "refused-coordinates" }), config(false), { model: "", provider: "" });
  expect(next.status).toBe(400);
  expect(sends).toBe(1);
});


test("concurrent native requests do not share plaintext alias metadata", async () => {
  const pending: Array<{ enabled: boolean; resolve: (value: Response) => void }> = [];
  let bothReady!: () => void;
  const ready = new Promise<void>(resolve => { bothReady = resolve; });
  globalThis.fetch = ((_url, init) => {
    const body = JSON.parse(String(init?.body));
    const enabled = body.tools.some((tool: { name: string }) => tool.name === PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    const response = new Promise<Response>(resolve => { pending.push({ enabled, resolve }); });
    if (pending.length === 2) bothReady();
    return response;
  }) as typeof fetch;
  const first = handleResponses(collaborationRequest(), config(true), { model: "", provider: "" });
  const second = handleResponses(collaborationRequest(), config(false), { model: "", provider: "" });
  await ready;
  for (const request of [...pending].reverse()) {
    const payload = completedResponsePayload(request.enabled ? "concurrent-enabled" : "concurrent-disabled");
    if (!request.enabled) payload.output[0]!.namespace = "foreign";
    request.resolve(Response.json(payload));
  }
  const [enabledResponse, disabledResponse] = await Promise.all([first, second]);
  const enabledText = await enabledResponse.text();
  const disabledText = await disabledResponse.text();
  expect(enabledText).toContain('"namespace":"collaboration"');
  expect(enabledText).toContain('"name":"spawn_agent"');
  expect(enabledText).not.toContain("start_delegated_task");
  expect(disabledText).toContain('"namespace":"foreign"');
  expect(disabledText).toContain('"name":"start_delegated_task"');
  expect(pending).toHaveLength(2);
});
