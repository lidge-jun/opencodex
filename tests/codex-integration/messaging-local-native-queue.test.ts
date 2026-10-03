import { expect, test } from "bun:test";
import { MessageBudget } from "../../src/messaging/budget";
import { runMessageProcess } from "../../src/messaging/process";
import { sendLocalMessage } from "../../src/messaging/send";
import { LOCAL_TARGET, localMessagingFixture, NO_REPLY } from "../helpers/messaging-local";

// Explicit opt-in only. No daemon, install, live home, bearer or API request.
const native = process.env.OCX_MESSAGE_CODEX_BINARY;
test.skipIf(!native || process.platform === "win32")("Codex 0.160.0 queues once through the isolated native Unix transport", async () => {
  const fixture = localMessagingFixture();
  const budget = new MessageBudget();
  const env = { PATH: process.env.PATH, HOME: fixture.root, CODEX_HOME: fixture.codexHome,
    NO_PROXY: "*", no_proxy: "*", OCX_TEST_HOME_GUARD: "1" };
  try {
    const version = await runMessageProcess([native!, "--version"], budget, { env });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe("codex-cli 0.160.0");
    const messageId = "00000000-0000-4000-8000-000000000004";
    const message = `[opencodex-message ${JSON.stringify({ messageId, kind: "notification", replyExpected: false })}]\n\nIsolated native queue interoperability fixture.`;
    const result = await runMessageProcess([native!, "queue", "--thread", LOCAL_TARGET, "--message", message,
      "--remote", fixture.nativeUrl], budget, { env });
    expect(result.exitCode, `socket bytes=${Buffer.byteLength(fixture.nativeUrl.slice(7))}; RPC calls=${fixture.calls.length}; fixture failures=${fixture.failures.length}`).toBe(0);
    const queued = fixture.calls.filter(call => call.method === "thread/queue/add");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.params.threadId).toBe(LOCAL_TARGET);
    expect(queued[0]!.params.clientUserMessageId).toBeString();
    expect(String(queued[0]!.params.clientUserMessageId).length).toBeGreaterThan(0);
    expect(queued[0]!.params.input).toEqual([{ type: "text", text: message, text_elements: [] }]);
    expect(fixture.calls[0]!.method).toBe("initialize");
    expect(fixture.calls[1]!.method).toBe("initialized");
    expect(fixture.failures).toEqual([]);
    expect(fixture.calls.some(call => ["thread/start", "thread/resume", "turn/start"].includes(call.method))).toBe(false);
  } finally { budget.dispose(); await fixture.close(); }
}, 35_000);

test.skipIf(!native || process.platform === "win32")("native queue acknowledgement loss does not replay an uncertain submission", async () => {
  const fixture = localMessagingFixture(call => call.method === "thread/queue/add" ? NO_REPLY : undefined);
  const budget = new MessageBudget(1500);
  const env = { PATH: process.env.PATH, HOME: fixture.root, CODEX_HOME: fixture.codexHome,
    NO_PROXY: "*", no_proxy: "*", OCX_TEST_HOME_GUARD: "1" };
  try {
    await expect(runMessageProcess([native!, "queue", "--thread", LOCAL_TARGET,
      "--message", "Isolated lost acknowledgement fixture.", "--remote", fixture.nativeUrl], budget, { env }))
      .rejects.toThrow("submission may be uncertain");
    expect(fixture.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
    expect(fixture.failures).toEqual([]);
  } finally { budget.dispose(); await fixture.close(); }
}, 5000);

test.skipIf(!native || process.platform === "win32")("complete local send workflow preserves native queue correlation and unknown receipts", async () => {
  for (const lost of [false, true]) {
    const fixture = localMessagingFixture(call => lost && call.method === "thread/queue/add" ? NO_REPLY : undefined);
    const budget = new MessageBudget(lost ? 2000 : 30_000);
    try {
      const receipt = await sendLocalMessage({ thread: LOCAL_TARGET, kind: "notification", body: "Native workflow fixture body." },
        { home: fixture.codexHome, runtime: () => ({ argv: args => [native!, ...args], path: process.env.PATH }) }, budget);
      expect(receipt.status).toBe(lost ? "unknown" : "queued");
      const submissions = fixture.calls.filter(call => call.method === "thread/queue/add");
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.params.threadId).toBe(LOCAL_TARGET);
      const input = submissions[0]!.params.input as { text: string }[];
      expect(input[0]!.text).toContain(receipt.messageId);
      expect(input[0]!.text).toContain('"replyExpected":false');
      expect(fixture.failures).toEqual([]);
    } finally { budget.dispose(); await fixture.close(); }
  }
}, 35_000);
