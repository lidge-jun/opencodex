import { describe, expect, test } from "bun:test";
import { MessageBudget } from "../../src/messaging/budget";
import { discoverLoaded, resolveLoaded } from "../../src/messaging/discovery";
import { LocalMessageRpc } from "../../src/messaging/rpc";
import { LOCAL_OTHER, LOCAL_TARGET, localFixtureThread, localMessagingFixture } from "../helpers/messaging-local";

describe.skipIf(process.platform === "win32")("local Codex discovery", () => {
  test("loaded-only metadata is projected without history, preview or paths", async () => {
    const fixture = localMessagingFixture();
    const budget = new MessageBudget();
    const rpc = await LocalMessageRpc.connect(fixture.url, budget);
    try {
      const threads = await discoverLoaded(rpc, budget);
      expect(threads).toEqual([{ id: LOCAL_TARGET, name: "recipient", status: "idle" }]);
      expect(resolveLoaded(threads, { name: "recipient" }).id).toBe(LOCAL_TARGET);
      expect(resolveLoaded(threads, { thread: LOCAL_TARGET }).id).toBe(LOCAL_TARGET);
      expect(fixture.calls.map(call => call.method)).toEqual(["initialize", "initialized", "thread/loaded/list", "thread/read"]);
      expect(fixture.calls.at(-1)!.params).toEqual({ threadId: LOCAL_TARGET, includeTurns: false });
      expect(fixture.failures).toEqual([]);
    } finally { rpc.close(); budget.dispose(); await fixture.close(); }
  });

  test("pagination resolves exact names only after all pages; ambiguity fails closed", async () => {
    const fixture = localMessagingFixture(call => {
      if (call.method === "thread/loaded/list") return call.params.cursor
        ? { data: [LOCAL_OTHER], nextCursor: null } : { data: [LOCAL_TARGET], nextCursor: "second" };
    });
    const budget = new MessageBudget();
    const rpc = await LocalMessageRpc.connect(fixture.url, budget);
    try {
      const threads = await discoverLoaded(rpc, budget);
      expect(threads).toHaveLength(2);
      expect(() => resolveLoaded(threads, { name: "recipient" })).toThrow("Multiple loaded sessions");
      expect(() => resolveLoaded(threads, { name: "recip" })).toThrow("No loaded session");
      expect(() => resolveLoaded(threads, { thread: LOCAL_OTHER, name: "recipient" })).toThrow("exactly one");
    } finally { rpc.close(); budget.dispose(); await fixture.close(); }
  });

  test("repeated cursor and IDs cannot make a partial name match look complete", async () => {
    for (const repeatId of [false, true]) {
      const fixture = localMessagingFixture(call => call.method === "thread/loaded/list"
        ? { data: [!call.params.cursor || repeatId ? LOCAL_TARGET : LOCAL_OTHER], nextCursor: "again" } : undefined);
      const budget = new MessageBudget();
      const rpc = await LocalMessageRpc.connect(fixture.url, budget);
      try {
        await expect(discoverLoaded(rpc, budget)).rejects.toThrow("repeated");
        expect(fixture.calls.some(call => call.method === "thread/read")).toBe(false);
      } finally { rpc.close(); budget.dispose(); await fixture.close(); }
    }
  });

  test("page budget exhaustion fails before returning a directory", async () => {
    let pages = 0;
    const fixture = localMessagingFixture(call => call.method === "thread/loaded/list"
      ? { data: [], nextCursor: `page-${++pages}` } : undefined);
    const budget = new MessageBudget();
    const rpc = await LocalMessageRpc.connect(fixture.url, budget);
    try { await expect(discoverLoaded(rpc, budget)).rejects.toThrow("page budget"); expect(pages).toBe(20); }
    finally { rpc.close(); budget.dispose(); await fixture.close(); }
  });

  test("an empty complete directory is distinct from incomplete discovery", async () => {
    const fixture = localMessagingFixture(call => call.method === "thread/loaded/list" ? { data: [] } : undefined);
    const budget = new MessageBudget();
    const rpc = await LocalMessageRpc.connect(fixture.url, budget);
    try { expect(await discoverLoaded(rpc, budget)).toEqual([]); }
    finally { rpc.close(); budget.dispose(); await fixture.close(); }
  });

  test("metadata failure, ID mismatch and unload races fail instead of hiding sessions", async () => {
    for (const thread of [null, localFixtureThread(LOCAL_OTHER), { ...localFixtureThread(), status: { type: "notLoaded" } }]) {
      const fixture = localMessagingFixture(call => call.method === "thread/read" ? { thread } : undefined);
      const budget = new MessageBudget();
      const rpc = await LocalMessageRpc.connect(fixture.url, budget);
      try { await expect(discoverLoaded(rpc, budget)).rejects.toThrow(); }
      finally { rpc.close(); budget.dispose(); await fixture.close(); }
    }
  });

  test("malformed or oversized directory pages and invalid cursors are refused", async () => {
    for (const response of [{ data: ["bad-id"] }, { data: Array(51).fill(LOCAL_TARGET) },
      { data: [], nextCursor: 5 }, { data: [], nextCursor: "" }]) {
      const fixture = localMessagingFixture(call => call.method === "thread/loaded/list" ? response : undefined);
      const budget = new MessageBudget();
      const rpc = await LocalMessageRpc.connect(fixture.url, budget);
      try { await expect(discoverLoaded(rpc, budget)).rejects.toThrow("invalid local session metadata"); }
      finally { rpc.close(); budget.dispose(); await fixture.close(); }
    }
  });

  test("metadata lookup never exceeds four concurrent reads", async () => {
    let active = 0; let maximum = 0;
    const ids = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const fixture = localMessagingFixture(async call => {
      if (call.method === "thread/loaded/list") return { data: ids };
      if (call.method === "thread/read") {
        active++; maximum = Math.max(maximum, active);
        await Bun.sleep(5); active--;
        return { thread: localFixtureThread(String(call.params.threadId)) };
      }
    });
    const budget = new MessageBudget();
    const rpc = await LocalMessageRpc.connect(fixture.url, budget);
    try { expect(await discoverLoaded(rpc, budget)).toHaveLength(10); expect(maximum).toBe(4); expect(active).toBe(0); }
    finally { rpc.close(); budget.dispose(); await fixture.close(); }
  });
});

test("selectors refuse missing, malformed or control-bearing routing without a transport", () => {
  for (const selector of [{}, { thread: "bad" }, { name: "" }, { name: "bad\nname" }]) {
    expect(() => resolveLoaded([], selector)).toThrow("exactly one");
  }
  expect(() => resolveLoaded([], { thread: LOCAL_TARGET })).toThrow("No loaded session");
});
