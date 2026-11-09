// Test-only MSP host: plain text turns; the optional model probe uses the supplied loopback gateway.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
      const turnId = `t${++turn}`;
      send({ jsonrpc: "2.0", id: message.id, result: { commandId: message.params.commandId, status: "accepted", disposition: "started", turnId } });
      const finish = (text: string) => {
        send({ jsonrpc: "2.0", method: "item/completed", params: { sessionId: "s", item: { itemId: `i${turn}`, turnId, kind: "agentMessage", text } } });
        send({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s", turnId, terminal: "completed" } });
      };
      if (process.env.OCX_TEST_SECOND_SEND !== "1") finish(`answer ${turn}`);
      else void (async () => {
        const settings = JSON.parse(await readFile(join(process.env.XDG_CONFIG_HOME!, "muse", "settings.json"), "utf8"));
        const url = `${settings.endpoint_transport.base_url}/responses`;
        const sendModel = async () => {
          const result = await fetch(url, { method: "POST", headers: { authorization: "Bearer dummy-test" },
            body: JSON.stringify({ input: [{ type: "message", role: "user", content: "fixture" }] }) });
          await result.arrayBuffer();
          return result.status;
        };
        finish(`${await sendModel()},${await sendModel()}`);
      })().catch(() => process.exit(1));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
