// Test-only JSON-RPC peer. It never runs tools, reads user configuration or contacts a network.
let buffered = "";
let approvalRequestAcknowledged = false;
let accountState = process.env.OCX_FAKE_ACCOUNT_STATE ?? "loggedOut";
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const approval = { sessionId: "s", turnId: "t", approvalId: "a", toolCallId: "upstream", toolName: "mcp__opencodex__probe", rawArgs: "{}",
  currentRequirementId: { approvalId: "a", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }] };
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  for (;;) {
    const end = buffered.indexOf("\n");
    if (end < 0) break;
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    const message = JSON.parse(line);
    if (message.id === "server-1" && message.method === undefined && message.result) approvalRequestAcknowledged = true;
    else if (message.method === "initialize") reply(message.id, { serverInfo: { version: "fake" }, schema: { version: 1 }, grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral", experimentalApi: message.params?.capabilities?.experimentalApi === true && process.env.OCX_FAKE_EXPERIMENTAL !== "disabled" });
    else if (message.method === "account/read") reply(message.id, { state: accountState, credentialRequired: true });
    else if (message.method === "fixture/account-change-silent") { accountState = "apiKey"; reply(message.id, {}); }
    else if (message.method === "session/start") reply(message.id, { session: { sessionId: "s" } });
    else if (message.method === "turn/start") {
      send({ jsonrpc: "2.0", id: "server-1", method: "approval/request", params: approval });
      send({ jsonrpc: "2.0", method: "approval/requested", params: approval });
      reply(message.id, { commandId: message.params.commandId, status: "accepted", disposition: "started", turnId: "t" });
    } else if (message.method === "approval/decide") {
      if (!approvalRequestAcknowledged) reply(message.id, { status: "rejected" });
      else reply(message.id, { commandId: message.params.commandId, status: "accepted", approvalId: "a", terminal: true });
    }
    else if (message.method === "fixture/invalidate") {
      reply(message.id, {});
      send({ jsonrpc: "2.0", method: "session/modelRouteUnserved", params: { sessionId: "s" } });
    }
    else if (message.method === "fixture/account-change") {
      reply(message.id, {});
      send({ jsonrpc: "2.0", method: "account/changed", params: { state: "loggedOut", credentialRequired: true } });
    }
    else if (message.method === "fixture/retry") {
      reply(message.id, {});
      send({ jsonrpc: "2.0", method: "turn/modelRetryScheduled", params: { sessionId: "s", turnId: "t" } });
    }
    else if (message.method === "fixture/view-gap" || message.method === "fixture/view-unavailable") {
      reply(message.id, {});
      send({ jsonrpc: "2.0", method: message.method === "fixture/view-gap" ? "view/gap" : "session/viewHealthChanged", params: { sessionId: "s" } });
    }
    else if (message.method === "fixture/finish") {
      reply(message.id, {});
      send({ jsonrpc: "2.0", method: "item/completed", params: { sessionId: "s", item: { itemId: "i", turnId: "t", kind: "agentMessage", text: "finished" } } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s", turnId: "t", terminal: "completed" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
