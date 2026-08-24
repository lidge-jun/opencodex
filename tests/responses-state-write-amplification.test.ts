/**
 * #2460 — `responses-state.json` was rewritten in full on a fixed 2 s debounce.
 *
 * The snapshot is bounded at 24 MiB, so under sustained traffic every debounce
 * paid a complete re-serialization plus an atomic replacement of a file nothing
 * reads until the next start. Two narrow measures are covered here: a
 * byte-identical payload is not rewritten, and the debounce scales with the size
 * of the snapshot actually being written.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  flushResponseState,
  rememberResponseState,
  setResponseStateByteCapForTests,
} from "../src/responses/state";

function remember(id: string, text: string): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    { id, output: [{ type: "message", role: "assistant", content: text }], status: "completed" },
    undefined,
    { force: true },
  );
}

describe("responses-state snapshot write amplification (#2460)", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];
  let snapshot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-amp-"));
    process.env["OPENCODEX_HOME"] = home;
    snapshot = join(home, "responses-state.json");
    clearResponseStateMemoryForTests();
  });

  afterEach(() => {
    setResponseStateByteCapForTests(null);
    clearResponseStateForTests();
    rmSync(home, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  /** Record the delay the store hands to setTimeout when it schedules its next write. */
  function scheduledDelay(schedule: () => void): number {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return (realSetTimeout as (...a: unknown[]) => unknown)(handler, ms, ...rest);
    }) as unknown as typeof setTimeout;
    try {
      schedule();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(delays).toHaveLength(1);
    return delays[0]!;
  }

  /** Backdate the snapshot so "was it rewritten?" is a mtime comparison, not a clock race. */
  function backdate(): number {
    const past = new Date(Date.now() - 60_000);
    utimesSync(snapshot, past, past);
    return statSync(snapshot).mtimeMs;
  }

  test("a flush that would reproduce the same bytes does not rewrite the file", async () => {
    remember("resp_amp_small", "kept");
    await flushResponseState();
    expect(existsSync(snapshot)).toBe(true);
    const before = backdate();

    // An entry past the 2 MiB per-entry bound is dropped from the selection, so
    // recording it mutates state without changing a single persisted byte.
    remember("resp_amp_oversized", "x".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(statSync(snapshot).mtimeMs).toBe(before);
  });

  test("a flush that changes the payload still rewrites the file", async () => {
    remember("resp_amp_first", "first");
    await flushResponseState();
    const before = backdate();

    remember("resp_amp_second", "second");
    await flushResponseState();

    expect(statSync(snapshot).mtimeMs).toBeGreaterThan(before);
  });

  test("a snapshot deleted underneath us is rewritten even when the payload matches", async () => {
    remember("resp_amp_restore", "kept");
    await flushResponseState();
    rmSync(snapshot, { force: true });

    remember("resp_amp_oversized_2", "y".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(existsSync(snapshot)).toBe(true);
  });

  // Deletion is the easy half. The cached digest describes what THIS process last
  // wrote, which is not the same claim as "that is what is on disk now" — a second
  // proxy sharing the home, or anything rewriting the file in place, leaves the
  // digest describing bytes that are gone. Before the skip existed, every flush
  // rewrote and so repaired that silently; skipping on the digest alone would turn
  // a self-healing snapshot into a permanently corrupt one, discovered only at the
  // next restart when the continuation state fails to load.
  //
  // Same-length replacement is the case that defeats a size-only check, so that is
  // what this drives.
  test("a snapshot replaced with different bytes of the same length is rewritten", async () => {
    remember("resp_amp_replaced", "kept");
    await flushResponseState();

    const original = readFileSync(snapshot, "utf-8");
    writeFileSync(snapshot, "X".repeat(Buffer.byteLength(original, "utf8")));

    // A mutation whose bounded payload is byte-identical to the last write: the
    // oversized entry is dropped by the per-entry bound, so the digest still matches.
    remember("resp_amp_replaced_oversized", "y".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(readFileSync(snapshot, "utf-8")).toBe(original);
  });

  // Content is not the whole invariant. This file holds persisted request and response
  // bodies and is written owner-only; the unconditional rewrite used to restore that on
  // every mutation. Skipping on content alone would let a widened mode persist for the
  // life of the process, which is a durable privacy regression rather than a slow one.
  test.skipIf(process.platform === "win32")("a snapshot whose mode was broadened is rewritten and re-hardened", async () => {
    remember("resp_amp_perm", "sensitive");
    await flushResponseState();
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);

    chmodSync(snapshot, 0o644);

    // Same trick as above: the oversized entry is dropped by the per-entry bound, so
    // the bounded payload is byte-identical and only the mode differs.
    remember("resp_amp_perm_oversized", "y".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
  });

  test("the scheduled debounce stays at its base value for a small snapshot", async () => {
    remember("resp_amp_tiny", "tiny");
    await flushResponseState();

    const delay = scheduledDelay(() => remember("resp_amp_tiny_2", "tiny"));
    await flushResponseState();

    expect(delay).toBe(2_000);
  });

  test("the scheduled debounce stretches once the snapshot is large", async () => {
    // Four ~800 KiB entries: each under the 2 MiB per-entry bound, so all four are
    // persisted and the payload lands well past the 1 MiB scaling threshold.
    for (let i = 0; i < 4; i += 1) remember(`resp_amp_big_${i}`, "z".repeat(800 * 1024));
    await flushResponseState();

    const delay = scheduledDelay(() => remember("resp_amp_big_next", "next"));
    await flushResponseState();

    expect(delay).toBeGreaterThan(2_000);
    expect(delay).toBeLessThanOrEqual(30_000);
    // Roughly proportional to size: ~3.2 MiB of payload is ~6 s, not ~2 s.
    expect(delay).toBeGreaterThanOrEqual(5_000);
  });

  // The ceiling is the half of the scaling rule that a proportional formula gets
  // wrong silently: `<= 30_000` passes for any well-behaved input, so it proves
  // the clamp exists only when something actually reaches it. A snapshot at the
  // byte cap is the case that does.
  test("the scheduled debounce clamps to exactly 30s at the snapshot cap", async () => {
    // The scaling rule is 2s per MiB, so a payload at or past 15 MiB computes above
    // the ceiling. 900 KB of text per entry matters: the entry is serialized with the
    // input echoed alongside the output, so ~1.5 MB of text lands past the 2 MiB
    // per-entry bound and is skipped entirely, leaving an empty snapshot.
    for (let i = 0; i < 20; i += 1) remember(`resp_amp_cap_${i}`, "c".repeat(900 * 1024));
    await flushResponseState();
    // Guard the premise: if the snapshot did not actually get large, a passing
    // clamp assertion below would be proving nothing.
    expect(statSync(snapshot).size).toBeGreaterThan(15 * 1024 * 1024);

    const delay = scheduledDelay(() => remember("resp_amp_cap_next", "next"));
    await flushResponseState();

    expect(delay).toBe(30_000);
  });

  // Shutdown is the one moment the debounce must not apply: a pending write that
  // waits out a 30s timer during a graceful stop is a lost turn, and the longer
  // the debounce grows the more there is to lose. The existing tests all flush
  // immediately after each change, so none of them proves the pending case.
  test("a graceful flush writes changes still sitting behind the debounce", async () => {
    remember("resp_amp_drain_seed", "seed");
    await flushResponseState();

    // Two changes with NO flush between them: the debounce timer is pending and
    // neither has reached disk when the graceful flush arrives.
    remember("resp_amp_drain_late", "late");
    remember("resp_amp_drain_late2", "late2");

    await flushResponseState();

    const parsed = JSON.parse(await Bun.file(snapshot).text()) as {
      states: [string, Record<string, unknown>][];
    };
    const ids = parsed.states.map(([id]) => id);
    expect(ids).toContain("resp_amp_drain_late");
    expect(ids).toContain("resp_amp_drain_late2");
  });

  test("the snapshot still round-trips after a skipped write", async () => {
    remember("resp_amp_roundtrip", "payload");
    await flushResponseState();
    remember("resp_amp_roundtrip_oversized", "w".repeat(3 * 1024 * 1024));
    await flushResponseState();

    const parsed = JSON.parse(await Bun.file(snapshot).text()) as {
      version: number;
      states: [string, Record<string, unknown>][];
    };
    expect(parsed.version).toBe(2);
    expect(parsed.states.map(([id]) => id)).toContain("resp_amp_roundtrip");
  });
});
