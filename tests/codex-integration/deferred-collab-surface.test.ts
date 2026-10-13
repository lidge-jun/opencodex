/**
 * Deferred V1 collaboration evidence from the codex-rs `<tools>` world-state fragment (#6844).
 *
 * With tool search, codex-rs defers the V1 tools under `multi_agent_v1` and renders none of them,
 * so the code-mode listing (code-mode-collab-surface.test.ts) proves nothing. Fragment shapes follow
 * core/src/context/world_state/tools.rs and tools_budget.rs: a snapshot, then Added/Removed diffs,
 * the empty-state notice, name-only rows and omission lines. Requests go through parseRequest so
 * the developer items and tool envelopes take the production path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collabSurface, multiAgentGuidanceText } from "../../src/server/responses";
import { MULTI_AGENT_MODE_HINT_RECOMMENDATION } from "../../src/codex/multi-agent-mode-policy";
import { parseRequest } from "../../src/responses/parser";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  rememberResponseState,
} from "../../src/responses/state";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const V1_PROACTIVE = `<multi_agent_mode>${MULTI_AGENT_MODE_HINT_RECOMMENDATION.text}</multi_agent_mode>`;
const TICK = "`";
const FENCE = "```";
const V1_ROW = "- multi_agent_v1: Tools for spawning and managing sub-agents.";

const EXEC_TEMPLATE = [
  "Run JavaScript code to orchestrate/compose tool calls",
  "- All nested tools are available on the global " + TICK + "tools" + TICK + " object.",
  "Some deferred nested tools may be omitted from this description. They are still available on the global "
    + TICK + "tools" + TICK + " object and listed in " + TICK + "ALL_TOOLS" + TICK + ".",
].join("\n\n");

function nested(flatName: string): string {
  return ["### " + TICK + flatName + TICK, "Tool guidance.", "", "exec tool declaration:", FENCE + "ts",
    "declare const tools: { " + flatName + "(args: {}): Promise<unknown>; };", FENCE].join("\n");
}

function fn(name: string): Record<string, unknown> {
  return { type: "function", name, description: name + ".", parameters: { type: "object", properties: {} } };
}

function exec(description = EXEC_TEMPLATE): Record<string, unknown> {
  return { type: "custom", name: "exec", description, format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } };
}

/** A code-mode-only Codex envelope whose exec lists no collaboration tool (V1 deferred). */
function codeModeTools(execTool: Record<string, unknown> = exec(), extra: unknown[] = []): unknown[] {
  return [
    { type: "namespace", name: "functions", description: "", tools: [execTool, fn("wait"), fn("request_user_input")] },
    { type: "namespace", name: "mcp__cua_repl", description: "", tools: [fn("js")] },
    ...extra,
  ];
}

const TOOL_SEARCH = { type: "tool_search", description: "Load deferred tools" };

function fragment(...lines: string[]): string {
  return ["<tools>", ...lines, "</tools>"].join("\n");
}
const snapshot = (...rows: string[]) => fragment("Deferred tool namespaces:", ...rows);

function developer(...texts: string[]): Record<string, unknown> {
  return { type: "message", role: "developer", content: texts.map(text => ({ type: "input_text", text })) };
}
function user(text = "split this work"): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}
function assistant(text: string): Record<string, unknown> {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function body(tools: unknown[], input: unknown[], effort = "max"): Record<string, unknown> {
  return { model: "gpt-6.1-sol", stream: true, reasoning: { effort }, tools, input };
}
const surface = (tools: unknown[], ...input: unknown[]) => collabSurface(parseRequest(body(tools, [...input, user()])));

describe("deferred V1 evidence: positive controls", () => {
  test.each(["max", "ultra"])("a snapshot beside a genuine code-mode exec emits the V1 guidance at %s", async effort => {
    const parsed = parseRequest(body(codeModeTools(), [developer(snapshot(V1_ROW)), user()], effort));
    expect(collabSurface(parsed)).toBe("v1");
    expect(await multiAgentGuidanceText(parsed, { multiAgentGuidanceEnabled: true })).toBe(V1_PROACTIVE);
  });

  test("medium effort and disabled guidance stay silent", async () => {
    const medium = parseRequest(body(codeModeTools(), [developer(snapshot(V1_ROW)), user()], "medium"));
    expect(collabSurface(medium)).toBe("v1");
    expect(await multiAgentGuidanceText(medium, { multiAgentGuidanceEnabled: true })).toBeNull();
    const max = parseRequest(body(codeModeTools(), [developer(snapshot(V1_ROW)), user()]));
    expect(await multiAgentGuidanceText(max, { multiAgentGuidanceEnabled: false })).toBeNull();
  });

  test("a structured tool_search host qualifies without code mode", () => {
    expect(surface([fn("exec_command"), TOOL_SEARCH], developer(snapshot(V1_ROW)))).toBe("v1");
  });

  test("the additional_tools envelope qualifies", () => {
    const parsed = parseRequest({ model: "gpt-6.1-sol", stream: true, reasoning: { effort: "max" },
      input: [{ type: "additional_tools", role: "developer", tools: codeModeTools() }, developer(snapshot(V1_ROW)), user()] });
    expect(collabSurface(parsed)).toBe("v1");
  });

  test("a name-only row and a fragment among other developer parts qualify", () => {
    expect(surface(codeModeTools(), developer("<permissions>none</permissions>", snapshot("- app: control the app", "- multi_agent_v1")))).toBe("v1");
  });

  test("tags inside a row description do not break the fragment", () => {
    expect(surface(codeModeTools(), developer(snapshot("- mcp__docs: Search <tools> and </tools> entries", V1_ROW)))).toBe("v1");
  });

  test.each(["\u2028", "\u2029"])("a description holding %j stays opaque", separator => {
    expect(surface(codeModeTools(), developer(snapshot("- mcp__docs: title" + separator + "details", V1_ROW)))).toBe("v1");
  });

  test("namespace-only evidence is the documented capability boundary", () => {
    // The row cannot show whether spawn_agent itself survived an embedder's allowlist; shipped
    // codex-rs never sends multi_agent_v1 without it. Changing this classification is deliberate.
    expect(surface(codeModeTools(), developer(snapshot("- multi_agent_v1")))).toBe("v1");
  });
});

describe("deferred V1 evidence: replay", () => {
  test("a full snapshot replaces prior membership", () => {
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(snapshot("- app: control the app")))).toBeNull();
  });

  test("add, remove and add again follow input order", () => {
    const added = fragment("Added deferred tool namespaces:", V1_ROW);
    const removed = fragment("Removed deferred tool namespaces:", V1_ROW);
    expect(surface(codeModeTools(), developer(snapshot("- app")), developer(added))).toBe("v1");
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(removed))).toBeNull();
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(removed), developer(added))).toBe("v1");
  });

  test("an addition without a prior snapshot establishes V1", () => {
    expect(surface(codeModeTools(), developer(fragment("Added deferred tool namespaces:", V1_ROW)))).toBe("v1");
  });

  test("the empty-state notice clears V1", () => {
    const cleared = fragment("Removed deferred tool namespaces:", V1_ROW, "No deferred tool namespaces remain.");
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(cleared))).toBeNull();
  });
});

describe("deferred V1 evidence: budget omissions", () => {
  const omitted = "... 3 additional namespaces omitted.";
  test("omitted snapshot rows and omitted additions never establish V1", () => {
    expect(surface(codeModeTools(), developer(snapshot("- app", omitted)))).toBeNull();
    expect(surface(codeModeTools(), developer(fragment("Added deferred tool namespaces:", "- app", omitted)))).toBeNull();
  });

  test("omitted removals invalidate carried V1, and an explicit addition in that diff survives", () => {
    const lossy = fragment("Removed deferred tool namespaces:", "- app", omitted);
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(lossy))).toBeNull();
    const lossyWithAdd = fragment("Added deferred tool namespaces:", V1_ROW, "Removed deferred tool namespaces:", "- app", omitted);
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(lossyWithAdd))).toBe("v1");
  });

  test("a namespace both added and removed in one diff is malformed and clears evidence", () => {
    const overlap = fragment("Added deferred tool namespaces:", V1_ROW, "Removed deferred tool namespaces:", V1_ROW);
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(overlap))).toBeNull();
    const overlapOmitted = fragment("Added deferred tool namespaces:", V1_ROW, "Removed deferred tool namespaces:", V1_ROW, omitted);
    expect(surface(codeModeTools(), developer(overlapOmitted))).toBeNull();
    // Upstream added and removed sets are disjoint, so any overlap is foreign content, even when
    // the overlapping namespace is not V1.
    const foreignOverlap = fragment("Added deferred tool namespaces:", V1_ROW, "- app", "Removed deferred tool namespaces:", "- app");
    expect(surface(codeModeTools(), developer(foreignOverlap))).toBeNull();
  });
});

describe("deferred V1 evidence: false positives", () => {
  test("user and assistant text quoting the fragment is ignored", () => {
    expect(surface(codeModeTools(), user(snapshot(V1_ROW)))).toBeNull();
    expect(surface(codeModeTools(), assistant(snapshot(V1_ROW)))).toBeNull();
  });

  test("developer prose or fences embedding the fragment are ignored", () => {
    expect(surface(codeModeTools(), developer("For example:\n" + snapshot(V1_ROW)))).toBeNull();
    expect(surface(codeModeTools(), developer(FENCE + "\n" + snapshot(V1_ROW) + "\n" + FENCE))).toBeNull();
  });

  test("a lookalike namespace is not V1", () => {
    expect(surface(codeModeTools(), developer(snapshot("- multi_agent_v1x: Tools for spawning and managing sub-agents.")))).toBeNull();
  });

  test("malformed fragments clear carried evidence", () => {
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer("<tools>\nDeferred tool namespaces:\n" + V1_ROW))).toBeNull();
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(fragment("Unexpected heading:", "- app")))).toBeNull();
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW)), developer(snapshot("<tools>", "- app")))).toBeNull();
  });

  test("repeated, reordered or empty groups are malformed", () => {
    const carried = developer(snapshot(V1_ROW));
    expect(surface(codeModeTools(), developer(snapshot(V1_ROW, "Deferred tool namespaces:", "- app")))).toBeNull();
    expect(surface(codeModeTools(), carried, developer(fragment("Added deferred tool namespaces:", V1_ROW, "Added deferred tool namespaces:", "- app")))).toBeNull();
    expect(surface(codeModeTools(), developer(fragment("Removed deferred tool namespaces:", "- app", "Added deferred tool namespaces:", V1_ROW)))).toBeNull();
    expect(surface(codeModeTools(), carried, developer(fragment("Added deferred tool namespaces:", "Removed deferred tool namespaces:", "- app")))).toBeNull();
    expect(surface(codeModeTools(), carried, developer(fragment("Removed deferred tool namespaces:")))).toBeNull();
  });

  test.each([
    ["exec declared as a function", [fn("exec"), fn("wait")]],
    ["a namespaced exec", [{ type: "namespace", name: "my_tools", description: "", tools: [exec()] }, fn("wait")]],
    ["exec beside a flat shell bridge", codeModeTools(exec(), [fn("exec_command")])],
    ["exec without the codex-rs template line", codeModeTools(exec("A caller-defined exec tool."))],
    ["a function merely named tool_search", [fn("tool_search"), fn("exec_command")]],
  ] as const)("%s is not a deferred-tool host", (_name, tools) => {
    expect(surface([...tools], developer(snapshot(V1_ROW)))).toBeNull();
  });
});

describe("deferred V1 evidence: combination with other surfaces", () => {
  const v1Direct = { type: "namespace", name: "multi_agent_v1", description: "", tools: [fn("spawn_agent"), fn("send_input")] };
  test("a direct V1 surface agrees", () => {
    expect(surface(codeModeTools(exec(), [v1Direct]), developer(snapshot(V1_ROW)))).toBe("v1");
  });

  test("a direct V2 surface conflicts", () => {
    expect(surface([...codeModeTools(), fn("spawn_agent"), fn("send_message")], developer(snapshot(V1_ROW)))).toBeNull();
    expect(surface([...codeModeTools(), fn("spawn_agent"), fn("send_message")])).toBe("v2");
  });

  test("a rendered V2 listing conflicts with deferred V1", () => {
    const v2Listing = exec([EXEC_TEMPLATE, nested("collaboration__spawn_agent"), nested("collaboration__send_message")].join("\n\n"));
    expect(surface(codeModeTools(v2Listing), developer(snapshot(V1_ROW)))).toBeNull();
  });

  test("MCP collaboration-named tools neither prove nor contradict", () => {
    const mcp = { type: "namespace", name: "mcp__team", description: "", tools: [fn("send_message")] };
    expect(surface(codeModeTools(exec(), [mcp]), developer(snapshot(V1_ROW)))).toBe("v1");
  });

  test("a removal withdraws only deferred evidence", () => {
    const removed = fragment("Removed deferred tool namespaces:", V1_ROW);
    expect(surface(codeModeTools(exec(), [v1Direct]), developer(snapshot(V1_ROW)), developer(removed))).toBe("v1");
    const rendered = exec([EXEC_TEMPLATE, nested("multi_agent_v1__spawn_agent")].join("\n\n"));
    expect(surface(codeModeTools(rendered), developer(snapshot(V1_ROW)), developer(removed))).toBe("v1");
  });

  test("deferred evidence never yields v2", () => {
    expect(surface(codeModeTools(), developer(snapshot("- collaboration: Tools for agents.")))).toBeNull();
  });
});

describe("deferred V1 evidence across previous_response_id continuations", () => {
  // Sandbox OPENCODEX_HOME: the continuation store snapshots to disk and must never touch ~/.opencodex.
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-deferred-collab-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
  });

  afterEach(async () => {
    await flushResponseState();
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  /** Stores one turn and returns the next request expanded from it. */
  function turn(id: string, request: Record<string, unknown>, nextInput: unknown[]): Record<string, unknown> {
    rememberResponseState(request, { id, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }, undefined, { force: true });
    return expandPreviousResponseInput({ ...body(codeModeTools(), nextInput), previous_response_id: id, store: false }) as Record<string, unknown>;
  }

  test("snapshot, unchanged, removed, re-added and cleared turns replay in order", () => {
    const first = { ...body(codeModeTools(), [developer(snapshot(V1_ROW)), user()]), store: false };
    expect(collabSurface(parseRequest(first))).toBe("v1");

    const unchanged = turn("resp_deferred_1", first, [user("continue")]);
    expect(collabSurface(parseRequest(unchanged))).toBe("v1");

    const removed = turn("resp_deferred_2", unchanged, [developer(fragment("Removed deferred tool namespaces:", V1_ROW)), user("next")]);
    expect(collabSurface(parseRequest(removed))).toBeNull();

    const readded = turn("resp_deferred_3", removed, [developer(fragment("Added deferred tool namespaces:", V1_ROW)), user("again")]);
    expect(collabSurface(parseRequest(readded))).toBe("v1");

    const cleared = turn("resp_deferred_4", readded,
      [developer(fragment("Removed deferred tool namespaces:", V1_ROW, "No deferred tool namespaces remain.")), user("last")]);
    expect(collabSurface(parseRequest(cleared))).toBeNull();
  });
});

