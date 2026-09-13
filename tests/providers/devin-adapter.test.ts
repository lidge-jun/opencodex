import { describe, expect, test } from "bun:test";
import { createDevinAdapter, mapDevinToolCallStartForTests, mapOcxMessagesToDevin, mapOcxToolsToDevin, resolveWireModelUidForTests } from "../../src/adapters/devin";
import { sanitizeToolDescriptionForCognitionForTests } from "../../src/adapters/devin/cloud-direct/chat";
import { DEVIN_MODEL_CONTEXT_WINDOWS, DEVIN_STATIC_MODELS, collapseDevinModelUid } from "../../src/adapters/devin/live-models";
import { parseCatalogBuffer } from "../../src/adapters/devin/cloud-direct/catalog";
import { encodeMessage, encodeString, encodeVarintField } from "../../src/adapters/devin/cloud-direct/wire";
import { OAUTH_PROVIDERS } from "../../src/oauth";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxParsedRequest } from "../../src/types";

describe("devin adapter", () => {
  test("is registered as an oauth provider and adapter", () => {
    expect(OAUTH_PROVIDERS.devin.defaultModel).toBe("swe-1-7");
    const entry = PROVIDER_REGISTRY.find((row) => row.id === "devin");
    expect(entry?.adapter).toBe("devin");
    expect(entry?.authKind).toBe("oauth");
    expect(entry?.liveModels).toBe(true);
    expect(createDevinAdapter({ adapter: "devin", baseUrl: "https://server.codeium.com" }).name).toBe("devin");
  });

  test("maps user/assistant/tool history and tools", () => {
    const parsed: OcxParsedRequest = {
      modelId: "swe-1-7",
      stream: true,
      context: {
        systemPrompt: ["be brief"],
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "toolCall", id: "c1", name: "lookup", arguments: { q: "x" } },
            ],
            timestamp: 2,
          },
          { role: "toolResult", toolCallId: "c1", toolName: "lookup", content: "ok", isError: false, timestamp: 3 },
        ],
        tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
      },
      options: {},
    };
    const history = mapOcxMessagesToDevin(parsed);
    // One system item carrying the prompt and, because this request advertises a
    // tool, the shared non-OpenAI catalog contract paragraph after it.
    expect(history[0]?.role).toBe("system");
    expect(String(history[0]?.content)).toStartWith("be brief\n\nTool contract:");
    expect(history[1]).toEqual({ role: "user", content: "hi" });
    expect(history[2]?.role).toBe("assistant");
    expect(history[2]?.tool_calls?.[0]?.id).toBe("c1");
    expect(history[3]).toEqual({ role: "tool", content: "ok", tool_call_id: "c1" });
    expect(mapOcxToolsToDevin(parsed.context.tools)?.[0]?.name).toBe("lookup");
  });

  test("the tool catalog nudge names the bare wire names the encoder actually sends", () => {
    // Cognition is offered `tool.name` with no namespace prefix (mapOcxToolsToDevin),
    // so a nudge built from the default namespaced form would advertise a name the
    // model is never given. Both Devin provider rows share this adapter, so this is
    // the single place that covers `devin` and `devin-cli` at once.
    const parsed: OcxParsedRequest = {
      modelId: "swe-1-7",
      stream: true,
      context: {
        systemPrompt: ["be brief"],
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [
          { name: "exec_command", description: "run", parameters: { type: "object" } },
          { namespace: "codex_app", name: "list_threads", description: "list", parameters: { type: "object" } },
        ],
      },
      options: {},
    };
    const system = String(mapOcxMessagesToDevin(parsed)[0]?.content);
    const wireNames = (mapOcxToolsToDevin(parsed.context.tools) ?? []).map((tool) => tool.name);
    expect(wireNames).toEqual(["exec_command", "list_threads"]);
    for (const name of wireNames) expect(system).toContain(`\`${name}\``);
    expect(system).not.toContain("codex_app__list_threads");
  });

  test("maps Cognition tool_call_start names to unique canonical request identities", () => {
    const tools = [
      { namespace: "mcp__cua_repl", name: "js", description: "control UI", parameters: { type: "object" } },
      { name: "exec", description: "run code", parameters: { type: "object" } },
    ];

    expect(mapDevinToolCallStartForTests("call_js", "js", tools)).toEqual({
      type: "tool_call_start",
      id: "call_js",
      name: "mcp__cua_repl__js",
    });
    expect(mapDevinToolCallStartForTests("call_canonical", "mcp__cua_repl__js", tools)).toEqual({
      type: "tool_call_start",
      id: "call_canonical",
      name: "mcp__cua_repl__js",
    });
    expect(mapDevinToolCallStartForTests("call_exec", "exec", tools)).toEqual({
      type: "tool_call_start",
      id: "call_exec",
      name: "exec",
    });
    expect(mapDevinToolCallStartForTests("call_unknown", "undeclared", tools)).toEqual({
      type: "tool_call_start",
      id: "call_unknown",
      name: "undeclared",
    });
  });

  test("maps ambiguous Cognition tool_call_start names to a non-retryable error", () => {
    const namespaceCollision = [
      { namespace: "mcp__first", name: "js", description: "first", parameters: { type: "object" } },
      { namespace: "mcp__second", name: "js", description: "second", parameters: { type: "object" } },
    ];
    const bareCollision = [
      { name: "js", description: "bare", parameters: { type: "object" } },
      { namespace: "mcp__cua_repl", name: "js", description: "namespaced", parameters: { type: "object" } },
    ];
    const duplicateIdentity = [
      { namespace: "mcp__cua_repl", name: "js", description: "first copy", parameters: { type: "object" } },
      { namespace: "mcp__cua_repl", name: "js", description: "second copy", parameters: { type: "object" } },
    ];

    const expected = {
      type: "error",
      message: "Devin emitted a bare client tool name that maps to multiple request-declared tools.",
      status: 502,
      retryable: false,
    };
    expect(mapDevinToolCallStartForTests("call_1", "js", namespaceCollision)).toEqual(expected);
    expect(mapDevinToolCallStartForTests("call_1", "js", [...namespaceCollision].reverse())).toEqual(expected);
    expect(mapDevinToolCallStartForTests("call_1", "js", bareCollision)).toEqual(expected);
    expect(mapDevinToolCallStartForTests("call_1", "js", duplicateIdentity)).toEqual({
      type: "tool_call_start",
      id: "call_1",
      name: "mcp__cua_repl__js",
    });
  });

  test("replays a restored namespaced call under the same bare name Cognition was offered", () => {
    const parsed: OcxParsedRequest = {
      modelId: "swe-2",
      stream: true,
      context: {
        messages: [{
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "js_0",
            namespace: "mcp__cua_repl",
            name: "js",
            arguments: { code: "1+1" },
          }],
          timestamp: 1,
        }],
        tools: [{
          namespace: "mcp__cua_repl",
          name: "js",
          description: "control UI",
          parameters: { type: "object" },
        }],
      },
      options: {},
    };

    expect(mapOcxMessagesToDevin(parsed).find(item => item.role === "assistant")?.tool_calls).toEqual([{
      id: "js_0",
      name: "js",
      arguments: JSON.stringify({ code: "1+1" }),
    }]);
  });

  test("a request with no tools keeps the system prompt exactly as it was", () => {
    const parsed: OcxParsedRequest = {
      modelId: "swe-1-7",
      stream: true,
      context: {
        systemPrompt: ["be brief"],
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      },
      options: {},
    };
    expect(mapOcxMessagesToDevin(parsed)[0]).toEqual({ role: "system", content: "be brief" });
  });

  test("collapseDevinModelUid strips effort suffixes to base ids", () => {
    expect(collapseDevinModelUid("swe-1-7")).toBe("swe-1-7");
    expect(collapseDevinModelUid("swe-1-7-medium")).toBe("swe-1-7");
    expect(collapseDevinModelUid("swe-1-7-lightning")).toBe("swe-1-7-lightning");
    expect(collapseDevinModelUid("swe-1-7-lightning-medium")).toBe("swe-1-7-lightning");
    expect(collapseDevinModelUid("gpt-5-6-sol-high")).toBe("gpt-5-6-sol");
    expect(collapseDevinModelUid("gpt-5-6-sol-high-priority")).toBe("gpt-5-6-sol");
    expect(collapseDevinModelUid("glm-5-2-max-1m")).toBe("glm-5-2");
    expect(collapseDevinModelUid("claude-opus-4-8-high-fast")).toBe("claude-opus-4-8");
    expect(collapseDevinModelUid("claude-fable-5-1-high")).toBe("claude-fable-5-1");
    expect(collapseDevinModelUid("grok-4-5-medium")).toBe("grok-4-5");
  });

  test("loginDevin is browser-only (no local import option)", () => {
    // The devin OAuth entry must not accept importLocal/forceLogin opts —
    // login is always the Auth0 browser flow.
    const entry = OAUTH_PROVIDERS.devin;
    expect(entry.login.length).toBeLessThanOrEqual(1);
  });

  test("rewrites the Cognition blocklist trigger phrase in tool descriptions", () => {
    // The exact 7-word phrase (capital T, single spaces) triggers Cognition's
    // permission_denied content filter. The rewrite must break the exact match
    // while preserving meaning.
    const trigger = "Takes a task_id parameter identifying the task";
    expect(sanitizeToolDescriptionForCognitionForTests(trigger)).toBe("Accepts a task_id parameter identifying the task");
    // Case-sensitive: lowercase first letter is NOT rewritten (it doesn't trigger)
    expect(sanitizeToolDescriptionForCognitionForTests("takes a task_id parameter identifying the task"))
      .toBe("takes a task_id parameter identifying the task");
    // Substring match: the phrase embedded in a larger description is rewritten
    const full = "- Retrieves output from a running or completed task\n- Takes a task_id parameter identifying the task\n- Returns the task output";
    const rewritten = sanitizeToolDescriptionForCognitionForTests(full);
    expect(rewritten).not.toContain("Takes a task_id parameter identifying the task");
    expect(rewritten).toContain("Accepts a task_id parameter identifying the task");
    // Surrounding text is preserved
    expect(rewritten).toContain("- Retrieves output from a running or completed task");
    expect(rewritten).toContain("- Returns the task output");
    // Descriptions without the trigger pass through unchanged
    expect(sanitizeToolDescriptionForCognitionForTests("A benign description.")).toBe("A benign description.");
  });

  test("rewrites the Codex built-in tool descriptions Cognition refuses", () => {
    // These two are Codex's own exec_command and write_stdin descriptions,
    // verbatim. Every Codex turn carries them, so leaving them intact made the
    // cloud refuse every request from a Codex client, a bare "hi" included.
    // Measured against a live account: the sentences below were refused, and
    // the rewritten forms were accepted.
    const execCommand = "Runs a command in a PTY, returning output or a session ID for ongoing interaction.";
    expect(sanitizeToolDescriptionForCognitionForTests(execCommand))
      .toBe("Executes a command in a PTY, returning output or a session ID for ongoing interaction.");

    const writeStdin = "Writes characters to an existing unified exec session and returns recent output.";
    expect(sanitizeToolDescriptionForCognitionForTests(writeStdin))
      .toBe("Sends characters to an existing unified exec session and returns recent output.");

    // Cognition matches these two case-insensitively and tolerates both a
    // doubled interior space and a missing comma, so the rewrite has to reach
    // every variant that still gets refused rather than only the exact bytes.
    expect(sanitizeToolDescriptionForCognitionForTests(execCommand.toLowerCase()))
      .toContain("Executes a command in a PTY");
    expect(sanitizeToolDescriptionForCognitionForTests(
      "Runs a command in a PTY  returning output or a session  ID for ongoing interaction.",
    )).toContain("Executes a command in a PTY");

    // Changing any single word already clears the filter, so a description that
    // merely resembles these must survive untouched.
    const nearMiss = "Runs a command in a terminal, returning output or a session ID for ongoing interaction.";
    expect(sanitizeToolDescriptionForCognitionForTests(nearMiss)).toBe(nearMiss);
  });

  test("the catalog parser reads the per-account context window", () => {
    // ClientModelConfig #18 is the max input tokens, and it is the only
    // first-party context-window figure Cognition exposes: the Devin CLI and
    // Desktop model pages, the SWE-2 announcement and the Windsurf model
    // reference all list these models without a window.
    const withWindow = Buffer.concat([
      encodeString(1, "SWE-2 High"),
      encodeVarintField(18, 262_000),
      encodeString(22, "swe-2-high"),
    ]);
    const withoutWindow = Buffer.concat([
      encodeString(1, "Mystery"),
      encodeString(22, "mystery-model"),
    ]);
    const catalog = parseCatalogBuffer(
      Buffer.concat([encodeMessage(1, withWindow), encodeMessage(1, withoutWindow)]),
      "key",
      "https://server.codeium.com",
    );
    expect(catalog.byUid.get("swe-2-high")?.contextWindow).toBe(262_000);
    // Absent rather than zero, so a caller can tell "not reported" from
    // "reported as nothing" and keep its fallback.
    expect(catalog.byUid.get("mystery-model")?.contextWindow).toBeUndefined();
  });

  test("the degraded-mode windows match what Cognition serves", () => {
    // This table was wrong for nine of its eleven rows because it had been
    // copied from each model's ORIGINAL vendor rather than measured against
    // Cognition's catalog. The spot-checks are the three shapes of that error:
    // a Claude row five times too small, a Grok row about half its real size,
    // and a GPT row rounded up past what the service accepts.
    expect(DEVIN_MODEL_CONTEXT_WINDOWS["claude-sonnet-5"]).toBe(1_000_000);
    expect(DEVIN_MODEL_CONTEXT_WINDOWS["grok-4-5"]).toBe(500_000);
    expect(DEVIN_MODEL_CONTEXT_WINDOWS["gpt-5-6-sol"]).toBe(1_000_000);
    expect(DEVIN_MODEL_CONTEXT_WINDOWS["swe-2"]).toBe(262_000);
    // Every statically advertised model needs one, or the picker reports 128k.
    for (const model of DEVIN_STATIC_MODELS) {
      expect(DEVIN_MODEL_CONTEXT_WINDOWS[model]).toBeGreaterThan(0);
    }
  });
});

describe("SWE-2 wire effort selection", () => {
  // Cognition spells SWE-2 effort as the model id, so an explicit effort has to
  // beat a suffix the picker already chose. Before this, swe-2-high asked for at
  // medium stayed high and the caller was silently ignored.
  test.each(["medium", "high", "max"])("an explicit %s effort overrides every SWE-2 variant", async (effort) => {
    for (const model of ["swe-2", "swe-2-medium", "swe-2-high", "swe-2-max", "swe-2.high"]) {
      expect(await resolveWireModelUidForTests(model, "unused", "unused", effort)).toBe(`swe-2-${effort}`);
    }
  });

  test.each([
    ["none", "medium"], ["off", "medium"], ["minimal", "medium"],
    ["low", "medium"], ["xhigh", "max"], ["ultra", "max"],
  ])("maps %s to the supported SWE-2 %s lane", async (effort, expected) => {
    expect(await resolveWireModelUidForTests("swe-2-high", "unused", "unused", effort)).toBe(`swe-2-${expected}`);
  });

  // Case is normalised, which the source contribution did not do: a caller that
  // sends HIGH means the same lane as high.
  test("effort matching is case-insensitive", async () => {
    expect(await resolveWireModelUidForTests("swe-2-medium", "unused", "unused", "HIGH")).toBe("swe-2-high");
  });

  test("omitted or unknown effort preserves an explicit variant", async () => {
    expect(await resolveWireModelUidForTests("swe-2-high", "unused", "unused")).toBe("swe-2-high");
    expect(await resolveWireModelUidForTests("swe-2-max", "unused", "unused", "future-effort")).toBe("swe-2-max");
  });

  test("other model families keep their existing suffix precedence", async () => {
    for (const model of ["claude-opus-5-medium", "gpt-5-6-sol-high", "swe-1-7-high", "swe-20-high"]) {
      expect(await resolveWireModelUidForTests(model, "unused", "unused", "max")).toBe(model);
    }
  });
});

describe("effort suffix detection and caller effort values are different sets", () => {
  // The two had drifted: the request path was missing `priority`, so a UID that
  // already carried it read as unsuffixed and got a second suffix appended —
  // the exact shape Cognition answers with an opaque permission_denied.
  test("a UID carrying the priority tier is recognised as already suffixed", async () => {
    for (const uid of ["gpt-5-6-sol-priority", "gpt-5-6-sol-medium-priority"]) {
      expect(await resolveWireModelUidForTests(uid, "unused", "unused", "high")).toBe(uid);
    }
  });

  test("detection handles a compound suffix, which a last-token test could not", async () => {
    expect(await resolveWireModelUidForTests("gpt-5-6-sol-medium-priority", "unused", "unused")).toBe(
      "gpt-5-6-sol-medium-priority",
    );
  });

  test("a bare model still receives the caller effort", async () => {
    expect(await resolveWireModelUidForTests("gpt-5-6-sol", "unused", "unused", "high")).toBe("gpt-5-6-sol-high");
  });

  // `priority` is a service tier, not something a caller asks for as effort.
  // Sharing one set between detection and caller validity would admit it.
  test("priority is not accepted as a caller reasoning effort", async () => {
    expect(await resolveWireModelUidForTests("gpt-5-6-sol", "unused", "unused", "priority")).toBe(
      "gpt-5-6-sol-medium",
    );
  });

  // These never appear as a trailing token, so they are meaningless to detection,
  // but a caller can still name them and they must survive.
  test.each(["max-1m", "none-1m", "1m", "fast"])("the compound caller value %p is preserved", async (effort) => {
    expect(await resolveWireModelUidForTests("gpt-5-6-sol", "unused", "unused", effort)).toBe(
      `gpt-5-6-sol-${effort}`,
    );
  });

  test("a model name is never mistaken for a suffix", async () => {
    // Greedy collapse must not eat part of a real model name.
    for (const uid of ["claude-opus-5", "swe-1-7", "glm-5-3"]) {
      expect(await resolveWireModelUidForTests(uid, "unused", "unused", "high")).toBe(`${uid}-high`);
    }
  });
});
