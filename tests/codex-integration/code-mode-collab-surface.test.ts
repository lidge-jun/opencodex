/**
 * Collaboration surface detection when Codex nests its collaboration tools inside code mode (#6844).
 *
 * Fixtures follow codex-rs build_exec_tool_description in code-mode-only mode: every ENABLED nested
 * tool is a top-level heading, its description, and an "exec tool declaration:" ts fence, with
 * namespaced tools flattened to <namespace>__<name>. When the model supports tool search codex-rs
 * DEFERS the V1 tools and renders none of them, which is the shape every OpenCodex catalog row
 * produces; that case must stay null because the request carries no V1 evidence.
 * Requests go through parseRequest so buildTools' flattening of the functions namespace and the
 * additional_tools envelope are exercised.
 */
import { describe, expect, test } from "bun:test";
import { collabSurface, multiAgentGuidanceText } from "../../src/server/responses";
import { MULTI_AGENT_MODE_HINT_RECOMMENDATION } from "../../src/codex/multi-agent-mode-policy";
import { effortCapAppliesTo } from "../../src/server/effort-policy";
import { parseRequest } from "../../src/responses/parser";
import type { OcxConfig } from "../../src/types";

const V1_PROACTIVE = `<multi_agent_mode>${MULTI_AGENT_MODE_HINT_RECOMMENDATION.text}</multi_agent_mode>`;
const TICK = "`";
const FENCE = "```";

const EXEC_TEMPLATE = [
  "Run JavaScript code to orchestrate/compose tool calls",
  "- All nested tools are available on the global " + TICK + "tools" + TICK + " object.",
  "- " + TICK + "ALL_TOOLS" + TICK + ": metadata for the enabled nested tools as { name, description } entries.",
].join("\n");
const DEFERRED_SENTENCE = "Some deferred nested tools may be omitted from this description. They are still available on the global "
  + TICK + "tools" + TICK + " object and listed in " + TICK + "ALL_TOOLS" + TICK + ".";

/** One nested tool section as codex-rs renders it, with a multi-line declaration. */
function nested(flatName: string, description = "Tool guidance."): string {
  return [
    "### " + TICK + flatName + TICK,
    description,
    "",
    "exec tool declaration:",
    FENCE + "ts",
    "declare const tools: { " + flatName + "(args: {",
    "  // Message for the agent.",
    "  message?: string;",
    "}): Promise<unknown>; };",
    FENCE,
  ].join("\n");
}

/** A tool heading line; codex-rs adds the raw name only when normalization changed it. */
function heading(name: string, raw?: string): string {
  return "### " + TICK + name + TICK + (raw ? " (" + TICK + raw + TICK + ")" : "");
}

/** A complete single-line declaration block, as a description might quote one. */
function exampleDeclaration(name: string, close = FENCE): string {
  return ["exec tool declaration:", FENCE + "ts", "declare const tools: { " + name + "(args: {}): Promise<unknown>; };", close].join("\n");
}

/** V1 spawn_agent's real description carries its own non-tool ### headings. */
const SPAWN_DESCRIPTION = [
  "Spawn a sub-agent for a well-scoped task.",
  "### When to delegate vs. do the subtask yourself",
  "- Delegate independent work.",
  "### After you delegate",
  "- Keep working.",
].join("\n");

const V1_SECTIONS = [
  "## multi_agent_v1\nTools for spawning and managing sub-agents.",
  nested("multi_agent_v1__close_agent"),
  nested("multi_agent_v1__resume_agent"),
  nested("multi_agent_v1__send_input"),
  nested("multi_agent_v1__spawn_agent", SPAWN_DESCRIPTION),
  nested("multi_agent_v1__wait_agent"),
];
const V2_SECTIONS = [
  nested("collaboration__followup_task"),
  nested("collaboration__interrupt_agent"),
  nested("collaboration__list_agents"),
  nested("collaboration__send_message"),
  nested("collaboration__spawn_agent"),
  nested("collaboration__wait_agent"),
];
const HELPER_SECTIONS = [nested("exec_command"), nested("write_stdin"), nested("clock__curr_time")];

function execDescription(...sections: string[]): string {
  return [EXEC_TEMPLATE, DEFERRED_SENTENCE, ...sections].join("\n\n");
}

function fn(name: string): Record<string, unknown> {
  return { type: "function", name, description: name + ".", parameters: { type: "object", properties: {} } };
}

/** The issue's envelope: functions (exec, wait, request_user_input), clock, and an MCP namespace. */
function codeModeTools(description: string, extra: unknown[] = []): unknown[] {
  return [
    { type: "namespace", name: "functions", description: "", tools: [
      { type: "custom", name: "exec", description, format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
      fn("wait"),
      fn("request_user_input"),
    ] },
    { type: "namespace", name: "clock", description: "", tools: [fn("sleep")] },
    { type: "namespace", name: "mcp__cua_repl", description: "", tools: [fn("js"), fn("js_reset")] },
    ...extra,
  ];
}

function request(tools: unknown[], effort = "max", viaAdditionalTools = false) {
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "split this work" }] };
  return parseRequest(viaAdditionalTools
    ? { model: "gpt-6.1-sol", stream: true, reasoning: { effort }, input: [{ type: "additional_tools", role: "developer", tools }, user] }
    : { model: "gpt-6.1-sol", stream: true, reasoning: { effort }, tools, input: [user] });
}

const surfaceOf = (tools: unknown[]) => collabSurface(request(tools));

describe("code mode that renders the V1 tools (#6844)", () => {
  const v1 = codeModeTools(execDescription(...HELPER_SECTIONS, ...V1_SECTIONS));

  test.each(["max", "ultra"])("%s emits the V1 proactive guidance", async effort => {
    const parsed = request(v1, effort);
    expect(collabSurface(parsed)).toBe("v1");
    expect(await multiAgentGuidanceText(parsed, { multiAgentGuidanceEnabled: true })).toBe(V1_PROACTIVE);
  });

  test("the additional_tools envelope is read the same way", async () => {
    const parsed = request(v1, "ultra", true);
    expect(collabSurface(parsed)).toBe("v1");
    expect(await multiAgentGuidanceText(parsed, { multiAgentGuidanceEnabled: true })).toBe(V1_PROACTIVE);
  });

  test("Medium stays silent and the disabled switch wins", async () => {
    expect(await multiAgentGuidanceText(request(v1, "medium"), { multiAgentGuidanceEnabled: true })).toBeNull();
    expect(await multiAgentGuidanceText(request(v1, "max"), { multiAgentGuidanceEnabled: false })).toBeNull();
  });

  test("the V1 spawn tool alone is enough; companions alone are not", () => {
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__spawn_agent"))))).toBe("v1");
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__send_input"), nested("multi_agent_v1__close_agent"))))).toBeNull();
  });

  test("direct V1 tools beside the rendered listing agree", () => {
    const direct = { type: "namespace", name: "multi_agent_v1", description: "", tools: [fn("spawn_agent"), fn("send_input")] };
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS), [direct]))).toBe("v1");
  });

  test("a direct MCP server tool with a companion's name does not veto the rendered listing", () => {
    // code-mode-only keeps direct-only MCP namespaces top-level; a messaging server's send_message is not V2.
    const mcp = { type: "namespace", name: "mcp__slack", description: "", tools: [fn("send_message"), fn("list_agents")] };
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS), [mcp]))).toBe("v1");
    const unprefixed = { type: "namespace", name: "messaging", description: "", tools: [fn("send_message")] };
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS), [unprefixed]))).toBeNull();
  });

  test("a heading-shaped line inside a fenced example does not cut the spawn section", () => {
    const example = [SPAWN_DESCRIPTION, FENCE + "md", "### " + TICK + "worker" + TICK, "Report back.", FENCE].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__spawn_agent", example))))).toBe("v1");
  });

  test("a configured usage hint with its own headings stays inside the spawn section", () => {
    // codex-rs copies multi_agent_v2.usage_hint_text into the V1 spawn description verbatim.
    const hinted = [SPAWN_DESCRIPTION, "## Usage", "Spawn reviewers in parallel.", "## multi_agent_v1"].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(...HELPER_SECTIONS, nested("multi_agent_v1__spawn_agent", hinted))))).toBe("v1");
  });

  test("an unfenced tool-shaped heading inside the spawn description does not take its declaration", () => {
    const described = [SPAWN_DESCRIPTION, "### " + TICK + "worker" + TICK, "A role you can request."].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__spawn_agent", described))))).toBe("v1");
  });

  test("a same-name V1 heading quoted in the spawn description does not replace the genuine owner", () => {
    const quoted = [SPAWN_DESCRIPTION, heading("multi_agent_v1__spawn_agent")].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__spawn_agent", quoted))))).toBe("v1");
  });

  test("a foreign-looking heading quoted in the spawn description fails closed", () => {
    // Copied text may push a turn toward null, never away from it.
    const quoted = [SPAWN_DESCRIPTION, heading("multi_agent_v1__spawn_agent", "multi-agent-v1__spawn_agent")].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__spawn_agent", quoted))))).toBeNull();
  });

  test("an example declaration inside the spawn description leaves the spawn section open", () => {
    const bare = [SPAWN_DESCRIPTION, exampleDeclaration("worker")].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__spawn_agent", bare))))).toBe("v1");
    const headed = [SPAWN_DESCRIPTION, "### " + TICK + "worker" + TICK, exampleDeclaration("worker")].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__spawn_agent", headed))))).toBe("v1");
  });

  test("an example declaration closed by a longer fence does not hide the V1 listing", () => {
    const namespace = "## docs\n" + exampleDeclaration("lookup", FENCE + TICK);
    expect(surfaceOf(codeModeTools(execDescription(namespace, nested("multi_agent_v1__spawn_agent"))))).toBe("v1");
  });
});

describe("code mode without V1 evidence stays null", () => {
  test("deferred V1 (every OpenCodex catalog row): the listing names no collaboration tool", async () => {
    const parsed = request(codeModeTools(execDescription(...HELPER_SECTIONS)), "ultra");
    expect(collabSurface(parsed)).toBeNull();
    expect(await multiAgentGuidanceText(parsed, { multiAgentGuidanceEnabled: true })).toBeNull();
  });

  test("code mode with no nested listing at all", () => {
    expect(surfaceOf(codeModeTools(EXEC_TEMPLATE))).toBeNull();
  });

  test("a heading without its own declaration is prose", () => {
    const prose = "### " + TICK + "multi_agent_v1__spawn_agent" + TICK + "\nMentioned in a guide.";
    expect(surfaceOf(codeModeTools(execDescription(prose, ...HELPER_SECTIONS)))).toBeNull();
  });

  test("a truncated declaration snippet is not a rendered tool", () => {
    const snippet = [
      "### " + TICK + "multi_agent_v1__spawn_agent" + TICK,
      "exec tool declaration:",
      FENCE + "ts",
      "declare const tools: { multi_agent_v1__spawn_agent(",
      FENCE,
    ].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("docs__lookup", snippet))))).toBeNull();
  });

  test.each([
    ["an abbreviated parameter list", "declare const tools: { multi_agent_v1__spawn_agent(...): Promise<unknown>; };"],
    ["an empty return type", "declare const tools: { multi_agent_v1__spawn_agent(args: {}): Promise<>; };"],
    ["an empty parameter type", "declare const tools: { multi_agent_v1__spawn_agent(args: ): Promise<unknown>; };"],
    ["a parameter type that is only a comment", "declare const tools: { multi_agent_v1__spawn_agent(args: /* none */): Promise<unknown>; };"],
    ["surplus text after the return type", "declare const tools: { multi_agent_v1__spawn_agent(args: {}): Promise<unknown>; garbage>; };"],
    ["an unbalanced parameter type", "declare const tools: { multi_agent_v1__spawn_agent(args: {: Promise<unknown>; };"],
    ["a return type missing its generic closer", "declare const tools: { multi_agent_v1__spawn_agent(args: {}): Promise<Map<string, unknown>; };"],
    ["an unterminated quoted return type", "declare const tools: { multi_agent_v1__spawn_agent(args: {}): Promise<\"unterminated>; };"],
    ["an unterminated block comment", "declare const tools: { multi_agent_v1__spawn_agent(args: {}): Promise<unknown /* truncated>; };"],
    ["a line comment consuming the closing suffix", "declare const tools: { multi_agent_v1__spawn_agent(args: {}): Promise<unknown // truncated>; };"],
  ])("%s is not a rendered declaration", (_label, declaration) => {
    const snippet = [heading("multi_agent_v1__spawn_agent"), "exec tool declaration:", FENCE + "ts", declaration, FENCE].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("docs__lookup", snippet))))).toBeNull();
  });

  test.each([
    ["a nested generic return type", "declare const tools: { multi_agent_v1__spawn_agent(args: {}): Promise<Map<string, unknown>>; };"],
    ["a function-typed parameter", "declare const tools: { multi_agent_v1__spawn_agent(args: (task: string) => void): Promise<unknown>; };"],
    ["a quoted bracket inside the parameter type", "declare const tools: { multi_agent_v1__spawn_agent(args: { choice: \")\" }): Promise<unknown>; };"],
    ["an apostrophe in a field line comment", "declare const tools: { multi_agent_v1__spawn_agent(args: {\n  // The agent's task.\n  message: string;\n}): Promise<unknown>; };"],
    ["an unmatched bracket in a field line comment", "declare const tools: { multi_agent_v1__spawn_agent(args: {\n  // Optional unmatched bracket ) in prose.\n  message: string;\n}): Promise<unknown>; };"],
    ["delimiters in a block comment", "declare const tools: { multi_agent_v1__spawn_agent(args: { /* ) < ' */ message: string }): Promise<unknown>; };"],
    ["a comment in the return type", "declare const tools: { multi_agent_v1__spawn_agent(args: {}): Promise</* ' < ) */ unknown>; };"],
    ["comment markers inside quoted type text", "declare const tools: { multi_agent_v1__spawn_agent(args: { marker: \"/* not a comment */ //\" }): Promise<\"// quoted < )\">; };"],
  ])("%s still completes the declaration", (_label, declaration) => {
    const snippet = [heading("multi_agent_v1__spawn_agent"), "exec tool declaration:", FENCE + "ts", declaration, FENCE].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("docs__lookup", snippet))))).toBe("v1");
  });

  test("a raw-name suffix that does not normalize to its heading is not a heading", () => {
    // Placed in the namespace description, ahead of the genuine heading it would otherwise outrank.
    const namespace = "## docs\n" + heading("docs__lookup", "multi_agent_v1__spawn_agent");
    expect(surfaceOf(codeModeTools(execDescription(namespace, nested("docs__lookup"))))).toBeNull();
  });

  test.each([["four backticks", "````"], ["tildes", "~~~"]])("a complete V1 section quoted in a %s fence", (_label, fence) => {
    // The lone three-backtick line is content: only the same character, at least as long, closes.
    const quoted = nested("docs__lookup", ["Example:", fence + "md", FENCE, nested("multi_agent_v1__spawn_agent"), fence].join("\n"));
    expect(surfaceOf(codeModeTools(execDescription(quoted)))).toBeNull();
  });

  test("a raw name from a foreign namespace that normalizes onto the V1 identifier", () => {
    // codex-rs normalizes multi-agent-v1__spawn_agent to multi_agent_v1__spawn_agent and keeps the raw
    // name in the heading suffix; the raw name decides the identity.
    const lookalike = nested("multi_agent_v1__spawn_agent").replace(
      "### " + TICK + "multi_agent_v1__spawn_agent" + TICK,
      "### " + TICK + "multi_agent_v1__spawn_agent" + TICK + " (" + TICK + "multi-agent-v1__spawn_agent" + TICK + ")",
    );
    expect(surfaceOf(codeModeTools(execDescription(lookalike)))).toBeNull();
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, lookalike)))).toBeNull();
  });

  test("an unprefixed MCP server imitating the V1 tool names", () => {
    expect(surfaceOf(codeModeTools(execDescription(nested("agents__spawn_agent"), nested("agents__send_input"))))).toBeNull();
  });
});

describe("code-mode V2 is distinct from V1 and keeps today's behaviour", () => {
  const v2 = codeModeTools(execDescription(...V2_SECTIONS));

  test("rendered V2 tools are not V1 evidence", async () => {
    const parsed = request(v2, "ultra");
    expect(collabSurface(parsed)).toBeNull();
    expect(await multiAgentGuidanceText(parsed, { multiAgentGuidanceEnabled: true })).toBeNull();
    expect(surfaceOf(codeModeTools(execDescription(nested("spawn_agent"), nested("send_message"))))).toBeNull();
  });

  test("the V2 effort-cap gate still sees no V2 surface", () => {
    const config = { multiAgentMode: "v2", effortCap: "high" } as unknown as OcxConfig;
    expect(effortCapAppliesTo(collabSurface(request(v2)), new Headers(), config)).toBe(false);
  });
});

describe("contradictory signals stay null", () => {
  test("V1 spawn beside a V2 companion", () => {
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, nested("collaboration__send_message"))))).toBeNull();
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, nested("multi_agent_v1__list_agents"))))).toBeNull();
  });

  test("V1 spawn beside another spawn_agent", () => {
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, nested("collaboration__spawn_agent"))))).toBeNull();
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, nested("server__spawn_agent"))))).toBeNull();
  });

  test("an example inside a V2 companion's description does not hide the contradiction", () => {
    const example = ["Send a message.", "### " + TICK + "worker" + TICK, exampleDeclaration("worker")].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, nested("collaboration__send_message", example))))).toBeNull();
  });

  test("a same-name heading inside a V2 companion's description does not hide the contradiction", () => {
    const quoted = ["Send a message.", heading("collaboration__send_message", "collaboration-_send_message")].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, nested("collaboration__send_message", quoted))))).toBeNull();
  });

  test("an orphan heading in an earlier namespace description does not hide a later V2 companion", () => {
    const orphan = "## a_docs\n" + heading("collaboration__send_message", "collaboration-_send_message");
    const listing = execDescription(orphan, nested("a_docs__lookup"), "## collaboration", nested("collaboration__send_message"), ...V1_SECTIONS);
    expect(surfaceOf(codeModeTools(listing))).toBeNull();
  });

  test("a V2 declaration quoted inside a fence still counts as a contradiction", () => {
    const example = ["Example:", FENCE + "ts", "declare const tools: { collaboration__send_message(args: {}): Promise<unknown>; };", FENCE].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, nested("docs__lookup", example))))).toBeNull();
  });

  test("an example closed with trailing whitespace does not swallow the next section", () => {
    const namespace = "## collaboration\n" + exampleDeclaration("lookup", FENCE + " ");
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, namespace, nested("collaboration__send_message"))))).toBeNull();
  });

  test("a direct flat spawn_agent beside the rendered V1 listing", () => {
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS), [fn("spawn_agent")]))).toBeNull();
  });

  test("a direct V2 surface beside the rendered V1 listing", () => {
    const direct = { type: "namespace", name: "collaboration", description: "", tools: [fn("spawn_agent"), fn("send_message")] };
    expect(surfaceOf([direct])).toBe("v2");
    const contradictory = surfaceOf(codeModeTools(execDescription(...V1_SECTIONS), [direct]));
    expect(contradictory).toBeNull();
    // Deliberate: the contradiction also withdraws the V2 main-turn effort cap that direct V2 alone gets.
    const config = { multiAgentMode: "v2", effortCap: "high" } as unknown as OcxConfig;
    expect(effortCapAppliesTo("v2", new Headers(), config)).toBe(true);
    expect(effortCapAppliesTo(contradictory, new Headers(), config)).toBe(false);
  });

  test("an MCP tool named spawn_agent does not contradict native V1", () => {
    expect(surfaceOf(codeModeTools(execDescription(...V1_SECTIONS, nested("mcp__agents__spawn_agent"))))).toBe("v1");
  });
});

describe("a caller-defined exec contributes no nested evidence", () => {
  const description = execDescription(...V1_SECTIONS);

  test("a structured function named exec", () => {
    expect(surfaceOf([{ type: "function", name: "exec", description, parameters: { type: "object", properties: {} } }])).toBeNull();
  });

  test("a namespaced exec", () => {
    expect(surfaceOf([{ type: "namespace", name: "mcp__sandbox", description: "", tools: [{ type: "custom", name: "exec", description }] }])).toBeNull();
  });

  test("exec beside a bare shell bridge is the flat-bridge shape", () => {
    expect(surfaceOf([{ type: "custom", name: "exec", description }, fn("exec_command")])).toBeNull();
  });

  test("a freeform exec without the codex-rs template", () => {
    const foreign = ["Runs a script.", ...V1_SECTIONS].join("\n\n");
    expect(surfaceOf([{ type: "custom", name: "exec", description: foreign }])).toBeNull();
  });
});

describe("an adversarial declaration body stays linear work", () => {
  // Regression: the declaration check must not backtrack per candidate Promise separator, and the
  // owner lookup must not re-validate the body once per pending heading. On the pre-fix regex this
  // ~393 KiB body starved the event loop for seconds well inside the default test timeout.
  const separators = "): Promise<a".repeat(32768);
  const listing = [
    "exec tool declaration:",
    FENCE + "ts",
    "declare const tools: { multi_agent_v1__spawn_agent(args: x" + separators,
    FENCE,
  ].join("\n");

  test("repeated Promise separators without a terminator are no declaration", () => {
    const section = [heading("multi_agent_v1__spawn_agent"), listing].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(section)))).toBeNull();
  });

  test("many pending same-name headings do not multiply the parse", () => {
    const headings = Array.from({ length: 256 }, () => heading("multi_agent_v1__spawn_agent")).join("\n");
    expect(surfaceOf(codeModeTools(execDescription(headings, listing)))).toBeNull();
  });

  test("a description beyond the nested-listing bound contributes no evidence", () => {
    const padded = SPAWN_DESCRIPTION + "\n" + "padding ".repeat(200_000);
    expect(surfaceOf(codeModeTools(execDescription(nested("multi_agent_v1__spawn_agent", padded))))).toBeNull();
  });

  test("comment-heavy declarations below the bound retain their evidence", () => {
    const comments = "/* ): Promise<' */".repeat(2048);
    const declaration = `declare const tools: { multi_agent_v1__spawn_agent(args: { ${comments} message: string }): Promise<unknown>; };`;
    expect(declaration.length).toBeLessThan(64 * 1024);
    const snippet = [heading("multi_agent_v1__spawn_agent"), "exec tool declaration:", FENCE + "ts", declaration, FENCE].join("\n");
    expect(surfaceOf(codeModeTools(execDescription(nested("docs__lookup", snippet))))).toBe("v1");
  });
});
