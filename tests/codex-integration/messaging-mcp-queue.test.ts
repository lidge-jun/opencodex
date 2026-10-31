import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { queueMcpRpc } from "../../src/messaging/mcp-queue-rpc";
import { queueMcpSend, queueMcpThreads, queueMessageInput } from "../../src/messaging/mcp-queue-tools";
import { QUEUE_MCP_TARGET, queueMcpFixture } from "../helpers/messaging-mcp-queue";

describe.skipIf(process.platform === "win32")("opt-in stored-thread MCP queue", () => {
  test("correlated queue request uses stdin, explicit home and no lifecycle RPCs", async () => {
    const f = queueMcpFixture();
    try {
      const receipt = await queueMcpSend(f.options, { threadId: QUEUE_MCP_TARGET, message: "PRIVATE_INPUT" });
      expect(receipt.status).toBe("queued"); expect(receipt.processed).toBe(false);
      const calls = f.calls();
      expect(calls.map(c => c.frame.method)).toEqual(["initialize", "initialized", "thread/queue/add"]);
      expect(calls[2]!.frame.params!.threadId).toBe(QUEUE_MCP_TARGET);
      expect(calls[2]!.frame.params!.clientUserMessageId).toBe(receipt.clientMessageId);
      expect(JSON.stringify(calls[2]!.frame.params!.input)).toContain("PRIVATE_INPUT");
      for (const c of calls) {
        expect(c.argv).toEqual(["app-server", "--listen", "stdio://"]);
        expect(c.home).toBe(f.options.codexHome); expect(c.sender).toBeUndefined();
        expect(JSON.stringify(c.argv)).not.toContain("PRIVATE_INPUT");
      }
      expect(JSON.stringify(receipt)).not.toContain("PRIVATE_INPUT");
    } finally { await f.close(); }
  });

  test("one metadata-only page carries a cursor and does not claim live state", async () => {
    const f = queueMcpFixture();
    try {
      const result = await queueMcpThreads(f.options, "requested-cursor");
      expect(result).toEqual({ available: true, scope: "stored_threads", liveStateVerified: false,
        threads: [{ threadId: QUEUE_MCP_TARGET, name: "fixture" }], nextCursor: "next-page" });
      expect(f.calls().at(-1)!.frame.params).toMatchObject({ limit: 50, cursor: "requested-cursor", useStateDbOnly: true });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    } finally { await f.close(); }
  });

  for (const [mode, status] of [["reject", "not_sent"], ["init-reject", "not_sent"], ["wrong-id", "unknown"],
    ["wrong-correlation", "unknown"], ["disconnect", "unknown"], ["oversize", "unknown"], ["bad-json", "unknown"],
    ["bad-utf8", "unknown"], ["bad-error", "unknown"], ["missing-error-message", "unknown"],
    ["mixed-error-result", "unknown"], ["missing-receipt-input", "unknown"]] as const) {
    test(`${mode}: ${status}, no retry or private diagnostics`, async () => {
      const f = queueMcpFixture(mode);
      try {
        const r = await queueMcpSend(f.options, { threadId: QUEUE_MCP_TARGET, message: "PRIVATE_INPUT" });
        expect(r.status).toBe(status); expect(r.processed).toBe(false);
        expect(JSON.stringify(r)).not.toContain("PRIVATE_");
        expect(f.calls().filter(c => c.frame.method === "thread/queue/add")).toHaveLength(mode === "init-reject" ? 0 : 1);
      } finally { await f.close(); }
    });
  }

  for (const mode of ["bad-list", "bad-cursor"]) {
    test(`${mode}: invalid discovery is not an empty success`, async () => {
      const f = queueMcpFixture(mode);
      try { expect((await queueMcpThreads(f.options)).available).toBe(false); }
      finally { await f.close(); }
    });
  }

  test("cancellation after queue write is unknown and the helper is reaped", async () => {
    const f = queueMcpFixture("hang");
    const abort = new AbortController();
    try {
      const pending = queueMcpSend(f.options, { threadId: QUEUE_MCP_TARGET, message: "fixture" }, abort.signal);
      const deadline = performance.now() + 2000;
      while (!f.calls().some(c => c.frame.method === "thread/queue/add") && performance.now() < deadline) await Bun.sleep(10);
      const pid = f.calls().at(-1)!.pid;
      expect(f.calls().at(-1)!.frame.method).toBe("thread/queue/add");
      abort.abort();
      expect((await pending).status).toBe("unknown");
      expect(() => process.kill(pid, 0)).toThrow();
      expect(f.calls().filter(c => c.frame.method === "thread/queue/add")).toHaveLength(1);
    } finally { abort.abort(); await f.close(); }
  });

  test("deadline after queue write is unknown without resubmission", async () => {
    const f = queueMcpFixture("hang");
    try {
      expect((await queueMcpSend(f.options, { threadId: QUEUE_MCP_TARGET, message: "fixture" })).status).toBe("unknown");
      expect(f.calls().filter(c => c.frame.method === "thread/queue/add")).toHaveLength(1);
    } finally { await f.close(); }
  }, 15000);

  test("invalid inputs and pre-cancelled calls start no helper", async () => {
    const f = queueMcpFixture();
    const abort = new AbortController(); abort.abort();
    try {
      for (const input of [{ threadId: "name", message: "text" }, { threadId: QUEUE_MCP_TARGET, message: " " },
        { threadId: QUEUE_MCP_TARGET, message: "x\0y" }, { threadId: QUEUE_MCP_TARGET, message: "x".repeat(16385) }]) {
        expect(z.object(queueMessageInput).safeParse(input).success).toBe(false);
        expect((await queueMcpSend(f.options, input)).status).toBe("not_sent");
      }
      expect((await queueMcpRpc(f.options, "thread/list", {}, abort.signal)).status).toBe("not_sent");
      expect(f.calls()).toHaveLength(0);
    } finally { await f.close(); }
  });
});
