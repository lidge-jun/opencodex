/**
 * A fake `agy` for tests: `--version` prints 1.5.3; `acp` serves a minimal ACP v1 session over stdio.
 * It records the argv it was started with into AGY_FAKE_ARGS_FILE when that is set.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.AGY_FAKE_ARGS_FILE) appendFileSync(process.env.AGY_FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd() }) + "\n");
if (args[0] === "--version") {
  const file = process.env.AGY_FAKE_VERSION_FILE;
  const version = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { stdout: "1.5.3\n", exitCode: 0 };
  process.stdout.write(version.stdout);
  process.exit(version.exitCode);
}
if (args[0] !== "acp") process.exit(2);

let config = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-3.8-flash", options: [
  { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "gemini-4-argon", name: "Gemini 4 Argon" },
] }, { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "extra", options: [
  { value: "low", name: "Low" }, { value: "extra", name: "Extra" },
] }];
const write = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const frame = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (frame.method === "initialize") write({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (frame.method === "session/new") write({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "fake-1", configOptions: config } });
    else if (frame.method === "session/set_config_option") {
      config = config.map(option => option.id === frame.params.configId ? { ...option, currentValue: frame.params.value } : option);
      // The second model has no user-selectable thinking level.
      if (frame.params.value === "gemini-4-argon") config = config.filter(option => option.id !== "thought_level");
      write({ jsonrpc: "2.0", id: frame.id, result: { configOptions: config } });
    } else if (frame.method === "session/prompt") {
      const update = (sessionUpdate: string, text: string) =>
        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-1", update: { sessionUpdate, content: { type: "text", text } } } });
      const prompt = frame.params.prompt[0].text;
      if (prompt.includes("fixture refusal")) {
        write({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "refusal", usage: { inputTokens: 7, outputTokens: 2 } } });
        continue;
      }
      if (prompt.includes("fixture reasoning first")) {
        update("agent_thought_chunk", "o");
        update("agent_message_chunk", "short answer.");
      } else {
        update("agent_message_chunk", `fake acp answer for ${config[0]!.currentValue}`);
      }
      write({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
