/**
 * Multi-agent compatibility shims (follow-up to devlog/260709_v2_gated_ultra):
 * models are no longer v1-pinned by ocx, but legacy/v1-surface requests still need
 * the Proactive delegation prompt when they arrive with the synthetic top tier.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectDeveloperMessage, multiAgentGuidanceText, sanitizeEncryptedContentInPlace } from "../src/server/responses";
import { parseRequest } from "../src/responses/parser";
import type { OcxParsedRequest } from "../src/types";

const savedCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

function codexHomeFixture(configToml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-v1pin-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), configToml);
  process.env.CODEX_HOME = dir;
  return dir;
}

/** Write an injected-catalog fixture into the active CODEX_HOME. */
function catalogFixture(dir: string, models: Array<{ slug: string; efforts: string[] }>): void {
  writeFileSync(join(dir, "opencodex-catalog.json"), JSON.stringify({
    models: models.map(m => ({
      slug: m.slug,
      display_name: m.slug,
      supported_reasoning_levels: m.efforts.map(effort => ({ effort, description: effort })),
    })),
  }));
}

const V2_ON = "[features.multi_agent_v2]\nenabled = true\n";
const V2_OFF = "[features]\nmulti_agent = true\n";

function parsedFixture(over: {
  reasoning?: string;
  tools?: Array<{ name: string; namespace?: string }>;
  rawInput?: unknown;
}): OcxParsedRequest {
  return {
    modelId: "gpt-5.5",
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: (over.tools ?? [{ name: "spawn_agent" }]) as never,
    },
    stream: true,
    options: over.reasoning ? { reasoning: over.reasoning as never } : {},
    _rawBody: { model: "gpt-5.5", input: over.rawInput ?? [] },
  };
}

describe("multiAgentGuidanceText", () => {
  test("v1 tool surface + max injects the tagged Proactive text", async () => {
    codexHomeFixture(V2_OFF); // guidance fires regardless of v2 flag
    const text = await multiAgentGuidanceText(parsedFixture({
      reasoning: "max",
      tools: [{ name: "spawn_agent", namespace: "agents" }, { name: "send_input", namespace: "agents" }],
    }));
    expect(text).toContain("<multi_agent_mode>");
    expect(text).toContain("Proactive multi-agent delegation is active");
  });

  test("v1 tool surface below the top tier stays silent", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [{ name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "high", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ tools: v1Tools }))).toBeNull();
  });

  test("v2 or non-agent tool surfaces stay silent even at max", async () => {
    codexHomeFixture(V2_OFF);
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent" }] }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: [{ name: "shell" }] }))).toBeNull();
  });

  test("flat v2 surface + injectionModel injects the designation with fork_turns rules", async () => {
    codexHomeFixture(V2_ON);
    const v2Tools = [{ name: "spawn_agent" }];
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "medium", tools: v2Tools }),
      "anthropic/claude-sonnet-5",
    );
    expect(text).toContain("<multi_agent_mode>");
    expect(text).toContain('"anthropic/claude-sonnet-5"');
    expect(text).toContain("fork_turns");
    expect(text).toContain('"none"');
    // schema hides model on native backends — the prompt must pre-empt schema doubt
    expect(text).toContain("never claim sub-agent models cannot be selected");
    // codex-rs supplies the Proactive text on v2 — the proxy must NOT duplicate it.
    expect(text).not.toContain("Proactive multi-agent delegation is active");
  });

  test("NATIVE v2 wire shape (collaboration namespace + v2 companions) is classified v2", async () => {
    codexHomeFixture(V2_ON);
    // The ChatGPT backend registers reserved namespaced collab tools:
    // collaboration.spawn_agent + send_message/followup_task/wait_agent/... (spec_plan.rs)
    const nativeV2 = [
      { name: "spawn_agent", namespace: "collaboration" },
      { name: "send_message", namespace: "collaboration" },
      { name: "followup_task", namespace: "collaboration" },
      { name: "wait_agent", namespace: "collaboration" },
      { name: "list_agents", namespace: "collaboration" },
    ];
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "medium", tools: nativeV2 }),
      "anthropic/claude-sonnet-5",
    );
    expect(text).toContain('"anthropic/claude-sonnet-5"');
    expect(text).toContain("fork_turns");
    expect(text).not.toContain("Proactive multi-agent delegation is active");
    // and WITHOUT an injectionModel it stays silent (codex-rs owns the v2 Proactive text)
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "ultra", tools: nativeV2 }))).toBeNull();
  });

  test("responses_lite WS shape: tools inside input additional_tools are seen (real Codex Desktop capture)", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{ slug: "gpt-5.6-terra", efforts: ["high", "max", "ultra"] }]);
    // Shape captured live from Codex Desktop 0.143.0 (responses_websockets lite): NO body.tools;
    // an input item {type:"additional_tools", role, tools:[...]} carries the tool specs.
    const parsed = parseRequest({
      model: "gpt-5.6-sol",
      stream: true,
      reasoning: { effort: "high" },
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "custom", name: "exec", description: "..." },
            { type: "function", name: "wait", description: "...", parameters: {} },
            { type: "namespace", name: "collaboration", description: "...", tools: [
              { type: "function", name: "followup_task", description: "...", parameters: {} },
              { type: "function", name: "interrupt_agent", description: "...", parameters: {} },
              { type: "function", name: "list_agents", description: "...", parameters: {} },
              { type: "function", name: "send_message", description: "...", parameters: {} },
              { type: "function", name: "spawn_agent", description: "...", parameters: {} },
              { type: "function", name: "wait_agent", description: "...", parameters: {} },
            ] },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "gpt-5.6-terra 호출해봐" }] },
      ],
    });
    const names = (parsed.context.tools ?? []).map(t => (t.namespace ? `${t.namespace}.${t.name}` : t.name));
    expect(names).toContain("collaboration.spawn_agent");
    const text = await multiAgentGuidanceText(parsed, "gpt-5.6-sol", "xhigh", ["gpt-5.6-terra"]);
    expect(text).toContain("never claim sub-agent models cannot be selected");
    expect(text).toContain('(reasoning_effort high/max/ultra): "gpt-5.6-terra"');
  });

  test("v1 wire shape (multi_agent_v1 namespace + send_input) still classifies v1", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [
      { name: "spawn_agent", namespace: "multi_agent_v1" },
      { name: "send_input", namespace: "multi_agent_v1" },
      { name: "wait_agent", namespace: "multi_agent_v1" },
      { name: "close_agent", namespace: "multi_agent_v1" },
    ];
    const text = await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v1Tools }));
    expect(text).toContain("Proactive multi-agent delegation is active");
  });

  test("subagentModels roster: per-model ladders on v2; v1 carries NO roster", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "gpt-5.6-sol", efforts: ["high", "max", "ultra"] },
      { slug: "anthropic/claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh"] },
    ]);
    const roster = ["gpt-5.6-sol", "anthropic/claude-sonnet-5", "missing/model"];
    const v2 = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      "anthropic/claude-sonnet-5", undefined, roster,
    );
    // differing ladders -> per-model annotation
    expect(v2).toContain('"gpt-5.6-sol" (high/max/ultra)');
    expect(v2).toContain('"anthropic/claude-sonnet-5" (low/medium/high/xhigh)');
    expect(v2).not.toContain("missing/model"); // not in the catalog -> omitted

    const v1 = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent", namespace: "multi_agent_v1" }, { name: "send_input", namespace: "multi_agent_v1" }] }),
      undefined, undefined, roster,
    );
    expect(v1).toContain("Proactive multi-agent delegation is active");
    expect(v1).not.toContain("Available models"); // v1 stays lean: Proactive text only
  });

  test("roster is silent when unset or nothing resolves in the catalog", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{ slug: "gpt-5.5", efforts: ["low", "medium"] }]);
    const v1Tools = [{ name: "spawn_agent", namespace: "multi_agent_v1" }, { name: "send_input", namespace: "multi_agent_v1" }];
    const unset = await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v1Tools }));
    expect(unset).not.toContain("Available models");
    // an UNRESOLVED roster does not fire guidance on v2 either
    expect(await multiAgentGuidanceText(parsedFixture({ tools: [{ name: "spawn_agent" }] }), undefined, undefined, ["nope/none"])).toBeNull();
  });

  test("v2 surface + injectionModel + injectionEffort names both", async () => {
    codexHomeFixture(V2_ON);
    const text = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      "opencode-go/glm-5.2",
      "xhigh",
    );
    expect(text).toContain('Preferred sub-agent: model "opencode-go/glm-5.2", reasoning_effort "xhigh"');
  });

  test("injectionPrompt override replaces the v2 body with placeholder substitution", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{ slug: "gpt-5.6-terra", efforts: ["high", "max"] }]);
    const custom = "CUSTOM RULES model={{model}} effort={{effort}}{{roster}}";
    const v2 = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      "gpt-5.6-terra", "max", ["gpt-5.6-terra"], custom,
    );
    expect(v2).toBe("<multi_agent_mode>CUSTOM RULES model=gpt-5.6-terra effort=max"
      + " Available models (reasoning_effort high/max): \"gpt-5.6-terra\".</multi_agent_mode>");
    const v1 = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent", namespace: "multi_agent_v1" }, { name: "send_input", namespace: "multi_agent_v1" }] }),
      undefined, undefined, undefined, "V1 BODY {{model}}|{{effort}}|{{roster}}",
    );
    // v1 ignores injectionPrompt entirely — it only mirrors the upstream Proactive text
    expect(v1).toContain("Proactive multi-agent delegation is active");
    expect(v1).not.toContain("V1 BODY");
    // gates unchanged: custom prompt does NOT make a bare v2 surface fire
    expect(await multiAgentGuidanceText(parsedFixture({ tools: [{ name: "spawn_agent" }] }), undefined, undefined, undefined, custom)).toBeNull();
  });

  test("v2 surface without injectionModel AND without roster stays silent at every effort", async () => {
    codexHomeFixture(V2_ON);
    const v2Tools = [{ name: "spawn_agent" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "ultra", tools: v2Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v2Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "medium", tools: v2Tools }))).toBeNull();
  });

  test("v2 surface + roster alone (no injectionModel) fires with the argument-acceptance preamble", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{ slug: "gpt-5.6-terra", efforts: ["high", "max", "ultra"] }]);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "medium", tools: [{ name: "spawn_agent" }] }),
      undefined, undefined, ["gpt-5.6-terra"],
    );
    expect(text).toContain("never claim sub-agent models cannot be selected");
    expect(text).toContain('(reasoning_effort high/max/ultra): "gpt-5.6-terra"');
    expect(text).not.toContain("Preferred sub-agent");
  });

  test("ambiguous mixed surface (both spawn shapes) stays silent even with injectionModel", async () => {
    codexHomeFixture(V2_ON);
    const mixed = [{ name: "spawn_agent" }, { name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: mixed }), "anthropic/claude-sonnet-5")).toBeNull();
    // contradictory companions (v1 send_input + v2 send_message) also veto
    const contradictory = [
      { name: "spawn_agent", namespace: "collaboration" },
      { name: "send_input", namespace: "collaboration" },
      { name: "send_message", namespace: "collaboration" },
    ];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: contradictory }), "anthropic/claude-sonnet-5")).toBeNull();
  });

  test("v2 flag off still fires guidance (ultra is always-on)", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(parsedFixture({
      reasoning: "max",
      tools: [{ name: "spawn_agent", namespace: "agents" }],
    }));
    expect(text).toContain("<multi_agent_mode>");
  });

  test("v1 at max carries ONLY the Proactive text — no designation payload", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent", namespace: "agents" }] }),
      "anthropic/claude-sonnet-5", "xhigh", ["anthropic/claude-sonnet-5"],
    );
    expect(text).toContain("Proactive multi-agent delegation is active");
    expect(text).not.toContain("anthropic/claude-sonnet-5");
    expect(text).not.toContain("Preferred sub-agent");
    expect(text).not.toContain("Available models");
  });

  test("v1 injectionModel does NOT relax the top-tier gate", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [{ name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "high", tools: v1Tools }), "opencode-go/glm-5.2")).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ tools: v1Tools }), "anthropic/claude-opus-4-6")).toBeNull();
  });

  test("without injectionModel, low effort stays silent", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [{ name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "high", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "medium", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v1Tools }))).not.toBeNull();
  });

  test("v2 body stays within the 700-char budget with a full 5-model roster", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "opencode-go/glm-5.2", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "anthropic/claude-opus-4-6", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "gpt-5.6-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "gpt-5.6-terra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ]);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "high", tools: [{ name: "spawn_agent" }] }),
      "gpt-5.6-sol", "xhigh",
      ["gpt-5.5", "opencode-go/glm-5.2", "anthropic/claude-opus-4-6", "gpt-5.6-sol", "gpt-5.6-terra"],
    );
    const body = text!.replace(/^<multi_agent_mode>/, "").replace(/<\/multi_agent_mode>$/, "");
    expect(body.length).toBeLessThanOrEqual(700);
    expect(body).toContain("Available models"); // roster fits inside the budget
  });
});

describe("injectDeveloperMessage", () => {
  test("appends to both the parsed messages and the raw passthrough input", () => {
    const parsed = parsedFixture({ reasoning: "max" });
    injectDeveloperMessage(parsed, "hello there");
    const last = parsed.context.messages.at(-1)!;
    expect(last.role).toBe("developer");
    expect(last.content).toBe("hello there");
    const rawInput = (parsed._rawBody as { input: unknown[] }).input;
    expect(rawInput.at(-1)).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "hello there" }],
    });
  });

  test("string raw input is left alone", () => {
    const parsed = parsedFixture({ reasoning: "max", rawInput: "plain" });
    injectDeveloperMessage(parsed, "note");
    expect((parsed._rawBody as { input: unknown }).input).toBe("plain");
    expect(parsed.context.messages.at(-1)!.content).toBe("note");
  });

  test("inserts BEFORE compaction_trigger so it stays the final input item", () => {
    const parsed = parsedFixture({ reasoning: "max" });
    const rawBody = parsed._rawBody as { input: unknown[] };
    rawBody.input = [
      { type: "message", role: "user", content: "long conversation" },
      { type: "compaction_trigger" },
    ];
    injectDeveloperMessage(parsed, "guidance text");
    const input = rawBody.input;
    expect(input).toHaveLength(3);
    expect((input[1] as { type: string }).type).toBe("message");
    expect((input[1] as { role: string }).role).toBe("developer");
    expect((input[2] as { type: string }).type).toBe("compaction_trigger");
  });
});

describe("sanitizeEncryptedContentInPlace", () => {
  test("plaintext parked in encrypted slots becomes input_text; real blobs survive", () => {
    const blob = "gAAAAAB".padEnd(120, "Qw1_-=");
    const input = [
      { type: "message", role: "user", content: [
        { type: "encrypted_content", encrypted_content: "[CXC-LEAF-GUARD] plain text with spaces" },
        { type: "input_text", text: "untouched" },
      ] },
      { type: "function_call_output", call_id: "c1", output: { content: [
        { type: "encrypted_content", encrypted_content: blob },
        { type: "encrypted_content", encrypted_content: "short" },
      ] } },
    ];
    const rewritten = sanitizeEncryptedContentInPlace(input);
    expect(rewritten).toBe(2);
    const msgParts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(msgParts[0]).toEqual({ type: "input_text", text: "[CXC-LEAF-GUARD] plain text with spaces" });
    expect(msgParts[1]).toEqual({ type: "input_text", text: "untouched" });
    const outParts = ((input[1] as { output: { content: Array<Record<string, unknown>> } }).output).content;
    expect(outParts[0]).toEqual({ type: "encrypted_content", encrypted_content: blob });
    expect(outParts[1]).toEqual({ type: "input_text", text: "short" });
  });

  test("non-array input is a no-op", () => {
    expect(sanitizeEncryptedContentInPlace("plain")).toBe(0);
    expect(sanitizeEncryptedContentInPlace(undefined)).toBe(0);
  });

  test("mixed slot (hook preamble + embedded Fernet task) splits into text + encrypted parts", () => {
    const fernet = "gAAAA" + "Ab1_-".repeat(20) + "==";
    const input = [
      { type: "message", role: "user", content: [
        { type: "encrypted_content", encrypted_content: `[CXC-LEAF-GUARD] follow the rules.\n\n${fernet}` },
      ] },
    ];
    expect(sanitizeEncryptedContentInPlace(input)).toBe(1);
    const parts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "input_text", text: "[CXC-LEAF-GUARD] follow the rules.\n\n" });
    expect(parts[1]).toEqual({ type: "encrypted_content", encrypted_content: fernet });
  });

  test("pure Fernet slot stays byte-identical", () => {
    const fernet = "gAAAA" + "Ab1_-".repeat(20) + "==";
    const input = [
      { type: "message", role: "user", content: [
        { type: "encrypted_content", encrypted_content: fernet },
      ] },
    ];
    expect(sanitizeEncryptedContentInPlace(input)).toBe(0);
    const parts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts[0]).toEqual({ type: "encrypted_content", encrypted_content: fernet });
  });
});

describe("spawn-message delivery (agent_message + encrypted slot)", () => {
  test("sanitize-then-parse delivers the spawn task payload as a user message on routed paths", () => {
    // Mirrors handleResponses order: sanitize and normalize the RAW input, then parseRequest.
    // Regression for spawned sub-agents receiving empty task payloads when the routed parser
    // does not understand agent_message and its task rides in a plaintext encrypted slot.
    const body = {
      model: "anthropic/claude-fable-5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "env context" }] },
        { type: "agent_message", author: "/root", recipient: "/root/worker", content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: "TASK: build the thing exactly as specified." },
        ] },
      ],
    };
    expect(sanitizeEncryptedContentInPlace(body.input)).toBe(1);
    expect(body.input[1]).toMatchObject({ type: "message", role: "user" });
    const parsed = parseRequest(body);
    const users = parsed.context.messages.filter(m => m.role === "user");
    expect(users).toHaveLength(2);
    const content = users[1].content;
    const flat = typeof content === "string"
      ? content
      : (content as Array<{ type: string; text?: string }>).map(p => p.text ?? "").join("");
    expect(flat).toContain("Message Type: NEW_TASK");
    expect(flat).toContain("TASK: build the thing exactly as specified.");
  });
});
