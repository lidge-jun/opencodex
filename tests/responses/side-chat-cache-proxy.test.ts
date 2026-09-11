import { expect, test } from "bun:test";
import { startCacheProxy } from "../helpers/side-chat-cache-proxy";
import { SIDE_CHAT_BOUNDARY } from "../../src/codex/side-chat-cache";
import { readRecentUsageEntries } from "../../src/usage/log";
import { normalizeLogConversationId } from "../../src/server/request-log-conversation";
import { bunSupportsBoundedCodexWsRelay, currentBunRuntimeIdentity } from "../../src/server/responses/ws-upstream";

const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const history = [message("developer", "Synthetic rules"), message("user", "Parent question")];
const body = (thread: string, input: unknown[], parent?: string) => ({ model: "gpt-5.6-luna", instructions: "Synthetic", stream: true, store: false,
  input, prompt_cache_key: thread, client_metadata: { thread_id: thread, session_id: thread, ...(parent ? { forked_from_thread_id: parent } : {}) } });

for (const native of [false, true]) {
  test(`side cache real HTTP/WebSocket clients with ${native ? "WebSocket" : "HTTP"} fixture`, async () => {
    const fixture = await startCacheProxy(native);
    const ws = fixture.websocket("child-ws", "parent");
    try {
      const parent = await fixture.http(body("parent", history), "parent");
      const inherited = [...history, ...parent.output, message("user", SIDE_CHAT_BOUNDARY), message("user", "Side question")];
      await Promise.all([
        fixture.http(body("child-http", inherited, "parent"), "child-http", false, "parent"),
        ws.turn(body("child-ws", inherited, "parent")),
      ]);
      expect(fixture.captured.slice(1).every(row => row.body.prompt_cache_key === "parent")).toBe(true);
      const second = await ws.turn(body("child-ws", [...inherited, message("user", "Follow-up")], "parent"));
      ws.close();
      const reconnected = fixture.websocket("child-ws", "parent");
      try {
        await reconnected.turn({ ...body("child-ws", [message("user", "Continue")], "parent"), previous_response_id: second.id });
      } finally { reconnected.close(); }
      const changed = [...inherited]; changed[0] = message("developer", "Different current permission");
      await fixture.http(body("changed-child", changed, "parent"), "changed-child", false, "parent");
      expect(fixture.captured.at(-1)!.body.prompt_cache_key).toBe("changed-child");
      const compact = await fixture.http(body("child-ws", inherited, "parent"), "child-ws", true, "parent");
      expect(compact.object).toBe("response.compaction");
      const rows = readRecentUsageEntries(30, fixture.home);
      const child = rows.filter(row => row.sideChatCache?.threadIdHash === normalizeLogConversationId("child-ws"));
      expect(child.some(row => row.sideChatCache?.phase === "unbound-side" && row.sideChatCache.snapshotOutcome === "stored")).toBe(true);
      expect(child.some(row => row.sideChatCache?.phase === "bound-side")).toBe(true);
      expect(rows.some(row => row.sideChatCache?.reason === "input-prefix-change")).toBe(true);
      const transport = native && bunSupportsBoundedCodexWsRelay(currentBunRuntimeIdentity()) ? "websocket" : "http";
      expect(fixture.captured.filter(row => !row.compact).every(row => row.transport === transport)).toBe(true);
    } finally { ws.close(); await fixture.stop(); }
  }, 40_000);
}
