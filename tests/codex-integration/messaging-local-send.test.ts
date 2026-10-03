import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { MessageBudget } from "../../src/messaging/budget";
import { sendLocalMessage } from "../../src/messaging/send";
import { LocalMessagingError } from "../../src/messaging/types";
import type { MessageRunner } from "../../src/messaging/native";
import { LOCAL_OTHER, LOCAL_TARGET, localFixtureThread, localMessagingFixture } from "../helpers/messaging-local";

export const QUEUE_HELP = "Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>\n  --thread <THREAD>\n  --message <TEXT>\n  --remote <ADDR>\nAccepted: unix://PATH";
/** Record isolated native invocations, optionally replacing the successful probe/queue stub. */
function helper(handler?: MessageRunner) {
  const calls: { argv: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const run: MessageRunner = async (argv, budget, options) => {
    budget.throwIfEnded(); calls.push({ argv, env: options?.env });
    return handler ? handler(argv, budget, options)
      : { exitCode: 0, stdout: argv.includes("--version") ? "codex-cli 0.160.0\n" : argv.includes("--help") ? QUEUE_HELP : "private native stdout" };
  };
  return { calls, run };
}
const options = { kind: "request" as const, thread: LOCAL_TARGET, body: "PRIVATE fixture body" };

describe.skipIf(process.platform === "win32")("local caller-owned queued submission", () => {
  test("one exact-ID submission with metadata-derived sender, correlation and isolated helper home", async () => {
    const fixture = localMessagingFixture(call => call.method === "thread/loaded/list" ? { data: [LOCAL_TARGET, LOCAL_OTHER] } : undefined);
    const budget = new MessageBudget(), helpers = helper();
    try {
      const receipt = await sendLocalMessage(options, { home: fixture.codexHome, senderId: LOCAL_OTHER,
        runtime: () => ({ path: process.env.PATH, argv: args => ["/fixture/launcher with spaces", ...args] }) }, budget, helpers.run);
      expect(receipt.status).toBe("queued"); expect(receipt.sender?.threadId).toBe(LOCAL_OTHER);
      expect(receipt.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(helpers.calls).toHaveLength(3);
      const queued = helpers.calls[2]!;
      expect(queued.argv.slice(0, 4)).toEqual(["/fixture/launcher with spaces", "queue", "--thread", LOCAL_TARGET]);
      expect(queued.argv.slice(-2)).toEqual(["--remote", fixture.nativeUrl]);
      const text = queued.argv[queued.argv.indexOf("--message") + 1]!;
      expect(text).toContain(receipt.messageId); expect(text).toContain(options.body);
      expect(text).toContain(LOCAL_OTHER); expect(JSON.stringify(receipt)).not.toContain(options.body);
      expect(JSON.stringify(receipt)).not.toContain("private native stdout");
      expect(queued.env?.CODEX_HOME).not.toBe(fixture.codexHome);
      expect(queued.env?.OCX_SHIM_BYPASS).toBe("1"); expect(queued.env?.OPENAI_API_KEY).toBeUndefined();
      expect(existsSync(queued.env!.CODEX_HOME!)).toBe(false);
      expect(fixture.calls.filter(call => call.method === "thread/read" && call.params.threadId === LOCAL_TARGET)).toHaveLength(2);
      expect(fixture.failures).toEqual([]);
    } finally { budget.dispose(); await fixture.close(); }
  });

  test("ambiguous/absent destinations and invalid senders fail before any helper invocation", async () => {
    const fixture = localMessagingFixture(call => call.method === "thread/loaded/list" ? { data: [LOCAL_TARGET, LOCAL_OTHER] } : undefined);
    try {
      for (const context of [{ name: "recipient" }, { thread: "00000000-0000-4000-8000-000000000009" },
        { thread: LOCAL_TARGET, senderId: "invalid" }]) {
        const budget = new MessageBudget(), helpers = helper();
        try {
          const receipt = await sendLocalMessage({ kind: "request", body: "body", thread: context.thread, name: context.name },
            { home: fixture.codexHome, senderId: context.senderId, runtime: () => ({ argv: args => ["codex", ...args] }) }, budget, helpers.run);
          expect(receipt.status).toBe("not_sent"); expect(helpers.calls).toEqual([]);
        } finally { budget.dispose(); }
      }
    } finally { await fixture.close(); }
  });

  test("unsupported version/help or failed probes are not_sent, with no queue fallback", async () => {
    const fixture = localMessagingFixture();
    try {
      for (const fail of ["version", "help", "probe"]) {
        const budget = new MessageBudget(), helpers = helper(async argv => {
          if (fail === "probe") throw new Error("private probe failure");
          return { exitCode: 0, stdout: argv.includes("--version") ? `codex-cli ${fail === "version" ? "0.161.0" : "0.160.0"}` : "unsupported queue help" };
        });
        try {
          const receipt = await sendLocalMessage(options, { home: fixture.codexHome, runtime: () => ({ argv: args => ["codex", ...args] }) }, budget, helpers.run);
          expect(receipt.status).toBe("not_sent");
          expect(helpers.calls.some(call => call.argv.includes("--message"))).toBe(false);
          expect(JSON.stringify(receipt)).not.toContain("private probe failure");
        } finally { budget.dispose(); }
      }
    } finally { await fixture.close(); }
  });

  test("a destination unloading during preflight is not_sent, never resumed", async () => {
    let reads = 0;
    const fixture = localMessagingFixture(call => call.method === "thread/read"
      ? { thread: { ...localFixtureThread(), status: { type: ++reads === 1 ? "idle" : "notLoaded" } } } : undefined);
    const budget = new MessageBudget(), helpers = helper();
    try {
      const receipt = await sendLocalMessage(options, { home: fixture.codexHome, runtime: () => ({ argv: args => ["codex", ...args] }) }, budget, helpers.run);
      expect(receipt.status).toBe("not_sent"); expect(receipt.error?.code).toBe("target_not_loaded");
      expect(helpers.calls).toHaveLength(2); expect(fixture.failures).toEqual([]);
    } finally { budget.dispose(); await fixture.close(); }
  });

  test("nonzero, lost acknowledgement and post-spawn cancellation are unknown and never replayed", async () => {
    const fixture = localMessagingFixture();
    try {
      for (const failure of ["nonzero", "process_incomplete", "unexpected"]) {
        const budget = new MessageBudget(), helpers = helper(async argv => {
          if (argv.includes("--version")) return { exitCode: 0, stdout: "codex-cli 0.160.0" };
          if (argv.includes("--help")) return { exitCode: 0, stdout: QUEUE_HELP };
          if (failure === "nonzero") return { exitCode: 1, stdout: options.body };
          if (failure === "unexpected") throw new Error(options.body);
          throw new LocalMessagingError("process_incomplete", options.body);
        });
        try {
          const receipt = await sendLocalMessage(options, { home: fixture.codexHome, runtime: () => ({ argv: args => ["codex", ...args] }) }, budget, helpers.run);
          expect(receipt.status).toBe("unknown"); expect(receipt.error?.message).toContain("Do not replay");
          expect(helpers.calls.filter(call => call.argv.includes("--message"))).toHaveLength(1);
          expect(JSON.stringify(receipt)).not.toContain(options.body);
        } finally { budget.dispose(); }
      }
    } finally { await fixture.close(); }
  });

  test("pre-spawn failure/cancellation is not_sent; no missing-sender reply destination is invented", async () => {
    const fixture = localMessagingFixture();
    try {
      for (const code of ["process_not_started", "cancelled", "operation_timeout"]) {
        const budget = new MessageBudget(), helpers = helper(async argv => {
          if (argv.includes("--version")) return { exitCode: 0, stdout: "codex-cli 0.160.0" };
          if (argv.includes("--help")) return { exitCode: 0, stdout: QUEUE_HELP };
          expect(argv[argv.indexOf("--message") + 1]).toContain('"replyCommand":null');
          throw new LocalMessagingError(code, "No submission was attempted.");
        });
        try {
          const receipt = await sendLocalMessage(options, { home: fixture.codexHome, runtime: () => ({ argv: args => ["codex", ...args] }) }, budget, helpers.run);
          expect(receipt.status).toBe("not_sent"); expect(receipt.sender).toBeNull();
        } finally { budget.dispose(); }
      }
    } finally { await fixture.close(); }
  });
});
