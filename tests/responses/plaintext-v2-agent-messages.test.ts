import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import {
  PlaintextV2AgentMessageRestoreOverflowError,
  createPlaintextV2AgentMessageCallRestoreRewrite,
  PLAINTEXT_V2_COLLABORATION_NAMESPACE,
  preparePlaintextV2AgentMessages,
  restorePlaintextV2AgentMessageCalls,
  restorePlaintextV2AgentMessageCallsInJson,
  restorePlaintextV2AgentMessageCallsInJsonResult,
  shouldPreparePlaintextV2AgentMessages,
} from "../../src/responses/plaintext-v2-agent-messages";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

function collaborationTool(name: string, encrypted: boolean = true): Record<string, unknown> {
  return {
    type: "function",
    name,
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          encrypted,
          const: { encrypted: true },
        },
        encrypted: { type: "boolean" },
      },
      required: ["message"],
    },
  };
}

describe("plaintext v2 agent message request preparation", () => {
  test("strips only the three message markers and aliases collaboration catalogs", () => {
    const body = {
      model: "gpt-5.6-sol",
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [
          collaborationTool("spawn_agent"),
          collaborationTool("send_message"),
          collaborationTool("followup_task", false),
          collaborationTool("wait_agent"),
        ],
      }],
      input: [{
        type: "additional_tools",
        tools: [{
          type: "namespace",
          name: "collaboration",
          tools: [collaborationTool("followup_task")],
        }],
      }],
    };
    const before = structuredClone(body);

    const prepared = preparePlaintextV2AgentMessages(body);
    const result = prepared.body as typeof body;
    const namespace = result.tools[0] as typeof body.tools[0];
    const spawn = namespace.tools[0] as ReturnType<typeof collaborationTool>;
    const send = namespace.tools[1] as ReturnType<typeof collaborationTool>;
    const followup = namespace.tools[2] as ReturnType<typeof collaborationTool>;
    const wait = namespace.tools[3] as ReturnType<typeof collaborationTool>;
    const additionalNamespace = result.input[0].tools[0] as {
      name: string;
      tools: Array<ReturnType<typeof collaborationTool>>;
    };
    const additional = additionalNamespace.tools[0]!;
    const message = (tool: Record<string, unknown>) => (
      ((tool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).message
    );

    expect(prepared.namespaceAliased).toBe(true);
    expect([...prepared.toolNames].sort()).toEqual([
      "followup_task",
      "send_message",
      "spawn_agent",
      "wait_agent",
    ]);
    expect(namespace.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(additionalNamespace.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(spawn.name).toBe("start_delegated_task");
    expect(send.name).toBe("deliver_delegated_message");
    expect(followup.name).toBe("continue_delegated_task");
    expect(additional.name).toBe("continue_delegated_task");
    expect(wait.name).toBe("wait_agent");
    expect(message(spawn).encrypted).toBeUndefined();
    expect(message(send).encrypted).toBeUndefined();
    expect(message(additional).encrypted).toBeUndefined();
    expect(message(followup).encrypted).toBe(false);
    expect(message(wait).encrypted).toBe(true);
    expect(message(spawn).const).toEqual({ encrypted: true });
    expect(((spawn.parameters as Record<string, unknown>).properties as Record<string, unknown>).encrypted)
      .toEqual({ type: "boolean" });
    expect(body).toEqual(before);
  });

  test("does not reinterpret a flat same-named function as the Codex v2 catalog", () => {
    const body = { tools: [collaborationTool("spawn_agent")] };
    const prepared = preparePlaintextV2AgentMessages(body);
    const tool = (prepared.body as typeof body).tools[0] as Record<string, unknown>;
    const message = ((tool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).message;

    expect(message.encrypted).toBe(true);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
  });

  test("does not strip same-named tools from another namespace", () => {
    const body = {
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [collaborationTool("spawn_agent")],
        },
        {
          type: "namespace",
          name: "private_mail",
          tools: [collaborationTool("send_message")],
        },
      ],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    const privateTool = (prepared.body as typeof body).tools[1]!.tools[0] as Record<string, unknown>;
    const privateMessage = ((privateTool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).message;

    expect(privateMessage.encrypted).toBe(true);
    expect(privateTool.name).toBe("send_message");
  });

  test("does not strip an independent flat tool beside a collaboration namespace", () => {
    const body = {
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [collaborationTool("spawn_agent")],
        },
        collaborationTool("send_message"),
      ],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    const flatTool = (prepared.body as typeof body).tools[1] as Record<string, unknown>;
    const flatMessage = ((flatTool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).message;
    expect(flatMessage.encrypted).toBe(true);
    expect(flatTool.name).toBe("send_message");
  });

  test("aliases selectors and replayed calls with the rewritten collaboration catalog", () => {
    const replayedCall = {
      type: "function_call",
      call_id: "call-old",
      namespace: "collaboration",
      name: "spawn_agent",
      arguments: "{}",
    };
    const replayedOutput = {
      type: "function_call_output",
      call_id: "call-old",
      output: { namespace: "collaboration" },
    };
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent"), collaborationTool("send_message")],
      }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "function", namespace: "collaboration", name: "send_message" },
          { type: "function", namespace: "private_mail", name: "send_message" },
        ],
      },
      input: [replayedCall, replayedOutput],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    const result = prepared.body as typeof body;

    expect(result.tools[0]!.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(result.tool_choice.tools[0]!.namespace).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(result.tool_choice.tools[0]!.name).toBe("deliver_delegated_message");
    expect(result.tool_choice.tools[1]!.namespace).toBe("private_mail");
    expect(result.input[0]!.namespace).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(result.input[0]!.name).toBe("start_delegated_task");
    expect(result.input[1]).toEqual(replayedOutput);
  });

  test("aliases a forced collaboration tool choice", () => {
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent"), collaborationTool("followup_task")],
      }],
      tool_choice: { type: "function", namespace: "collaboration", name: "followup_task" },
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect((prepared.body as typeof body).tool_choice.namespace)
      .toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect((prepared.body as typeof body).tool_choice.name).toBe("continue_delegated_task");
  });

  test("aliases both supported qualified-name forms using declared child names", () => {
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent"), collaborationTool("send_message")],
      }],
      tool_choice: { type: "function", name: "collaboration__spawn_agent" },
      input: [{
        type: "function_call",
        call_id: "call-send",
        name: "collaboration.send_message",
        arguments: "{}",
      }],
    };

    const result = preparePlaintextV2AgentMessages(body).body as typeof body;
    expect(result.tool_choice.name)
      .toBe(`${PLAINTEXT_V2_COLLABORATION_NAMESPACE}__start_delegated_task`);
    expect(result.input[0]!.name)
      .toBe(`${PLAINTEXT_V2_COLLABORATION_NAMESPACE}.deliver_delegated_message`);
  });

  test("aliases every duplicate collaboration declaration in one request", () => {
    const body = {
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [collaborationTool("spawn_agent")],
        },
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "wait_agent", parameters: { type: "object" } }],
        },
      ],
      tool_choice: { type: "function", namespace: "collaboration", name: "wait_agent" },
    };

    const result = preparePlaintextV2AgentMessages(body).body as typeof body;
    expect(result.tools.map(tool => tool.name)).toEqual([
      PLAINTEXT_V2_COLLABORATION_NAMESPACE,
      PLAINTEXT_V2_COLLABORATION_NAMESPACE,
    ]);
    expect(result.tool_choice.namespace).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
  });

  test("does not reinterpret an independent flattened-looking tool name", () => {
    const body = {
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [collaborationTool("spawn_agent")],
        },
        { type: "function", name: "collaboration__audit", parameters: { type: "object" } },
      ],
      tool_choice: {
        type: "allowed_tools",
        tools: [{ type: "function", name: "collaboration__audit" }],
      },
      input: [{
        type: "function_call",
        call_id: "call-audit",
        name: "collaboration__audit",
        arguments: "{}",
      }],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    const result = prepared.body as typeof body;
    expect(result.tool_choice.tools[0]!.name).toBe("collaboration__audit");
    expect(result.input[0]!.name).toBe("collaboration__audit");
  });

  test("skips aliasing when a flat declaration collides with a namespace child", () => {
    const body = {
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [collaborationTool("spawn_agent")],
        },
        { type: "function", name: "collaboration__spawn_agent", parameters: { type: "object" } },
      ],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
  });

  test("aliases a recognized collaboration catalog even when the marker is already absent", () => {
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent", false)],
      }],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect((prepared.body as typeof body).tools[0]!.name)
      .toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect((prepared.body as typeof body).tools[0]!.tools[0]!.name)
      .toBe("start_delegated_task");
    expect(prepared.namespaceAliased).toBe(true);
  });

  test("leaves the whole request untouched when a collaboration child already uses a private tool alias", () => {
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [
          collaborationTool("spawn_agent"),
          collaborationTool("start_delegated_task"),
        ],
      }],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
  });

  test("leaves the whole request untouched when a top-level tool uses a fixed message alias", () => {
    const body = {
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [collaborationTool("spawn_agent")],
        },
        { type: "function", name: "start_delegated_task", parameters: { type: "object" } },
      ],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
  });

  test("leaves the whole request untouched when another namespace uses a fixed message alias", () => {
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent")],
      }],
      input: [{
        type: "additional_tools",
        tools: [{
          type: "namespace",
          name: "foreign",
          tools: [{ type: "function", name: "deliver_delegated_message", parameters: { type: "object" } }],
        }],
      }],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
  });

  test("scans tool-search declarations and foreign references for fixed message aliases", () => {
    const catalog = [{
      type: "namespace",
      name: "collaboration",
      tools: [collaborationTool("spawn_agent")],
    }];
    const cases = [
      {
        tools: catalog,
        input: [{
          type: "tool_search_output",
          tools: [{ type: "function", name: "continue_delegated_task", parameters: { type: "object" } }],
        }],
      },
      {
        tools: catalog,
        tool_choice: { type: "function", name: "start_delegated_task" },
      },
      {
        tools: catalog,
        input: [{
          type: "function_call",
          namespace: "foreign",
          name: "deliver_delegated_message",
          call_id: "foreign-call",
          arguments: "{}",
        }],
      },
    ];

    for (const body of cases) {
      const prepared = preparePlaintextV2AgentMessages(body);
      expect(prepared.body).toBe(body);
      expect(prepared.namespaceAliased).toBe(false);
    }
  });

  test("leaves the whole request untouched when replay history already uses a private tool alias", () => {
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent")],
      }],
      input: [{
        type: "function_call",
        call_id: "call-private-name",
        namespace: "collaboration",
        name: "start_delegated_task",
        arguments: "{}",
      }],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
  });

  test("leaves the whole request untouched when the private alias already exists", () => {
    const body = {
      tools: [
        { type: "namespace", name: PLAINTEXT_V2_COLLABORATION_NAMESPACE, tools: [] },
        {
          type: "namespace",
          name: "collaboration",
          tools: [collaborationTool("spawn_agent")],
        },
      ],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
    expect(JSON.stringify(prepared.body)).toContain('"encrypted":true');
  });

  test("leaves the request untouched when replay history already uses the private alias", () => {
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent")],
      }],
      input: [{
        type: "function_call",
        call_id: "call-private",
        namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
        name: "audit",
        arguments: "{}",
      }],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
  });

  test("leaves the request untouched when tool-search history declares the private alias", () => {
    const body = {
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent")],
      }],
      input: [{
        type: "tool_search_output",
        tools: [{
          type: "namespace",
          name: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
          tools: [],
        }],
      }],
    };

    const prepared = preparePlaintextV2AgentMessages(body);
    expect(prepared.body).toBe(body);
    expect(prepared.namespaceAliased).toBe(false);
  });

  test("does not treat a collaboration namespace nested under another namespace as Codex v2", () => {
    const depth = 20_000;
    const collaboration = {
      type: "namespace",
      name: "collaboration",
      tools: [collaborationTool("spawn_agent")],
    } as Record<string, unknown>;
    let root: Record<string, unknown> = collaboration;
    for (let index = 0; index < depth; index++) {
      root = { type: "namespace", name: `nest-${index}`, tools: [root] };
    }

    const prepared = preparePlaintextV2AgentMessages({ tools: [root] });
    expect(prepared.namespaceAliased).toBe(false);
  });
});

describe("plaintext v2 agent message response restoration", () => {
  const declaredToolNames = new Set(["spawn_agent", "send_message"]);

  test("restores tool identities and preserves the plaintext proof and user data", () => {
    const payload = JSON.stringify({
      type: "response.completed",
      response: {
        tool_choice: {
          type: "function",
          namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
          name: "start_delegated_task",
        },
        tools: [{
          type: "namespace",
          name: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
          tools: [{ type: "function", name: "start_delegated_task" }],
        }],
        output: [
          {
            type: "function_call",
            namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
            name: "start_delegated_task",
            arguments: JSON.stringify({
              message: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
            }),
            encrypted_function_args: [],
          },
          {
            type: "function_call",
            name: `${PLAINTEXT_V2_COLLABORATION_NAMESPACE}__deliver_delegated_message`,
            arguments: "{}",
            encrypted_function_args: [],
          },
          {
            type: "function_call_output",
            output: { namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE },
          },
        ],
      },
    });

    const restored = JSON.parse(
      restorePlaintextV2AgentMessageCallsInJson(payload, declaredToolNames),
    ) as {
      response: {
        tool_choice: Record<string, unknown>;
        tools: Array<Record<string, unknown>>;
        output: Array<Record<string, unknown>>;
      };
    };
    const [namespaced, flattened, toolOutput] = restored.response.output;

    expect(namespaced!.namespace).toBe("collaboration");
    expect(namespaced!.name).toBe("spawn_agent");
    expect(namespaced!.encrypted_function_args).toEqual([]);
    expect(JSON.parse(namespaced!.arguments as string).message)
      .toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(flattened!.name).toBe("send_message");
    expect(flattened!.encrypted_function_args).toEqual([]);
    expect(toolOutput!.output).toEqual({ namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE });
    expect(restored.response.tool_choice.namespace).toBe("collaboration");
    expect(restored.response.tool_choice.name).toBe("spawn_agent");
    expect(restored.response.tools[0]!.name).toBe("collaboration");
    expect((restored.response.tools[0]!.tools as Array<Record<string, unknown>>)[0]!.name)
      .toBe("spawn_agent");
  });

  test("restores the identity on streamed function-call argument completion", () => {
    const payload = JSON.stringify({
      type: "response.function_call_arguments.done",
      item_id: "fc-spawn",
      namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
      name: `${PLAINTEXT_V2_COLLABORATION_NAMESPACE}__start_delegated_task`,
      arguments: JSON.stringify({ message: PLAINTEXT_V2_COLLABORATION_NAMESPACE }),
      encrypted_function_args: [],
    });

    const restored = JSON.parse(
      restorePlaintextV2AgentMessageCallsInJson(payload, declaredToolNames),
    ) as Record<string, unknown>;
    expect(restored.namespace).toBe("collaboration");
    expect(restored.name).toBe("spawn_agent");
    expect(JSON.parse(restored.arguments as string).message)
      .toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(restored.encrypted_function_args).toEqual([]);
  });

  test("rejects invalid JSON but preserves valid payloads without aliases", () => {
    expect(() => restorePlaintextV2AgentMessageCallsInJson("not json", declaredToolNames)).toThrow(PlaintextV2AgentMessageRestoreOverflowError);
    const payload = '{"type":"response.completed"}';
    expect(restorePlaintextV2AgentMessageCallsInJson(payload, declaredToolNames)).toBe(payload);
  });

  test("restores an unqualified private tool alias in streamed JSON", () => {
    const payload = JSON.stringify({
      type: "function_call",
      name: "start_delegated_task",
      arguments: JSON.stringify({ message: "plain assignment" }),
      encrypted_function_args: [],
    });

    const restored = JSON.parse(
      restorePlaintextV2AgentMessageCallsInJson(payload, declaredToolNames),
    ) as Record<string, unknown>;
    expect(restored.name).toBe("spawn_agent");
    expect(restored.encrypted_function_args).toEqual([]);
  });

  test("does not restore a fixed alias authenticated by another namespace", () => {
    const payload = JSON.stringify({
      type: "function_call",
      namespace: "foreign",
      name: "start_delegated_task",
      arguments: "{}",
    });

    expect(restorePlaintextV2AgentMessageCallsInJson(payload, declaredToolNames)).toBe(payload);
  });

  test("restores only message aliases that this request actually generated", () => {
    const prepared = preparePlaintextV2AgentMessages({
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [
          collaborationTool("spawn_agent"),
          { type: "custom", name: "send_message" },
        ],
      }],
    });
    const payload = JSON.stringify({
      type: "function_call",
      name: "deliver_delegated_message",
      arguments: "{}",
    });

    expect([...prepared.aliasedAgentMessageToolNames]).toEqual(["spawn_agent"]);
    expect(() => restorePlaintextV2AgentMessageCallsInJson(
      payload,
      prepared.toolNames,
      prepared.aliasedAgentMessageToolNames,
    )).toThrow(PlaintextV2AgentMessageRestoreOverflowError);
  });

  test("leaves foreign calls and nested extension metadata untouched", () => {
    const extensionCall = {
      type: "function_call",
      namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
      name: "start_delegated_task",
    };
    const payload = JSON.stringify({
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            namespace: "foreign",
            name: "audit",
            arguments: "{}",
          },
          {
            type: "function_call",
            namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
            name: "start_delegated_task",
            arguments: "{}",
          },
        ],
        metadata: {
          nested: extensionCall,
          values: Array.from({ length: 20_000 }, (_, index) => index),
        },
      },
    });

    const restored = JSON.parse(
      restorePlaintextV2AgentMessageCallsInJson(payload, declaredToolNames),
    ) as {
      response: {
        output: Array<Record<string, unknown>>;
        metadata: { nested: Record<string, unknown>; values: number[] };
      };
    };

    expect(restored.response.output[0]!.namespace).toBe("foreign");
    expect(restored.response.output[1]!.namespace).toBe("collaboration");
    expect(restored.response.metadata.nested).toEqual(extensionCall);
    expect(restored.response.metadata.values).toHaveLength(20_000);
  });

  test("fails closed when known identity arrays exceed the work limit", () => {
    const value = {
      output: Array.from({ length: 10_001 }, () => ({
        type: "function_call",
        namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
        name: "start_delegated_task",
      })),
    };
    const payload = JSON.stringify(value);

    expect(restorePlaintextV2AgentMessageCallsInJsonResult(payload, declaredToolNames)).toEqual({
      value: payload,
      changed: false,
      overflowed: true,
    });
    expect(() => restorePlaintextV2AgentMessageCallsInJson(payload, declaredToolNames))
      .toThrow(PlaintextV2AgentMessageRestoreOverflowError);
    expect(restorePlaintextV2AgentMessageCalls(value, declaredToolNames)).toEqual({
      value,
      changed: false,
      overflowed: true,
    });
  });
});

describe("plaintext v2 agent message route policy", () => {
  test("requires an explicit opt-in, Responses inbound, canonical ChatGPT, and a v2 catalog", () => {
    const requestBody = { tools: [{ type: "namespace", name: "collaboration", tools: [collaborationTool("spawn_agent")] }] };
    const baseline = {
      enabled: true,
      inboundWire: "responses",
      canonicalChatGpt: true,
      requestBody,
    };
    expect(shouldPreparePlaintextV2AgentMessages(baseline)).toBe(true);
    const additionalOnly = { input: [{ type: "additional_tools", tools: requestBody.tools }] };
    expect(shouldPreparePlaintextV2AgentMessages({ ...baseline, requestBody: additionalOnly })).toBe(false);
    expect(preparePlaintextV2AgentMessages(additionalOnly).namespaceAliased).toBe(false);
    expect(shouldPreparePlaintextV2AgentMessages({ ...baseline, enabled: false })).toBe(false);
    expect(shouldPreparePlaintextV2AgentMessages({ ...baseline, inboundWire: "anthropic" })).toBe(false);
    expect(shouldPreparePlaintextV2AgentMessages({ ...baseline, canonicalChatGpt: false })).toBe(false);
    expect(shouldPreparePlaintextV2AgentMessages({
      ...baseline,
      requestBody: { tools: [collaborationTool("spawn_agent")] },
    })).toBe(false);
  });
});

describe("canonical Responses adapter plaintext v2 integration", () => {
  const provider = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward" as const,
  };

  function build(enabled: boolean) {
    const rawBody = {
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      input: "delegate",
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [collaborationTool("spawn_agent")],
      }],
    };
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: rawBody,
      ...(enabled ? { _plaintextV2AgentMessages: true } : {}),
    }, { headers: new Headers({ authorization: "Bearer test" }) });
    return { request, rawBody };
  }

  test("changes only the serialized upstream body when enabled", () => {
    const { request, rawBody } = build(true);
    const sent = JSON.parse(request.body) as typeof rawBody;
    const namespace = sent.tools[0]!;
    const spawn = namespace.tools[0] as Record<string, unknown>;
    const message = ((spawn.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).message;

    expect(namespace.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(spawn.name).toBe("start_delegated_task");
    expect(message.encrypted).toBeUndefined();
    expect([...(request.plaintextV2AgentMessageToolNames ?? [])]).toEqual(["spawn_agent"]);
    expect([...(request.plaintextV2AgentMessageAliasedToolNames ?? [])]).toEqual(["spawn_agent"]);
    expect(rawBody.tools[0]!.name).toBe("collaboration");
    expect(JSON.stringify(rawBody)).toContain('"encrypted":true');
  });

  test("keeps the upstream collaboration schema unchanged when disabled", () => {
    const { request, rawBody } = build(false);
    const sent = JSON.parse(request.body);

    expect(sent).toEqual(rawBody);
    expect(request.plaintextV2AgentMessageToolNames).toBeUndefined();
    expect(request.plaintextV2AgentMessageAliasedToolNames).toBeUndefined();
  });
});

describe("plaintext V2 refusal boundaries", () => {
  const names = new Set(["spawn_agent", "send_message"]);
  test("rejects malformed and non-object JSON even without literal aliases", () => {
    for (const payload of ["{broken", "[]", "null", '"opaque"']) {
      expect(restorePlaintextV2AgentMessageCallsInJsonResult(payload, names).overflowed).toBe(true);
    }
  });
  test("rejects unknown private identities instead of leaking an unrestorable alias", () => {
    expect(() => restorePlaintextV2AgentMessageCallsInJson(JSON.stringify({
      output: [{ type: "function_call", namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE, name: "undeclared", arguments: "{}" }],
    }), names)).toThrow(PlaintextV2AgentMessageRestoreOverflowError);
  });
  test("qualified aliases in nested foreign catalogs prevent any request rewrite", () => {
    for (const separator of ["__", "."]) {
      const body = { tools: [
        { type: "namespace", name: "collaboration", tools: [collaborationTool("spawn_agent")] },
        { type: "namespace", name: "foreign", tools: [{ type: "function", name: `other${separator}start_delegated_task` }] },
      ] };
      expect(preparePlaintextV2AgentMessages(body).body).toBe(body);
    }
  });
  test("preserves qualified names explicitly authenticated by a foreign namespace", () => {
    const payload = JSON.stringify({ type: "function_call", namespace: "foreign", name: `${PLAINTEXT_V2_COLLABORATION_NAMESPACE}__start_delegated_task`, arguments: "{}" });
    expect(restorePlaintextV2AgentMessageCallsInJson(payload, names)).toBe(payload);
  });
});

test("plaintext restoration refuses malformed identity arrays", () => {
  for (const value of [{ output: { name: "start_delegated_task" } }, { tools: "collaboration-optimize" }]) {
    expect(restorePlaintextV2AgentMessageCallsInJsonResult(JSON.stringify(value), new Set(["spawn_agent"])).overflowed).toBe(true);
  }
});


test("restores namespace selectors and allowed namespace choices", () => {
  const names = new Set(["spawn_agent"]);
  for (const choice of [
    { type: "namespace", name: PLAINTEXT_V2_COLLABORATION_NAMESPACE },
    { type: "allowed_tools", tools: [{ type: "namespace", name: PLAINTEXT_V2_COLLABORATION_NAMESPACE }] },
  ]) {
    const restored = restorePlaintextV2AgentMessageCallsInJson(JSON.stringify({ tool_choice: choice }), names);
    expect(restored).not.toContain(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(restored).toContain('"collaboration"');
  }
});

test("sparse argument events inherit only a compatible existing binding", () => {
  const rewrite = createPlaintextV2AgentMessageCallRestoreRewrite(new Set(["spawn_agent", "send_message"]));
  rewrite(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: {
    type: "function_call", id: "fc1", namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE, name: "start_delegated_task",
  } }));
  expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc1", name: "start_delegated_task", arguments: "{}" }))).name).toBe("spawn_agent");
  expect(() => rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc1", name: "deliver_delegated_message", arguments: "{}" }))).toThrow(PlaintextV2AgentMessageRestoreOverflowError);
});

test("request replay preserves explicit foreign namespace identity", () => {
  const replay = { type: "function_call", namespace: "foreign", name: "collaboration__spawn_agent", arguments: "{}" };
  const body = { tools: [{ type: "namespace", name: "collaboration", tools: [collaborationTool("spawn_agent")] }], input: [replay] };
  const prepared = preparePlaintextV2AgentMessages(body);
  expect(prepared.namespaceAliased).toBe(true);
  expect((prepared.body as typeof body).input[0]).toBe(replay);
});


test("namespace refinement follows every bound coordinate", () => {
  const rewrite = createPlaintextV2AgentMessageCallRestoreRewrite(new Set(["spawn_agent"]));
  rewrite(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: {
    type: "function_call", id: "fc1", call_id: "c1", name: "start_delegated_task",
  } }));
  rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc1", namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE, name: "start_delegated_task", arguments: "{}" }));
  expect(() => rewrite(JSON.stringify({ type: "response.completed", response: { output: [{
    type: "function_call", call_id: "c1", namespace: "foreign", name: "spawn_agent", arguments: "{}",
  }] } }))).toThrow(PlaintextV2AgentMessageRestoreOverflowError);
});


test("every generated alias spelling restores the exact native dispatch pair", () => {
  const names = new Set(["spawn_agent"]);
  for (const name of ["start_delegated_task", `${PLAINTEXT_V2_COLLABORATION_NAMESPACE}__start_delegated_task`, `${PLAINTEXT_V2_COLLABORATION_NAMESPACE}.start_delegated_task`]) {
    for (const [namespace, marker] of [undefined, null].flatMap(namespace => [undefined, [], ["message"]].map(marker => [namespace, marker] as const))) {
      const value = { type: "function_call", name, namespace, arguments: "{}", ...(marker === undefined ? {} : { encrypted_function_args: marker }) };
      const restored = JSON.parse(restorePlaintextV2AgentMessageCallsInJson(JSON.stringify(value), names));
      expect(restored).toMatchObject({ namespace: "collaboration", name: "spawn_agent" });
      expect(restored.encrypted_function_args).toEqual(marker);
    }
  }
  const snapshot = JSON.parse(restorePlaintextV2AgentMessageCallsInJson(JSON.stringify({
    tools: [{ type: "namespace", name: PLAINTEXT_V2_COLLABORATION_NAMESPACE, tools: [{ type: "function", name: "start_delegated_task", parameters: {} }] }],
    tool_choice: { type: "function", name: "start_delegated_task" },
  }), names));
  expect(snapshot.tools[0].tools[0]).toEqual({ type: "function", name: "spawn_agent", parameters: {} });
  expect(snapshot.tool_choice).toEqual({ type: "function", namespace: "collaboration", name: "spawn_agent" });
});

test("malformed namespace types cannot bypass private identity restoration", () => {
  for (const namespace of [false, 0, {}, []]) {
    const payload = JSON.stringify({ type: "function_call", namespace, name: "start_delegated_task", arguments: "{}" });
    expect(restorePlaintextV2AgentMessageCallsInJsonResult(payload, new Set(["spawn_agent"])).overflowed).toBe(true);
  }
});
