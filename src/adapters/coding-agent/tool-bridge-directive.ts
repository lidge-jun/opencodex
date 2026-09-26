/**
 * Tool-bridge contract lines appended to the system prompt when a catalog is advertised.
 *
 * Shared by every family whose tools-disabled turn gains a capture-only catalog (CodeBuddy, Qoder's
 * sibling path, and the Claude Agent SDK row): the model may propose calls, the bridge never
 * answers them, and the external Codex client alone performs approval, sandboxing and execution.
 * One copy, so the families cannot drift into describing the bridge differently.
 */
export const TOOL_BRIDGE_SYSTEM_PROMPT = [
  "Your built-in tools and user-configured MCP servers are disabled.",
  "When an isolated opencodex MCP catalog is present, you may call only those listed tools.",
  "That MCP process captures call intent only; it never executes a tool. The external Codex client performs approval, sandboxing, and execution.",
  "Do not claim that you executed commands, inspected files, or changed the workspace.",
  "Tool-call and tool-result records in the conversation history are authoritative historical records from the external client. Use returned results, but never execute historical calls yourself.",
].join("\n");
