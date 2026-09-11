import { Database } from "bun:sqlite";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { startAstraEffortProxy } from "../helpers/astra-effort-proxy";
import { readRecentUsageEntries } from "../../src/usage/log";

const user = (content: string) => ({ role: "user", content });
const body = (input: unknown[], effort = "medium", extra = {}) => ({ model: "gpt-6-astra", instructions: "Synthetic", input, reasoning: { effort }, stream: true, store: false, ...extra });
const updates = (input: any[]) => input.filter(item => item.type === "configuration_update").map(item => item.reasoning.effort);

for (const native of [false, true]) {
  test(`Astra real HTTP and WebSocket ingress, continuation and compact with ${native ? "WebSocket" : "HTTP"} upstream`, async () => {
    const fixture = await startAstraEffortProxy(native);
    const ws = fixture.websocket("ws-fixture");
    try {
      for (const [thread, send] of [["http-fixture", (b: object) => fixture.http(b, "http-fixture")], ["ws-fixture", ws.turn]] as const) {
        const first = [user("one")];
        const r1 = await send(body(first));
        const second = [...first, ...r1.output, user("two")];
        const r2 = await send(body(second, "low"));
        expect(fixture.captured.at(-1)!.body.reasoning.effort).toBe("medium");
        expect(updates(fixture.captured.at(-1)!.body.input)).toEqual(["low"]);
        await send(body([user("three")], "medium", { previous_response_id: r2.id }));
        expect(updates(fixture.captured.at(-1)!.body.input)).toEqual(["low", "medium"]);
        expect(updates(second)).toEqual([]);
        await fixture.http(body(second, "high"), `${thread}-sibling`);
        expect(updates(fixture.captured.at(-1)!.body.input)).toEqual([]);
      }
      const resumeInput = [user("resume-one")];
      const initial = await fixture.http(body(resumeInput), "resume-fixture");
      const reconnect = fixture.websocket("resume-fixture");
      try {
        await reconnect.turn(body([user("resume-two")], "low", { previous_response_id: initial.id }));
        expect(updates(fixture.captured.at(-1)!.body.input)).toEqual(["low"]);
      } finally { reconnect.close(); }
      const lock = new Database(join(fixture.home, "astra-effort-cache", "state.sqlite"));
      lock.exec("BEGIN IMMEDIATE");
      try {
        await fixture.http(body([...resumeInput, ...initial.output, user("busy")], "high"), "resume-fixture");
        expect(fixture.captured.at(-1)!.body.reasoning.effort).toBe("high");
        expect(updates(fixture.captured.at(-1)!.body.input)).toEqual([]);
      } finally { lock.exec("ROLLBACK"); lock.close(); }
      await fixture.http(body([user("after compaction"), { type: "compaction_trigger" }], "high"), "resume-fixture");
      expect(updates(fixture.captured.at(-1)!.body.input)).toEqual([]);
      const compact = await fixture.http(body([user("compact")], "high"), "http-fixture", true);
      expect(compact.object).toBe("response.compaction");
      expect(fixture.captured.at(-1)!.compact).toBe(true);
      expect(updates(fixture.captured.at(-1)!.body.input)).toEqual([]);
      await Promise.all(Array.from({ length: 4 }, (_, i) => fixture.http(body([user("concurrent")]), `concurrent-${i}`)));
      const rows = readRecentUsageEntries(100, fixture.home);
      expect(rows.some(row => row.astraEffortCache?.status === "updated")).toBe(true);
      expect(rows.some(row => row.astraEffortCache?.stateOutcome === "busy")).toBe(true);
      expect(rows.some(row => row.attempts?.some(attempt => attempt.astraEffortCache?.status === "updated"))).toBe(true);
      expect(rows.filter(row => row.astraEffortCache).every(row => row.astraEffortCache!.durationMs >= 0)).toBe(true);
      expect(fixture.captured.some(row => row.transport === (native ? "websocket" : "http"))).toBe(true);
    } finally { ws.close(); await fixture.stop(); }
  }, 40_000);
}
