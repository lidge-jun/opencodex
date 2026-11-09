// Test-only MSP host: plain text turns.
let buffered = "", turn = 0;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  for (;;) {
    const end = buffered.indexOf("\n"); if (end < 0) break;
    const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { version: "fake" }, schema: { version: 1 }, grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral" } });
    else if (message.method === "usage/read") send({ jsonrpc: "2.0", id: message.id, result: process.env.OCX_TEST_NO_QUOTA ? {} : { usage: { observedAtMs: 1800000000000, window: { usedPercent: 12, resetsAtMs: 1800000100000, windowDurationMins: 300 }, weekly: { usedPercent: 34, resetsAtMs: 1800000200000 } } } });
    else if (message.method === "session/start") send({ jsonrpc: "2.0", id: message.id, result: { session: { sessionId: "s" } } });
    else if (message.method === "turn/start") {
      if (process.env.OCX_TEST_EXPECT_CLIENT_HINT === "1") {
        const input = message.params.input?.[0]?.text;
        if (typeof input !== "string" || !input.includes("mcp__opencodex__exec") || !input.includes("ALL_TOOLS") || !input.includes("repeat previous tests")) process.exit(1);
      }
      const turnId = `t${++turn}`;
      send({ jsonrpc: "2.0", id: message.id, result: { commandId: message.params.commandId, status: "accepted", disposition: "started", turnId } });
      const finish = (text: string) => {
        send({ jsonrpc: "2.0", method: "item/completed", params: { sessionId: "s", item: { itemId: `i${turn}`, turnId, kind: "agentMessage", text } } });
        send({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s", turnId, terminal: "completed" } });
      };
      finish(`answer ${turn}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
