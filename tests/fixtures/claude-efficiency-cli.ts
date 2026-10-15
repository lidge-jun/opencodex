import { readFileSync } from "node:fs";
const args = JSON.parse(process.argv[2]!) as string[];
const fixture = process.argv[3]!;
// Only the owned synthetic probe uses this deliberate defect to calibrate its HTTP assertions.
const cacheWrite = process.argv[4] === "omit-cache-creation" ? 0 : 80;
let input = "";
for await (const chunk of process.stdin) input += chunk;
const frame = JSON.parse(input.trim());
const current = frame.message.content.at(-1).text as string;
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const mcpPath = args[args.indexOf("--mcp-config") + 1];
const mcp = mcpPath ? JSON.parse(readFileSync(mcpPath, "utf8")) : undefined;
const catalogPath = mcp?.mcpServers?.opencodex?.args?.at(-1);
const catalog = catalogPath ? JSON.parse(readFileSync(catalogPath, "utf8")) : [];
emit({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
if (current.includes("WAIT_FOR_ABORT")) {
  setInterval(() => {}, 1000);
} else if (current.startsWith("TOOL RESULT")) {
  if (!current.includes("PROBE_FILE_CONTENT_42")) throw new Error("The host did not return the actual fixture content");
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "PROBE_FILE_CONTENT_42" } } });
  emit({ type: "result", subtype: "success", usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 30, cache_creation_input_tokens: cacheWrite } });
} else {
  if (catalog.length !== 1) throw new Error("Unexpected isolated tool catalog");
  emit({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 2, cache_read_input_tokens: 30, cache_creation_input_tokens: cacheWrite } } } });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "probe_call", name: `mcp__opencodex__${catalog[0].name}` } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: fixture }) } } });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  // Capture-only CLI waits for the host; the adapter must terminate this owned child.
  setInterval(() => {}, 1000);
}
