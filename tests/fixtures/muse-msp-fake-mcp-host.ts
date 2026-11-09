// Test-only host: starts the supplied capture-only MCP child, never real Muse or tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
let buffered = "", client: Client | undefined, alias = "";
let accountReads = 0;
const parallelResults = new Map<string, string>();
const notifyFinal = (text: string) => {
  send({ jsonrpc: "2.0", method: "item/completed", params: { sessionId: "s", item: { itemId: "i", turnId: "t", kind: "agentMessage", text } } });
  send({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s", turnId: "t", terminal: "completed" } });
};
async function handle(message: any): Promise<void> {
  if (message.method === "initialize") reply(message.id, { serverInfo: { version: "fake" }, schema: { version: 1 }, grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral", experimentalApi: message.params?.capabilities?.experimentalApi === true });
  else if (message.method === "account/read") reply(message.id, { state: ++accountReads >= 3 && process.env.OCX_TEST_ACCOUNT_SWITCH === "1" ? "apiKey" : "accountLogin", credentialRequired: true });
  else if (message.method === "session/start") {
    if (process.env.OCX_TEST_EXPECT_DEVELOPER) {
      const path = join(process.env.XDG_CONFIG_HOME!, "muse", "settings.json");
      const settings = JSON.parse(await readFile(path, "utf8"));
      if (settings.run?.developer_prompt !== process.env.OCX_TEST_EXPECT_DEVELOPER || settings.permissions?.default_profile !== ":ask-me") throw new Error("bad settings");
    }
    const config = message.params.config.mcpServers.opencodex;
    client = new Client({ name: "fake-host", version: "1" });
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...config.env }, stderr: "pipe" }));
    alias = (await client.listTools()).tools[0]!.name;
    reply(message.id, { session: { sessionId: "s" } });
  } else if (message.method === "turn/start") {
    if (process.env.OCX_TEST_EXPECT_USER && message.params.input?.[0]?.text !== process.env.OCX_TEST_EXPECT_USER) throw new Error("bad user input");
    if (process.env.OCX_TEST_PRETOOL_TEXT) send({ jsonrpc: "2.0", method: "item/completed", params: { sessionId: "s",
      item: { itemId: "pre", turnId: "t", kind: "agentMessage", text: process.env.OCX_TEST_PRETOOL_TEXT } } });
    const params = { sessionId: "s", turnId: "t", approvalId: "a", toolCallId: "upstream", toolName: `mcp__opencodex__${alias}`, rawArgs: '{"input":"patch text"}',
      currentRequirementId: { approvalId: "a", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }] };
    send({ jsonrpc: "2.0", method: "approval/requested", params });
    if (process.env.OCX_TEST_PARALLEL === "1") send({ jsonrpc: "2.0", method: "approval/requested", params: {
      ...params, approvalId: "b", toolCallId: "upstream-2", rawArgs: '{"input":"patch two"}', currentRequirementId: { approvalId: "b", sourceIndex: 0 },
    } });
    reply(message.id, { commandId: message.params.commandId, status: "accepted", disposition: "started", turnId: "t" });
  } else if (message.method === "approval/decide") {
    const second = message.params.approvalId === "b";
    reply(message.id, { commandId: message.params.commandId, status: "accepted", approvalId: message.params.approvalId, terminal: true });
    const result = await client!.callTool({ name: alias, arguments: { input: second ? "patch two" : "patch text" }, _meta: { callId: second ? "upstream-2" : "upstream" } });
    const content = result.content as Array<{ text?: string }>;
    const text = content[0]?.text ?? "missing result";
    if (process.env.OCX_TEST_PARALLEL !== "1") notifyFinal(text);
    else {
      parallelResults.set(message.params.approvalId, text);
      if (parallelResults.size === 2) notifyFinal(`${parallelResults.get("a")}|${parallelResults.get("b")}`);
    }
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  for (;;) {
    const end = buffered.indexOf("\n");
    if (end < 0) break;
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    void handle(JSON.parse(line)).catch(() => process.exit(1));
  }
});
process.stdin.on("end", () => { void (client?.close() ?? Promise.resolve()).finally(() => process.exit(0)); });
