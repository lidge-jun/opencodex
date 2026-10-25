// A real RPC child and an isolated parent let tests observe unhandled rejections
// without changing the test runner's process-wide rejection policy.
export {};

const mode = process.argv[3]!;
if (process.argv[2] === "child") {
  const send = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let input = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    input += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      const message = JSON.parse(input.slice(0, end));
      input = input.slice(end + 1);
      if (message.type !== "prompt") {
        send({ type: "response", id: message.id, success: true });
        continue;
      }
      if (mode === "exit-before-ack") process.exit(7);
      if (mode === "malformed-before-ack") {
        process.stdout.write("{invalid JSON}\n");
        continue;
      }
      if (mode === "extension-before-ack") {
        send({ type: "extension_error", error: "synthetic extension failure" });
        await Bun.sleep(25);
      }
      if (mode === "settle-before-ack") send({ type: "agent_settled" });
      send({ type: "response", id: message.id, success: mode !== "rejected", error: "synthetic rejection" });
      if (mode === "success") send({ type: "agent_settled" });
      if (mode === "extension-after-ack") send({ type: "extension_error", error: "synthetic extension failure" });
    }
  }
} else {
  const { PiRemoteWorkspaceRuntimeFactory } = await import(process.argv[2]!);
  const unhandled: string[] = [];
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  process.on("unhandledRejection", error => { unhandled.push(errorText(error)); });
  const factory = new PiRemoteWorkspaceRuntimeFactory({ command: [process.execPath, import.meta.path, "child", mode] });
  const handle = await factory.start({
    sessionId: "fixture", deviceId: "fixture-device", deviceName: "Fixture", rootId: "fixture-root", rootLabel: "Fixture",
    capabilities: ["workspace.read"], tools: ["read_file"], emit: () => {},
    coordinator: { async invokeTool() { throw new Error("No remote tool should run"); } },
  });
  let error: string | null = null;
  try {
    try { await handle.prompt("synthetic prompt"); } catch (caught) { error = errorText(caught); }
  } finally {
    await handle.stop();
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  console.log(JSON.stringify({ error, unhandled }));
}
