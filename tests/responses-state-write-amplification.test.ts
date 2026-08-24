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
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
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
