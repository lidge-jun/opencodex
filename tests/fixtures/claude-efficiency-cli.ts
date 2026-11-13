import { readFileSync, writeSync } from "node:fs";
const args = JSON.parse(process.argv[2]!) as string[];
const fixture = process.argv[3]!;
// Only the owned synthetic probe uses this deliberate defect to calibrate its HTTP assertions.
const cacheWrite = process.argv[4] === "omit-cache-creation" ? 0 : 80;

/**
 * Probe plumbing for the stdout-flush regression, inert in every other run.
 *
 * That regression leaves stdout unread on purpose, so the child cannot report what its own stdout
 * write did by writing to stdout: the report would join the buffer under observation. It reports on
 * stderr behind a sentinel prefix instead, which needs no descriptor beyond the three the adapter
 * already gives it.
 *
 * The channel is one-way on purpose. A command descriptor one fd up was tried and dropped: the
 * child's read of it intermittently never saw a command, and commands sent over stdin cannot be
 * serviced while a multi-megabyte stdin write holds that same pipe. So the test does not ask the
 * child for its state; the child states it as it happens, and the test waits for that mark.
 * `OCX_REPLAY_PROBE` is never set by the adapter, a direct run, or any other test, so the default
 * path below is the production one.
 */
const probeMode = process.env.OCX_REPLAY_PROBE;
const mark = (value: Record<string, unknown>): void => {
  if (!probeMode) return;
  try { writeSync(2, `OCXPROBE ${JSON.stringify(value)}\n`); } catch { /* the test closed its end */ }
};
// This mode exists to make the parent's stdin write fail. It runs before stdin is touched, so the
// child is provably alive and not reading while the parent's write is outstanding.
if (probeMode === "no-read") {
  mark({ phase: "ready" });
  await new Promise(() => { /* the test kills this child and reads the write's failure */ });
}
// This mode exits before stdin is touched, which is the early-exit shape the parent's request write
// has to survive: the write it issued in the spawn tick has no reader left, so the pipe closes under
// it. The mark is written synchronously first, so the parent has a record that this child reached the
// exit point rather than failing to start.
if (probeMode === "exit-before-read") {
  mark({ phase: "exiting" });
  process.exit(9);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
const frame = JSON.parse(input.trim());
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

interface ReplayHooks {
  /** Called in the write's own tick with its return value and the frame's byte count. */
  onReplayReturned?: (accepted: boolean, bytes: number) => void;
  /** Called once the event loop has had one turn to run the write's callback. */
  onReplayTurn?: (settled: boolean) => void;
  /** Called from inside the replay write's own completion callback. */
  onReplaySettled?: (error: string | null) => void;
}

/**
 * The replay writer, and the only place the exit sequence exists.
 *
 * Production calls this with no hooks, so the bytes a real turn depends on travel through the same
 * statements the probe observes. A probe that reimplemented the sequence could keep passing while
 * this one regressed, which is exactly what let an earlier version of this regression stay green
 * after the production path was reverted.
 */
async function writeReplayAndExit(replayText: string, hooks: ReplayHooks): Promise<never> {
  const replayFrame = `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: replayText } } })}\n`;
  const resultFrame = `${JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 2, output_tokens: 4 } })}\n`;
  // The replay frame is megabytes. Bun buffers what it cannot hand to the destination immediately, so
  // this write is not proof about reader progress on its own; the completion callback is. `process.exit`
  // terminates without draining stdout still queued, which discarded the tail of this frame.
  // Awaiting the result write's callback below orders every earlier write ahead of it and returns
  // only once the frame is out of the process, so the exit cannot cut it.
  let replaySettled = false;
  const accepted = process.stdout.write(replayFrame, error => {
    replaySettled = true;
    hooks.onReplaySettled?.(error ? String((error as { code?: string }).code ?? error) : null);
  });
  // `accepted` is the call's own return value. `false` says the runtime took the bytes into its own
  // queue instead of handing them all to the destination within this call; it does not by itself say
  // anything about the kernel pipe's capacity, because the runtime buffers internally first.
  hooks.onReplayReturned?.(accepted, Buffer.byteLength(replayFrame));
  if (hooks.onReplayTurn) {
    // One turn of the event loop, not a delay. This reports only whether the callback had run by the
    // end of that single turn. It is not a statement that no later turn can change the answer: a
    // reader that drains the destination later does complete the pending write.
    await new Promise<void>(resolve => setImmediate(resolve));
    hooks.onReplayTurn(replaySettled);
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(resultFrame, err => err ? reject(err) : resolve());
  });
  process.exit(0);
}

// Echo only the owned synthetic replay for the request-parser regression. No vendor account or socket.
if (process.argv[4] === "image-replay") {
  const replayText = JSON.stringify(frame.message.content);
  const init = { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] };
  // The one defect this regression contrasts against stays outside the writer above: the pre-fix
  // exit drops the tail by leaving it queued, which is not the production sequence.
  if (probeMode === "exit-before-flush") {
    emit(init);
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: replayText } } });
    emit({ type: "result", subtype: "success", usage: { input_tokens: 2, output_tokens: 4 } });
    process.exit(0);
  }
  if (probeMode === "malformed-hang") {
    emit(init);
    process.stdout.write("this is not a stream-json frame\n");
    mark({ phase: "malformed-written" });
    await new Promise(() => { /* reaping is the test's job */ });
  }
  emit(init);
  // The probe observes the production writer; it never supplies a different exit sequence.
  if (probeMode === "observe") {
    await writeReplayAndExit(replayText, {
      onReplayReturned: (accepted, bytes) => mark({ phase: "replay-returned", accepted, bytes }),
      onReplayTurn: settled => mark({ phase: "replay-turn", settled }),
      onReplaySettled: error => mark({ phase: "replay-settled", replayError: error }),
    });
  }
  await writeReplayAndExit(replayText, {});
}
const current = frame.message.content.at(-1).text as string;
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
