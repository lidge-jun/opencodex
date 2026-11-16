// State-machine tests for per-message effort history (#6895), ported from rkb32's offline slice
// (gist 69ee9faf767de6aae0369244aaa0d654, effort-history.test.js). Items are test shorthand
// ({kind}) unless a case says otherwise; tests/responses/responses-effort-history-fixtures.test.ts drives
// the same module with real adapter bodies and bridge output.
import { createHash } from "node:crypto";
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createStore, decide, commit, abandon, buffer, rejectUpstream, lineageFromMetadata,
  MAX_ENTRIES, MAX_BUFFER_BYTES, MAX_TOTAL_BYTES, MAX_CHANGE_POINTS, ENTRY_TTL_MS, PENDING_TTL_MS, CAPABILITY_TTL_MS, hash, kindOf,
} from "../../src/responses/effort-history";

const scope = {
  cohort: "cohort-1", provider: "anthropic", destination: "api.anthropic.com",
  adapter: "anthropic", model: "opus-5-5", credential: "acct-1", authMode: "apiKey",
};
const NEW_META = JSON.stringify({ history_initialization: "New" });
const base = { effort: "low", chatLineage: "chat-1", scope, frame: "frame-A", generation: "g1", cacheControl: true, stripped: false, thinking: "enabled", explicitCap: 8192, turnMetadata: NEW_META, transport: "http", changeWireIndex: 1, newTranscriptReceipt: true /* test stand-in: no lifecycle owner yet */ };
const user = (text) => ({ kind: "user", text });
const asst = (text) => ({ kind: "assistant", text });
const tool = (text) => ({ kind: "tool_result", text });
const developer = (text) => ({ kind: "developer", text });
const cfg = { kind: "configuration_update", effort: "high" };
const ON = { enabled: true, activated: true, compactionMarkerIdentified: true };

// Turn 1 of a chat: new history, committed. Returns the transcript as the client now holds it.
function startChat(store, { effort = "low", P = 100, opts = ON, text = "fix the bug" } = {}) {
  const req = { ...base, effort, parent: [], suffix: [user(text)] };
  const d = decide(store, req, opts);
  assert.equal(d.action, "send");
  const out = [asst("done")];
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P, outputItems: out, generation: "g1" });
  assert.equal(res.action, "committed");
  return [user(text), ...out];
}

// One later turn on a matched chat: decide, then commit with a cache read at least P.
function nextTurn(store, transcript, { effort = "low", suffix, cacheRead = 100, P = 100, reply = "r" }) {
  const d = decide(store, { ...base, effort, parent: transcript, suffix }, ON);
  assert.equal(d.action, "send", `expected send, got ${d.reason}`);
  const out = [asst(reply)];
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead, P, outputItems: out, generation: "g1" });
  assert.equal(res.action, "committed", `expected commit, got ${res.reason}`);
  return [...transcript, ...suffix, ...out];
}

test("switch off: production stays off", () => {
  const d = decide(createStore(), { ...base, parent: [], suffix: [user("hi")] }, { ...ON, enabled: false });
  assert.equal(d.reason, "switch-off");
});

test("not activated: off for every chat, even with the switch on", () => {
  const d = decide(createStore(), { ...base, parent: [], suffix: [user("hi")] }, { ...ON, activated: false });
  assert.equal(d.reason, "not-activated");
});

test("WebSocket before the header is read from frames: off", () => {
  const d = decide(createStore(), { ...base, transport: "websocket", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.reason, "websocket-before-activation");
});

test("scope missing cohort: off", () => {
  const { cohort, ...partial } = scope;
  const d = decide(createStore(), { ...base, scope: partial, parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.reason, "missing-scope");
});

test("no lineage signal: a new chat never starts a history", () => {
  const d = decide(createStore(), { ...base, turnMetadata: undefined, newTranscriptReceipt: false, parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.reason, "no-history");
});

test("new chat with signal is sent and commits a history", () => {
  const store = createStore();
  startChat(store);
  assert.equal(store.entries.size, 1);
});

test("developer item on turn 1 with the signal: still a new chat", () => {
  const store = createStore();
  const d = decide(store, { ...base, parent: [], suffix: [developer("env"), user("hi")] }, ON);
  assert.equal(d.action, "send");
  assert.equal(d.kind, "new");
});

test("single message after eviction or restart: off, not a new chat", () => {
  const d = decide(createStore(), { ...base, parent: [user("earlier"), asst("x")], suffix: [user("continue")] }, ON);
  assert.equal(d.reason, "no-history");
});

test("metadata: only an explicit history_initialization New reads as new (diagnostic; admission needs a receipt)", () => {
  assert.equal(lineageFromMetadata(JSON.stringify({ history_initialization: "New" })), true);
  assert.equal(lineageFromMetadata(JSON.stringify({ history_initialization: "ColdResume" })), false);
  assert.equal(lineageFromMetadata(JSON.stringify({ history_initialization: "WarmFork" })), false);
  assert.equal(lineageFromMetadata(undefined), false);
  assert.equal(lineageFromMetadata("{not json"), false);
  assert.equal(lineageFromMetadata("null"), false);
});

test("raw New metadata alone never starts a chat: first turn with no receipt is off", () => {
  const d = decide(createStore(), { ...base, newTranscriptReceipt: false, parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.reason, "no-history");
});

test("a receipt with no raw metadata starts a chat", () => {
  const d = decide(createStore(), { ...base, turnMetadata: undefined, parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.action, "send");
});

test("resume (ColdResume signal) with a non-empty parent and empty store: off, never new", () => {
  const d = decide(createStore(), { ...base, turnMetadata: JSON.stringify({ history_initialization: "ColdResume" }), parent: [user("old"), asst("x")], suffix: [user("next")] }, ON);
  assert.equal(d.reason, "no-history");
});

test("plain user message with an effort change inserts one change point", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [user("add tests")] }, ON);
  assert.equal(d.kind, "matched");
  assert.equal(d.changePoint, true);
});

test("tool results only at the effort in effect: matched, no change point", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [tool("ok")] }, ON);
  assert.equal(d.action, "send");
  assert.equal(d.changePoint, false);
  assert.equal(d.shape, "tool-only");
});

test("effort in effect follows the change point: a tool-only turn after an increase matches", () => {
  const store = createStore();
  let t = startChat(store, { effort: "low" });
  t = nextTurn(store, t, { effort: "high", suffix: [user("add tests")] });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [tool("ok")] }, ON);
  assert.equal(d.action, "send", `got ${d.reason}`);
  assert.equal(d.shape, "tool-only");
});

test("minimal and low are the same effort: no change point", () => {
  const store = createStore();
  const t = startChat(store, { effort: "minimal" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(d.changePoint, false);
});

test("tool results only with a different effort: off and entry deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [tool("ok")] }, ON);
  assert.equal(d.reason, "tool-only-effort-change");
  assert.equal(store.entries.size, 0);
});

test("tool-only with no entry: off, nothing written", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [user("x"), asst("y")], suffix: [tool("ok")] }, ON);
  assert.equal(d.reason, "no-history");
  assert.equal(store.entries.size, 0);
});

test("configuration_update in the new suffix: off and deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [cfg, user("next")] }, ON);
  assert.equal(d.reason, "configuration-update-in-suffix");
  assert.equal(store.entries.size, 0);
});

test("two user messages in one request: off and deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [user("a"), user("b")] }, ON);
  assert.equal(d.reason, "more-than-one-user-message");
  assert.equal(store.entries.size, 0);
});

test("turn-1 retry (same input as the committed turn 1): off, no second history", () => {
  const store = createStore();
  startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("fix the bug")] }, ON);
  assert.equal(d.reason, "replay");
  assert.equal(d.kind, undefined);
  assert.equal(store.entries.size, 0);
});

test("turn-2 retry (same request as the committed turn 2): off, nothing matched", () => {
  const store = createStore();
  let t = startChat(store, { effort: "low" });
  const suffix = [user("next")];
  t = nextTurn(store, t, { effort: "low", suffix });
  const d = decide(store, { ...base, effort: "low", parent: t.slice(0, 2), suffix }, ON);
  assert.equal(d.reason, "replay");
  assert.equal(store.entries.size, 0);
});

test("duplicate first request while the first is in flight: second is off and deletes the placeholder", () => {
  const store = createStore();
  const first = decide(store, { ...base, effort: "low", parent: [], suffix: [user("same")] }, ON);
  assert.equal(first.action, "send");
  const second = decide(store, { ...base, effort: "low", parent: [], suffix: [user("same")] }, ON);
  assert.equal(second.reason, "placeholder-exists");
  const res = commit(store, first.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.reason, "pending-missing");
});

test("two different new chats on the same scope and frame both start (no shared placeholder)", () => {
  const store = createStore();
  const a = decide(store, { ...base, effort: "low", parent: [], suffix: [user("chat A")] }, ON);
  const b = decide(store, { ...base, effort: "low", parent: [], suffix: [user("chat B")] }, ON);
  assert.equal(a.action, "send");
  assert.equal(b.action, "send");
  const res = commit(store, a.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("a")], generation: "g1" });
  assert.equal(res.action, "committed");
});

test("generation change: off and entry deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, generation: "g2", effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(d.reason, "generation-mismatch");
  assert.equal(store.entries.size, 0);
});

test("frame change on a matching prefix: off, parent deleted; a clean resend does not match", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const changed = decide(store, { ...base, frame: "frame-B", effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(changed.reason, "frame-mismatch");
  assert.equal(store.entries.size, 0);
  const clean = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(clean.reason, "no-history");
});

test("stripped request on a matching prefix: off, parent deleted, clean resend does not match", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const stripped = decide(store, { ...base, stripped: true, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(stripped.reason, "proxy-stripped");
  assert.equal(store.entries.size, 0);
  const clean = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(clean.reason, "no-history");
});

test("no cache control on a matching prefix: off and parent deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, cacheControl: false, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(d.reason, "no-cache-control");
  assert.equal(store.entries.size, 0);
});

test("unclassified suffix on a matching prefix: off and parent deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [asst("odd")] }, ON);
  assert.equal(d.reason, "unclassified-suffix");
  assert.equal(store.entries.size, 0);
});

test("thinking change on a retry: off and parent deleted (rule 3b before rule 4)", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, thinking: "disabled", effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(d.reason, "thinking-change");
  assert.equal(store.entries.size, 0);
});


test("output limit derived from effort: a higher effort's larger limit makes the decrease off", () => {
  const store = createStore();
  const noCap = { ...base, explicitCap: undefined };
  const d0 = decide(store, { ...noCap, effort: "high", parent: [], suffix: [user("fix")] }, ON);
  const out = [asst("done")];
  commit(store, d0.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: out, generation: "g1" });
  const d = decide(store, { ...noCap, effort: "low", parent: [user("fix"), ...out], suffix: [user("next")] }, ON);
  assert.equal(d.reason, "limit-differs");
  assert.equal(store.entries.size, 0);
});


test("explicit client cap: the same limit on a later effort decrease is matched", () => {
  const store = createStore();
  const t = startChat(store, { effort: "high" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(d.kind, "matched");
});

test("in-flight second fork on a matched parent: off and deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  decide(store, { ...base, effort: "low", parent: t, suffix: [user("fork a")] }, ON);
  const second = decide(store, { ...base, effort: "low", parent: t, suffix: [user("fork b")] }, ON);
  assert.equal(second.reason, "in-flight-collision");
  assert.equal(store.entries.size, 0);
});

test("cache read below P: nothing new commits and the entry is deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low", P: 100 });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [user("next")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 10, P: 120, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.reason, "cache-below-P");
  assert.equal(store.entries.size, 0);
});

test("P = 0 is never committed", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 0, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.reason, "P-zero");
  assert.equal(store.entries.size, 0);
});


test("failure before sending: default is delete (section 9); restore only with the owner-enabled flag", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const res = commit(store, d.pendingToken, { failedBeforeSend: true, messageStop: false });
  assert.equal(res.reason, "failed-before-send");
  assert.equal(store.entries.size, 0);
  const store2 = createStore();
  const t2 = startChat(store2, { effort: "low" });
  const d2 = decide(store2, { ...base, effort: "low", parent: t2, suffix: [user("next")] }, ON);
  assert.equal(commit(store2, d2.pendingToken, { failedBeforeSend: true, restoreOnFailure: true }).action, "restored");
  assert.equal(store2.entries.size, 1);
});

test("failure before sending deletes a new-history placeholder (no restore)", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  const res = commit(store, d.pendingToken, { failedBeforeSend: true });
  assert.equal(res.reason, "placeholder-failed");
  assert.equal(store.pending.size, 0);
  assert.equal(store.entries.size, 0);
});

test("sent, no message_stop: pending parent deleted, nothing written", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: false });
  assert.equal(res.reason, "uncertain-outcome");
  assert.equal(store.entries.size, 0);
  assert.equal(store.pending.size, 0);
});

test("client disconnect after send (abandon): nothing committed, pending cleared", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(abandon(store, d.pendingToken).reason, "abandoned");
  assert.equal(store.pending.size, 0);
  assert.equal(store.entries.size, 0);
});

test("two forks from one parent: the second deletes the pending slot, the first commit is dropped", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const a = decide(store, { ...base, effort: "low", parent: t, suffix: [user("fork a")] }, ON);
  decide(store, { ...base, effort: "low", parent: t, suffix: [user("fork b")] }, ON);
  const res = commit(store, a.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: [asst("a")], generation: "g1" });
  assert.equal(res.reason, "pending-missing");
});

test("restore after the slot was deleted by another fork is dropped, not brought back", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const a = decide(store, { ...base, effort: "low", parent: t, suffix: [user("fork a")] }, ON);
  decide(store, { ...base, effort: "low", parent: t, suffix: [user("fork b")] }, ON);
  const res = commit(store, a.pendingToken, { failedBeforeSend: true });
  assert.equal(res.action, "dropped");
  assert.equal(store.entries.size, 0);
});

test("a pending slot past its TTL is swept, and a late commit is dropped", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, { ...ON, now: 0 });
  const later = decide(store, { ...base, effort: "low", parent: [], suffix: [user("other")] }, { ...ON, now: PENDING_TTL_MS + 1 });
  assert.equal(later.action, "send");
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("r")], generation: "g1" }, PENDING_TTL_MS + 1);
  assert.equal(res.reason, "pending-missing");
});

test("an entry idle past the 1-hour TTL is swept, so the next request is off", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("fix the bug")] }, { ...ON, now: 0 });
  commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("done")], generation: "g1" }, 0);
  const t = [user("fix the bug"), asst("done")];
  const later = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, { ...ON, now: ENTRY_TTL_MS + 1 });
  assert.equal(later.reason, "no-history");
});

test("buffered output over the per-slot cap at commit: nothing commits", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  const big = asst("x".repeat(MAX_BUFFER_BYTES + 10));
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [big], generation: "g1" });
  assert.equal(res.reason, "over-buffer-cap");
  assert.equal(store.entries.size, 0);
});

test("store total (512 KB): stored records are small, so six committed chats fit; the bound holds", () => {
  const store = createStore();
  for (let i = 0; i < 6; i++) {
    const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user(`chat ${i}`)] }, ON);
    const big = asst("x".repeat(100 * 1024));
    const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [big], generation: "g1" });
    assert.equal(res.action, "committed", `chat ${i}: ${res.reason}`);
  }
  let total = 0;
  for (const e of store.entries.values()) total += e.bytes;
  assert.ok(total <= MAX_TOTAL_BYTES, `total ${total}`);
  assert.ok(total < 2048 * 6, `record size ${total}`);
});

test("bounds: pending slots fill the count; admission refused when nothing is evictable", () => {
  const store = createStore();
  for (let i = 0; i < MAX_ENTRIES; i++) {
    store.pending.set(`p${i}`, { token: `p${i}`, kind: "matched", createdAt: Date.now(), plan: {} });
  }
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.reason, "bounds-refused");
});

test("400 that names the beta or effort message: capability unsupported, no resend, next request off", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const res = rejectUpstream(store, d.pendingToken, { status: 400, errorText: "output_config.effort requires a model that supports per-turn effort; this model does not" });
  assert.equal(res.reason, "capability-unsupported");
  assert.equal(store.entries.size, 0);
  const next = decide(store, { ...base, effort: "low", parent: t, suffix: [user("again")] }, ON);
  assert.equal(next.reason, "capability-unsupported");
});

test("other 400: error to caller, no resend, entry deleted, no capability record", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const res = rejectUpstream(store, d.pendingToken, { status: 400, errorText: "max_tokens too large" });
  assert.equal(res.action, "error");
  assert.equal(res.reason, "other-400");
  assert.equal(store.entries.size, 0);
  assert.equal(store.capability.size, 0);
});

test("commit: generation changed during the attempt: no commit, entry deleted", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: [asst("r")], generation: "g2" });
  assert.equal(res.reason, "generation-changed");
  assert.equal(store.entries.size, 0);
});

test("projection: a developer item in the parent changes the prefix, so the request does not match", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: [developer("env"), ...t], suffix: [user("next")] }, ON);
  assert.equal(d.reason, "no-history");
});

test("projection: a normalization-inserted tool output changes the prefix, so the request does not match", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: [...t, tool("inserted")], suffix: [user("next")] }, ON);
  assert.equal(d.reason, "no-history");
});

test("commit after the pending TTL, with no other request in between: dropped as expired", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, { ...ON, now: 0 });
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("r")], generation: "g1" }, PENDING_TTL_MS + 1);
  assert.equal(res.reason, "pending-expired");
  assert.equal(store.entries.size, 0);
});

test("stale commit after a newer request took the same key: dropped, the newer slot is untouched", () => {
  const store = createStore();
  const x = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, { ...ON, now: 0 });
  const y = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, { ...ON, now: PENDING_TTL_MS + 1 });
  assert.equal(y.action, "send");
  const stale = commit(store, x.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("x")], generation: "g1" }, PENDING_TTL_MS + 1);
  assert.equal(stale.reason, "pending-missing");
  const fresh = commit(store, y.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("y")], generation: "g1" }, PENDING_TTL_MS + 1);
  assert.equal(fresh.action, "committed");
});

test("missing cache read counts as zero: a matched commit with P above zero is cache-below-P", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low", P: 100 });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, P: 100, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.reason, "cache-below-P");
});

test("failed matched send restores when the store has room", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  for (let i = 0; i < 5; i++) {
    const n = decide(store, { ...base, effort: "low", parent: [], suffix: [user(`chat ${i}`)] }, ON);
    commit(store, n.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("x".repeat(100 * 1024))], generation: "g1" });
  }
  const res = commit(store, d.pendingToken, { failedBeforeSend: true, restoreOnFailure: true });
  let total = 0;
  for (const e of store.entries.values()) total += e.bytes;
  assert.equal(res.action, "restored");
  assert.ok(total <= MAX_TOTAL_BYTES, `total ${total}`);
});

test("Mythos: any effort change is off and the entry is deleted", () => {
  const store = createStore();
  const mythos = { ...scope, model: "mythos-5-1" };
  const req = (over) => ({ ...base, scope: mythos, ...over });
  const d0 = decide(store, req({ effort: "low", parent: [], suffix: [user("fix")] }), ON);
  const out = [asst("done")];
  commit(store, d0.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: out, generation: "g1" });
  const d = decide(store, req({ effort: "high", parent: [user("fix"), ...out], suffix: [user("add tests")] }), ON);
  assert.equal(d.reason, "mythos-effort-change");
  assert.equal(store.entries.size, 0);
});

test("the matched decision returns the change-point insertion the adapter needs", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [user("next")] }, ON);
  assert.equal(d.insert.effort, "high");
  // No leading tool results: the change point sits at the parent prefix itself.
  assert.equal(d.insert.at, t.length);
});

test("change point position: with leading tool results, the change point is before the user message", () => {
  const store = createStore();
  let t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [tool("ok"), user("next")] }, ON);
  assert.equal(d.kind, "matched");
  assert.equal(d.changePoint, true);
});


test("output limit derived from effort: a lower anchor with a higher request is off", () => {
  const store = createStore();
  const noCap = { ...base, explicitCap: undefined };
  const d0 = decide(store, { ...noCap, effort: "low", parent: [], suffix: [user("fix")] }, ON);
  const out = [asst("done")];
  commit(store, d0.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: out, generation: "g1" });
  const d = decide(store, { ...noCap, effort: "high", parent: [user("fix"), ...out], suffix: [user("next")] }, ON);
  assert.equal(d.reason, "limit-differs");
});

test("three turns with an effort change: turn 3 gets every change point, not only its own", () => {
  const store = createStore();
  let t = startChat(store, { effort: "low" });
  t = nextTurn(store, t, { effort: "high", suffix: [user("add tests")] });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [user("third")] }, ON);
  assert.equal(d.kind, "matched");
  assert.equal(d.changePoints.length, 1);
  assert.equal(d.changePoints[0].effort, "high");
  assert.equal(d.insert, null);
});

test("buffered output over the per-slot cap: nothing commits, and the pending parent is gone", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: [asst("y".repeat(MAX_BUFFER_BYTES + 10))], generation: "g1" });
  assert.equal(res.reason, "over-buffer-cap");
  assert.equal(store.entries.size, 0);
});

test("streaming: buffered output past the 512 KB bound deletes the pending slot and nothing commits", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const first = buffer(store, d.pendingToken, 100 * 1024);
  assert.equal(first.action, "buffering");
  const over = buffer(store, d.pendingToken, 500 * 1024);
  assert.equal(over.reason, "streaming-over-store-cap");
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.reason, "pending-missing");
  assert.equal(store.entries.size, 0);
});

test("abandon before any byte was sent restores the matched parent; after a send it deletes it", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(abandon(store, d.pendingToken, { sent: false, restoreOnFailure: true }).action, "restored");
  assert.equal(store.entries.size, 1);
  const d2 = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(abandon(store, d2.pendingToken, { sent: true }).reason, "abandoned");
  assert.equal(store.entries.size, 0);
});

test("turn-1 retry after turn 2 consumed turn 1's entry: still off, no second history", () => {
  const store = createStore();
  let t = startChat(store, { effort: "low" });
  t = nextTurn(store, t, { effort: "low", suffix: [user("next")] });
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("fix the bug")] }, ON);
  assert.equal(d.reason, "replay");
  assert.notEqual(d.kind, "new");
});

test("a compaction summary never starts a history, even with the New signal", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("summary of earlier work")], compactionSummary: true }, ON);
  assert.equal(d.reason, "compaction-summary");
  assert.equal(store.entries.size, 0);
});

test("change-point position: leading tool result is part of the insertion point", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "high", parent: t, suffix: [tool("ok"), user("next")] }, ON);
  assert.equal(d.insert.at, t.length + 1);
});

test("buffer: exceeding the per-slot cap while streaming deletes the slot", () => {
  const store = createStore();
  const tr = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: tr, suffix: [user("next")] }, ON);
  const over = buffer(store, d.pendingToken, MAX_BUFFER_BYTES + 1);
  assert.equal(over.reason, "over-buffer-cap");
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.reason, "pending-missing");
});

test("change points are capped: the change beyond the cap is off", () => {
  const store = createStore();
  let tr = startChat(store, { effort: "low" });
  let effort = "high";
  for (let i = 0; i < MAX_CHANGE_POINTS; i++) {
    tr = nextTurn(store, tr, { effort, suffix: [user("change " + i)] });
    effort = effort === "high" ? "low" : "high";
  }
  const d = decide(store, { ...base, effort, parent: tr, suffix: [user("one more")] }, ON);
  assert.equal(d.reason, "change-points-full");
  assert.equal(store.entries.size, 0);
});

test("eviction by count: the oldest entry goes when a new history is admitted at the limit", () => {
  const store = createStore();
  startChat(store, { effort: "low", text: "chat 0" });
  const oldestKey = [...store.entries.keys()][0];
  for (let i = 1; i < MAX_ENTRIES; i++) startChat(store, { effort: "low", text: "chat " + i });
  assert.equal(store.entries.size, MAX_ENTRIES);
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("chat new")] }, ON);
  assert.equal(d.action, "send");
  assert.equal(store.entries.size, MAX_ENTRIES - 1);
  assert.equal(store.entries.has(oldestKey), false);
});

test("eviction by bytes: an oversized older entry is evicted so a new commit fits", () => {
  const store = createStore();
  startChat(store, { effort: "low", text: "old" });
  const oldest = [...store.entries.keys()][0];
  store.entries.get(oldest).bytes = MAX_TOTAL_BYTES;
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("new chat")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("n")], generation: "g1" });
  assert.equal(res.action, "committed");
  assert.equal(store.entries.has(oldest), false);
});

test("chat identity: two chats with the same first message both start (different lineage)", () => {
  const store = createStore();
  const a = decide(store, { ...base, chatLineage: "chat-A", effort: "low", parent: [], suffix: [user("hello")] }, ON);
  const b = decide(store, { ...base, chatLineage: "chat-B", effort: "low", parent: [], suffix: [user("hello")] }, ON);
  assert.equal(a.action, "send");
  assert.equal(b.action, "send");
});

test("chat identity: no chat lineage means off, nothing written", () => {
  const store = createStore();
  const d = decide(store, { ...base, chatLineage: undefined, effort: "low", parent: [], suffix: [user("hello")] }, ON);
  assert.equal(d.reason, "no-chat-lineage");
  assert.equal(store.pending.size, 0);
});

test("positive control on the same objects (shape check only; a real client echo is not tested)", () => {
  const store = createStore();
  let tr = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: tr, suffix: [user("second question")] }, ON);
  assert.equal(d.kind, "matched", "the client echoes the stored answer, so the second turn must match");
});

test("projection miss: an output item the client drops makes the next turn off", () => {
  const store = createStore();
  startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: [user("fix the bug")], suffix: [user("second question")] }, ON);
  assert.equal(d.reason, "no-history");
});

test("second request on the same slot is off and deletes it; the older commit is dropped", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const old = decide(store, { ...base, effort: "low", parent: t, suffix: [user("first")] }, { ...ON, now: 0 });
  const newer = decide(store, { ...base, effort: "low", parent: t, suffix: [user("first")] }, { ...ON, now: 0 });
  assert.equal(newer.reason, "in-flight-collision");
  const res = commit(store, old.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: [asst("r")], generation: "g1" }, 0);
  assert.equal(res.reason, "pending-missing");
});

// Output whose canonical size is exactly n bytes (the commit's measure).
const sized = (n) => {
  const overhead = Buffer.byteLength(JSON.stringify([{ kind: "assistant", text: "" }]));
  return [asst("x".repeat(n - overhead))];
};

test("threshold: canonical output exactly at the buffer cap commits; one byte over is deleted", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  const ok = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: sized(MAX_BUFFER_BYTES), generation: "g1" });
  assert.equal(ok.action, "committed");
  const store2 = createStore();
  const d2 = decide(store2, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  const over = commit(store2, d2.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: sized(MAX_BUFFER_BYTES + 1), generation: "g1" });
  assert.equal(over.reason, "over-buffer-cap");
});

test("threshold: streamed bytes exactly at the cap are accepted; one more is deleted", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(buffer(store, d.pendingToken, MAX_BUFFER_BYTES).action, "buffering");
  const store2 = createStore();
  const d2 = decide(store2, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(buffer(store2, d2.pendingToken, MAX_BUFFER_BYTES + 1).reason, "over-buffer-cap");
});

test("threshold, legacy form (kept for the name): output exactly at the buffer cap commits; one byte over does not", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  const fits = asst("y".repeat(MAX_BUFFER_BYTES - 200));
  const ok = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [fits], generation: "g1" });
  assert.equal(ok.action, "committed");
  const store2 = createStore();
  const d2 = decide(store2, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  const over = commit(store2, d2.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("y".repeat(MAX_BUFFER_BYTES + 50))], generation: "g1" });
  assert.equal(over.reason, "over-buffer-cap");
});

test("cross-chat: chat B's identical first turn starts; chat A's retry is still a replay; chat B cannot use chat A's transcript", () => {
  const store = createStore();
  const aT = decide(store, { ...base, chatLineage: "chat-A", effort: "low", parent: [], suffix: [user("hello")] }, ON);
  commit(store, aT.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("hi A")], generation: "g1" });
  const aTranscript = [user("hello"), asst("hi A")];
  const bNew = decide(store, { ...base, chatLineage: "chat-B", effort: "low", parent: [], suffix: [user("hello")] }, ON);
  assert.equal(bNew.action, "send");
  assert.equal(bNew.kind, "new");
  const aRetry = decide(store, { ...base, chatLineage: "chat-A", effort: "low", parent: [], suffix: [user("hello")] }, ON);
  assert.equal(aRetry.reason, "replay");
  const bUsesA = decide(store, { ...base, chatLineage: "chat-B", effort: "low", parent: aTranscript, suffix: [user("next")] }, ON);
  assert.equal(bUsesA.reason, "no-history");
});

test("eviction by last use: the least recently used entry goes, not the first inserted", () => {
  const store = createStore();
  // First inserted, but used most recently.
  const a = decide(store, { ...base, chatLineage: "chat-A", effort: "low", parent: [], suffix: [user("a")] }, { ...ON, now: 5000 });
  commit(store, a.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("a")], generation: "g1" }, 5000);
  const oldestKey = [...store.entries.keys()][0];
  // Second inserted, least recently used.
  const b = decide(store, { ...base, chatLineage: "chat-B", effort: "low", parent: [], suffix: [user("b")] }, { ...ON, now: 0 });
  commit(store, b.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("b")], generation: "g1" }, 0);
  for (let i = 2; i < MAX_ENTRIES; i++) {
    const d = decide(store, { ...base, chatLineage: "chat-" + i, effort: "low", parent: [], suffix: [user("c" + i)] }, { ...ON, now: 5000 });
    commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("c")], generation: "g1" }, 5000);
  }
  assert.equal(store.entries.size, MAX_ENTRIES);
  decide(store, { ...base, chatLineage: "chat-new", effort: "low", parent: [], suffix: [user("new")] }, { ...ON, now: 5000 });
  assert.equal(store.entries.has(oldestKey), true, "the most recently used entry must survive");
});

test("Mythos: a model ID that merely contains mythos is treated as Mythos (fails closed)", () => {
  // Real wire IDs seen in opencodex at d11f06711c: "claude-mythos-preview" (benchmarks data) and the
  // family pattern (?:claude-)?mythos(?:-|$) (tests/clients/desktop-3p.test.ts L485).
  // "claude-mythos-preview" is not one of the six in-scope models, so it is off before the Mythos rule.
  assert.equal(decide(createStore(), { ...base, scope: { ...scope, model: "claude-mythos-preview" }, effort: "low", parent: [], suffix: [user("fix")] }, ON).reason, "out-of-scope-model");
  for (const model of ["mythos-5-1", "claude-mythos-5-1"]) {
    const store = createStore();
    const sc = { ...scope, model };
    const d0 = decide(store, { ...base, scope: sc, effort: "low", parent: [], suffix: [user("fix")] }, ON);
    const out = [asst("done")];
    commit(store, d0.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: out, generation: "g1" });
    const d = decide(store, { ...base, scope: sc, effort: "high", parent: [user("fix"), ...out], suffix: [user("next")] }, ON);
    assert.equal(d.reason, "mythos-effort-change", model);
  }
});

test("generation: a change between admission and commit is refused even when the lookup value matches", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: [asst("r")], generation: "g2" });
  assert.equal(res.reason, "generation-changed");
});

// --- Review round 5 (2026-10-25) ---
import { effectiveLimit } from "../../src/responses/effort-history";

test("effective limit follows the section 6 derivation at each effort level (no explicit cap)", () => {
  const cases = { minimal: 12288, low: 12288, medium: 16384, high: 24576, xhigh: 32768, max: 40192 };
  for (const [effort, want] of Object.entries(cases)) {
    assert.equal(effectiveLimit({ effort, omittedMaxTokens: 8192 }), want, effort);
  }
  assert.equal(effectiveLimit({ effort: "high", explicitCap: 4000 }), 4000);
});

test("P = 0 new history: the turn-1 retry is a replay (off), not a second history", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 0, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.reason, "P-zero");
  const retry = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(retry.reason, "replay");
});

test("Fable is off until its wire ID is checked", () => {
  const store = createStore();
  const d = decide(store, { ...base, scope: { ...scope, model: "claude-fable-5-1" }, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.reason, "fable-wire-id-unchecked");
});

test("compaction marker not identified: new history is off even with the NEW header", () => {
  const store = createStore();
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("hi")] }, { enabled: true, activated: true });
  assert.equal(d.reason, "compaction-marker-unidentified");
});

test("400 that only mentions effort in another context: no capability record", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  rejectUpstream(store, d.pendingToken, { status: 400, errorText: "max_tokens with effort high is too large" });
  assert.equal(store.capability.size, 0);
});

test("capability is per model and destination: a beta 400 in one chat marks the next chat too", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low", text: "chat one" });
  const d = decide(store, { ...base, chatLineage: "chat-1", effort: "low", parent: t, suffix: [user("next")] }, ON);
  rejectUpstream(store, d.pendingToken, { status: 400, errorText: "output_config.effort requires a model that supports per-turn effort; this model does not" });
  const other = decide(store, { ...base, chatLineage: "chat-2", effort: "low", parent: [], suffix: [user("another")] }, ON);
  assert.equal(other.reason, "capability-unsupported");
});

test("positive control over a JSON round trip (shape check only; real id, status, phase are not tested)", () => {
  const store = createStore();
  const d0 = decide(store, { ...base, effort: "low", parent: [], suffix: [user("fix")] }, ON);
  const out = [asst("done")];
  commit(store, d0.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: out, generation: "g1" });
  const echoed = JSON.parse(JSON.stringify([user("fix"), ...out]));
  const d = decide(store, { ...base, effort: "low", parent: echoed, suffix: [user("second")] }, ON);
  assert.equal(d.kind, "matched");
});

test("projection shape drift: an echo that adds a field misses, so the next turn is off", () => {
  const store = createStore();
  const d0 = decide(store, { ...base, effort: "low", parent: [], suffix: [user("fix")] }, ON);
  commit(store, d0.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("done")], generation: "g1" });
  const drifted = [user("fix"), { kind: "assistant", text: "done", status: "completed" }];
  const d = decide(store, { ...base, effort: "low", parent: drifted, suffix: [user("second")] }, ON);
  assert.notEqual(d.kind, "matched");
});

test("rule 1: a Messages API request is off", () => {
  const d = decide(createStore(), { ...base, apiKind: "messages", effort: "low", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.reason, "out-of-scope-messages-api");
});

test("rule 1: a request with previous_response_id is off", () => {
  const d = decide(createStore(), { ...base, previousResponseId: "resp_1", effort: "low", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.reason, "out-of-scope-previous-response-id");
});

test("the pinned thinking budget is stored on the record (section 10)", () => {
  const store = createStore();
  const t0 = startChat(store, { effort: "low" });
  const entry = [...store.entries.values()][0];
  assert.equal(entry.budget, 4096);
  assert.ok(t0.length > 0);
});

test("store total: eviction fires when stored records near the cap (not only small records)", () => {
  const store = createStore();
  startChat(store, { effort: "low", text: "first" });
  const first = [...store.entries.keys()][0];
  store.entries.get(first).bytes = MAX_TOTAL_BYTES - 50;
  const d = decide(store, { ...base, effort: "low", parent: [], suffix: [user("second")] }, ON);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.action, "committed");
  assert.equal(store.entries.has(first), false);
});

test("restore with a full store: an older entry is evicted so the restored entry fits", () => {
  const store = createStore();
  startChat(store, { effort: "low", text: "other chat" });
  const other = [...store.entries.keys()][0];
  const t0 = startChat(store, { effort: "low", text: "keep" });
  const d = decide(store, { ...base, effort: "low", parent: t0, suffix: [user("next")] }, ON);
  store.entries.get(other).bytes = MAX_TOTAL_BYTES - 50;
  const res = commit(store, d.pendingToken, { failedBeforeSend: true, restoreOnFailure: true });
  assert.equal(res.action, "restored");
  assert.equal(store.entries.has(other), false);
});

test("effort none or absent: off, never a change point", () => {
  const store = createStore();
  const transcript = startChat(store);
  for (const effort of ["none", undefined]) {
    const d = decide(store, { ...base, effort, parent: transcript, suffix: [user("next")] }, ON);
    assert.equal(d.reason, "no-effort-level");
  }
  // Section 9: an off request that reaches the parent deletes it.
  assert.equal(store.entries.size, 0);
});

// Review round 12: crash, fail-open and scope fixes.
test("malformed tokens and results never throw; they fail closed", () => {
  const store = createStore();
  for (const token of [undefined, null, 42, {}, "no-colon"]) {
    assert.equal(commit(store, token, { messageStop: true, outputItems: [] }).action, "dropped");
    assert.equal(buffer(store, token, 10).action, "dropped");
    assert.equal(rejectUpstream(store, token, { status: 400, errorText: null }).action, "dropped");
    assert.equal(abandon(store, token).action, "dropped");
  }
  assert.equal(commit(store, undefined, undefined).action, "dropped");
});

test("a non-number cache read (NaN, string, object) does not commit a matched turn", () => {
  for (const cacheRead of [NaN, "abc", {}, undefined]) {
    const store = createStore();
    const t = startChat(store, { effort: "low" });
    const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
    const res = commit(store, d.pendingToken, { messageStop: true, cacheRead, P: 100, outputItems: [asst("r")], generation: "g1" });
    assert.equal(res.action, "deleted", String(cacheRead));
    assert.equal(store.entries.size, 0);
  }
});

test("buffer bytes must be a non-negative finite number; anything else deletes the slot", () => {
  for (const bytes of [NaN, -1, Infinity, "5", undefined]) {
    const store = createStore();
    const t = startChat(store, { effort: "low" });
    const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
    assert.equal(buffer(store, d.pendingToken, bytes).reason, "bad-bytes", String(bytes));
    assert.equal(store.pending.size, 0);
  }
});

test("unknown or prototype-key effort names are off", () => {
  for (const effort of ["turbo", "", "HIGH", "__proto__", "constructor", "toString"]) {
    const d = decide(createStore(), { ...base, effort, parent: [], suffix: [user("hi")] }, ON);
    assert.equal(d.reason, "no-effort-level", effort);
  }
});

test("scope: OAuth, another destination, or an out-of-list model is off", () => {
  const cases = [
    [{ ...scope, authMode: "oauth" }, "oauth-not-in-first-slice"],
    [{ ...scope, destination: "gateway.example.com" }, "out-of-scope-destination"],
    [{ ...scope, model: "claude-sonnet-4-5" }, "out-of-scope-model"],
    [{ ...scope, model: "gpt-5" }, "out-of-scope-model"],
  ];
  for (const [sc, reason] of cases) {
    const d = decide(createStore(), { ...base, scope: sc, effort: "low", parent: [], suffix: [user("hi")] }, ON);
    assert.equal(d.reason, reason);
  }
});

test("the matched and new decisions return the anchor effort, which the commit keeps", () => {
  const store = createStore();
  const d1 = decide(store, { ...base, effort: "high", parent: [], suffix: [user("fix")] }, ON);
  assert.equal(d1.anchorEffort, "high");
  const out = [asst("ok")];
  commit(store, d1.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: out, generation: "g1" });
  const t = [user("fix"), ...out];
  const d2 = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  assert.equal(d2.kind, "matched");
  assert.equal(d2.anchorEffort, "high");
});

test("a client kind field cannot reclassify a real message item", () => {
  const realUser = { type: "message", role: "user", kind: "developer", content: "x" };
  assert.equal(kindOf(realUser), "user");
  assert.equal(kindOf({ kind: "developer" }), "developer");
});

test("internal errors (deep nesting) fail closed instead of throwing", () => {
  let deep = { leaf: true };
  for (let i = 0; i < 20000; i++) deep = { n: deep };
  const d = decide(createStore(), { ...base, effort: "low", parent: [deep], suffix: [user("hi")] }, ON);
  assert.equal(d.action, "off");
});

// Review round 13.
test("an orphan tool call (no output in the request) is off, never matched", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const call = { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" };
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [call, user("next")] }, ON);
  assert.equal(d.reason, "orphan-tool-call");
  assert.equal(store.entries.size, 0);
  const paired = decide(createStore(), { ...base, effort: "low", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(paired.action, "send");
});
test("an account change ends the old scope: the old account's entry does not match again", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const sB = { ...scope, credential: "acct-2" };
  decide(store, { ...base, scope: sB, effort: "low", parent: t, suffix: [user("b")] }, ON);
  assert.equal(store.entries.size, 0);
  const dA = decide(store, { ...base, effort: "low", parent: t, suffix: [user("c")] }, ON);
  assert.notEqual(dA.kind, "matched");
});

test("a capability refusal expires after its TTL, and is remembered until then", () => {
  const store = createStore();
  const t = startChat(store, { effort: "low" });
  const d = decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON);
  rejectUpstream(store, d.pendingToken, { status: 400, errorText: "requires a model that supports per-turn effort" });
  assert.equal(decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, ON).reason, "capability-unsupported");
  const later = { ...ON, now: Date.now() + CAPABILITY_TTL_MS + 1 };
  assert.notEqual(decide(store, { ...base, effort: "low", parent: t, suffix: [user("next")] }, later).reason, "capability-unsupported");
});

test("hashes are keyed: plain SHA-256 of the same value does not match", () => {
  assert.notEqual(hash([]), createHash("sha256").update("[]").digest("hex"));
});

test("pending slots count their pinned values toward the store total", () => {
  const store = createStore();
  const big = "x".repeat(100 * 1024);
  let last;
  // The thinking field is pinned as a digest, so the large pinned value here is the frame.
  for (let i = 0; i < 5; i++) {
    last = decide(store, { ...base, chatLineage: `chat-${i}`, frame: big + i, parent: [], suffix: [user(`hi ${i}`)] }, ON);
  }
  assert.equal(last.kind, "new");
  assert.equal(buffer(store, last.pendingToken, 20 * 1024).reason, "streaming-over-store-cap");
});

test("round 14: ColdFork, SuppliedHistory and Cleared are not new-chat signals", () => {
  for (const value of ["ColdFork", "SuppliedHistory", "Cleared"]) {
    assert.equal(lineageFromMetadata(JSON.stringify({ history_initialization: value })), false, value);
  }
});

test("round 14: WebSocket resume: a ColdResume frame on a non-empty parent with an empty store is off", () => {
  const turnMetadata = JSON.stringify({ history_initialization: "ColdResume" });
  const d = decide(createStore(), { ...base, transport: "websocket", turnMetadata, parent: [user("old"), asst("x")], suffix: [user("next")] }, { ...ON, websocketHeaderRead: true });
  assert.equal(d.reason, "no-history");
});

test("round 14: WebSocket restart: a New frame on a non-empty parent with an empty store is off", () => {
  const d = decide(createStore(), { ...base, transport: "websocket", turnMetadata: NEW_META, parent: [user("old"), asst("x")], suffix: [user("next")] }, { ...ON, websocketHeaderRead: true });
  assert.equal(d.reason, "no-history");
});

// Production adds the Anthropic message index each change point is sent at (#6895 seam).
test("an effort change with no wire index for its effort message is off, and the parent is deleted", () => {
  const store = createStore();
  const transcript = startChat(store);
  const d = decide(store, { ...base, effort: "high", changeWireIndex: undefined, parent: transcript, suffix: [user("next")] }, ON);
  assert.equal(d.reason, "change-point-unplaceable");
  assert.equal(store.entries.size, 0);
});

test("the same effort needs no wire index, and a committed change point keeps its index for later turns", () => {
  const store = createStore();
  const transcript = startChat(store);
  const same = decide(store, { ...base, effort: "low", changeWireIndex: undefined, parent: transcript, suffix: [user("next")] }, ON);
  assert.equal(same.action, "send");
  abandon(store, same.pendingToken, { sent: false, restoreOnFailure: true });
  const t2 = nextTurn(store, transcript, { effort: "high", suffix: [user("next")] });
  const d = decide(store, { ...base, effort: "high", changeWireIndex: 7, parent: t2, suffix: [user("again")] }, ON);
  assert.equal(d.kind, "matched");
  assert.equal(d.insert, null);
  assert.deepEqual(d.changePoints, [{ at: transcript.length, wireIndex: 1, effort: "high" }]);
});


// Live Codex 0.167 traffic (2026-11-16): the first turn is [developer, developer, user(environment
// context), user(prompt)] and the metadata spells the value in lowercase.
test("Codex's lowercase history_initialization is the receipt value", () => {
  assert.equal(lineageFromMetadata(JSON.stringify({ history_initialization: "new" })), true);
  assert.equal(lineageFromMetadata(JSON.stringify({ history_initialization: "cold_resume" })), false);
});

test("a real Codex first turn (environment context plus prompt, after developer items) starts a history", () => {
  const store = createStore();
  const d = decide(store, { ...base, parent: [], suffix: [developer("perm"), developer("apps"), user("<environment_context/>"), user("fix the bug")] }, ON);
  assert.equal(d.action, "send");
  assert.equal(d.kind, "new");
});

test("a first turn with an assistant or tool item is never new, however many user messages it has", () => {
  const store = createStore();
  for (const suffix of [[user("ctx"), asst("x"), user("go")], [user("ctx"), tool("out"), user("go")]]) {
    const d = decide(store, { ...base, parent: [], suffix }, ON);
    assert.equal(d.action, "off");
  }
  assert.equal(store.pending.size, 0);
});

// #8787 review (PRRT_kwDOS-0Gi863yAtb, PRRT_kwDOS-0Gi863yHP1): a pending slot's own bytes count at
// admission, and the slot keeps digests of the lineage, scope and thinking field, never the raw values.
function storeBytes(store) {
  let total = 0;
  for (const e of store.entries.values()) total += e.bytes;
  for (const s of store.pending.values()) total += (s.entry ? s.entry.bytes : 0) + (s.pinnedBytes ?? 0) + (s.buffered ?? 0);
  return total;
}
const FRAME_90K = (tag) => tag + "f".repeat(90 * 1024);
function commitFramed(store, tag, now = Date.now()) {
  const d = decide(store, { ...base, frame: FRAME_90K(tag), chatLineage: tag, parent: [], suffix: [user(tag)] }, { ...ON, now });
  assert.equal(d.action, "send", `${tag}: ${d.reason}`);
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst(tag)], generation: "g1" }, now);
  assert.equal(res.action, "committed", `${tag}: ${res.reason}`);
  return [user(tag), asst(tag)];
}

test("bounds: a pending admission larger than the store total is refused and nothing is evicted", () => {
  const store = createStore();
  startChat(store, { effort: "low" });
  const kept = [...store.entries.keys()];
  const d = decide(store, { ...base, frame: "f".repeat(MAX_TOTAL_BYTES), chatLineage: "huge", parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.action, "off");
  assert.equal(d.reason, "bounds-refused");
  assert.equal(store.pending.size, 0);
  assert.deepEqual([...store.entries.keys()], kept);
  assert.ok(storeBytes(store) <= MAX_TOTAL_BYTES, `total ${storeBytes(store)}`);
});

// #8845 review (PRRT_kwDOS-0Gi864A9SR): the entry-count limit must not evict before the byte check
// refuses, or a refused admission costs an unrelated chat its history.
test("bounds: a refused oversized admission at the entry-count limit evicts no history", () => {
  const store = createStore();
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const d = decide(store, { ...base, chatLineage: `small-${i}`, parent: [], suffix: [user(`small-${i}`)] }, { ...ON, now: 1000 + i });
    assert.equal(d.action, "send", `small-${i}: ${d.reason}`);
    const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("ok")], generation: "g1" }, 1000 + i);
    assert.equal(res.action, "committed", `small-${i}: ${res.reason}`);
  }
  const kept = [...store.entries.keys()].sort();
  assert.equal(kept.length, MAX_ENTRIES);
  const d = decide(store, { ...base, frame: "f".repeat(MAX_TOTAL_BYTES), chatLineage: "huge", parent: [], suffix: [user("hi")] }, { ...ON, now: 2000 });
  assert.equal(d.action, "off");
  assert.equal(d.reason, "bounds-refused");
  assert.equal(store.pending.size, 0);
  assert.deepEqual([...store.entries.keys()].sort(), kept);
});

test("bounds: a new pending admission evicts the least recently used histories until it fits", () => {
  const store = createStore();
  for (let i = 0; i < 5; i++) commitFramed(store, `chat-${i}`, 1000 + i);
  const oldest = [...store.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
  assert.equal(store.entries.size, 5);
  const d = decide(store, { ...base, frame: FRAME_90K("new"), chatLineage: "new", parent: [], suffix: [user("new")] }, { ...ON, now: 2000 });
  assert.equal(d.action, "send", d.reason);
  assert.equal(store.entries.has(oldest), false);
  assert.ok(storeBytes(store) <= MAX_TOTAL_BYTES, `total ${storeBytes(store)}`);
});

test("bounds: a matched pending admission counts its pinned bytes and evicts other histories to fit", () => {
  const store = createStore();
  const transcript = commitFramed(store, "chat-x", 5000);
  for (let i = 0; i < 4; i++) commitFramed(store, `other-${i}`, 1000 + i);
  const d = decide(store, { ...base, frame: FRAME_90K("chat-x"), chatLineage: "chat-x", parent: transcript, suffix: [user("next")] }, { ...ON, now: 6000 });
  assert.equal(d.action, "send", d.reason);
  assert.equal(d.kind, "matched");
  assert.equal(store.entries.size, 3);
  assert.ok(storeBytes(store) <= MAX_TOTAL_BYTES, `total ${storeBytes(store)}`);
});

test("pending slots and entries keep digests of the chat lineage and thinking field", () => {
  const store = createStore();
  const lineage = "L".repeat(64 * 1024);
  const thinking = { type: "enabled", budget_tokens: 4096, note: "T".repeat(64 * 1024) };
  const d = decide(store, { ...base, chatLineage: lineage, thinking, parent: [], suffix: [user("hi")] }, ON);
  assert.equal(d.action, "send", d.reason);
  const slot = [...store.pending.values()][0];
  assert.ok(slot.pinnedBytes < 2048, `pinned ${slot.pinnedBytes}`);
  assert.ok(!JSON.stringify(slot.req).includes("LLLL") && !JSON.stringify(slot.req).includes("TTTT"));
  const res = commit(store, d.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [asst("r")], generation: "g1" });
  assert.equal(res.action, "committed");
  const entry = [...store.entries.values()][0];
  assert.ok(entry.bytes < 2048, `entry ${entry.bytes}`);
  assert.ok(!JSON.stringify(entry).includes("LLLL") && !JSON.stringify(entry).includes("TTTT"));
  // The digest still decides rule 3b: the same thinking matches, a different one is a change.
  const t = [user("hi"), asst("r")];
  const same = decide(store, { ...base, chatLineage: lineage, thinking: structuredClone(thinking), parent: t, suffix: [user("next")] }, ON);
  assert.equal(same.action, "send", same.reason);
  abandon(store, same.pendingToken, { sent: false, restoreOnFailure: true });
  const changed = decide(store, { ...base, chatLineage: lineage, thinking: { ...thinking, budget_tokens: 8192 }, parent: t, suffix: [user("next")] }, ON);
  assert.equal(changed.reason, "thinking-change");
});

