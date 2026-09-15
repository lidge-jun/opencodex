// Deterministic guard-level check: does opencodex accept a provider echo of a
// collaboration tool by its BARE name (the production failure), or reject it?
import { parseRequest } from "./src/responses/parser";
import { buildToolBridgeMaps } from "./src/server/responses";
import { undeclaredToolCallNameInResponse } from "./src/server/responses-undeclared-tool-guard";

const collab = ["spawn_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "list_agents"]
  .map(name => ({ type: "function", name, description: name, strict: false, parameters: { type: "object", properties: {}, required: [] } }));

const parsed = parseRequest({
  model: "meta/muse-spark-1.3-contributor",
  input: [
    { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "collaboration", tools: collab }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "run list_agents" }] },
  ],
} as any);

const maps = buildToolBridgeMaps(parsed as any);
// Simulate EXACTLY the production failure: provider emits the tool with the bare name.
const providerResponse = {
  output: [{ type: "function_call", call_id: "call_1", name: "list_agents", arguments: "{}" }],
};
const rejected = undeclaredToolCallNameInResponse(providerResponse, maps.declaredToolNames);
console.log(rejected
  ? `REJECTED: bare echo "${rejected}" (declared list-ish names: ${[...maps.declaredToolNames].filter(n => n.includes("list")).join(", ") || "none"})`
  : "ACCEPTED: bare echo resolved to a declared identity");
