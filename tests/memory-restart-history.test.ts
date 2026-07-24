import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMemoryRestartHistory,
  recordMemoryRestart,
  RESTART_HISTORY_WINDOW_MS,
  setRestartHistoryPathForTests,
} from "../src/server/memory-restart-history";

const NOW = 10 * RESTART_HISTORY_WINDOW_MS; // comfortably past the window so pruning math never goes negative

let tempRoot: string | null = null;

function isolatedHistoryPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "ocx-restart-history-"));
  const path = join(tempRoot, "memory-watchdog-restarts.json");
  setRestartHistoryPathForTests(path);
  return path;
}

afterEach(() => {
  setRestartHistoryPathForTests(null);
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("loadMemoryRestartHistory", () => {
  test("missing file seeds a fresh slate", () => {
    isolatedHistoryPath();
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: 0, recentCount: 0 });
  });

  test("corrupt JSON seeds a fresh slate instead of throwing", () => {
    const path = isolatedHistoryPath();
    writeFileSync(path, "{ not json", "utf-8");
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: 0, recentCount: 0 });
  });

  test("wrong schema (version mismatch / non-array) seeds a fresh slate", () => {
    const path = isolatedHistoryPath();
    writeFileSync(path, JSON.stringify({ version: 99, restarts: [NOW - 1_000] }), "utf-8");
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: 0, recentCount: 0 });
    writeFileSync(path, JSON.stringify({ version: 1, restarts: "nope" }), "utf-8");
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: 0, recentCount: 0 });
  });

  test("entries outside the rolling window are ignored; entries inside count", () => {
    const path = isolatedHistoryPath();
    const inside = NOW - RESTART_HISTORY_WINDOW_MS + 60_000;
    const outside = NOW - RESTART_HISTORY_WINDOW_MS - 60_000;
    writeFileSync(path, JSON.stringify({ version: 1, restarts: [outside, inside] }), "utf-8");
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: inside, recentCount: 1 });
  });

  test("future timestamps (clock rollback) are dropped so the cooldown cannot be pinned", () => {
    const path = isolatedHistoryPath();
    writeFileSync(path, JSON.stringify({ version: 1, restarts: [NOW + 3_600_000] }), "utf-8");
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: 0, recentCount: 0 });
  });

  test("non-numeric entries are filtered, valid ones survive", () => {
    const path = isolatedHistoryPath();
    writeFileSync(path, JSON.stringify({ version: 1, restarts: ["x", null, NOW - 1_000, Number.NaN] }), "utf-8");
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: NOW - 1_000, recentCount: 1 });
  });
});

describe("recordMemoryRestart", () => {
  test("record + load roundtrip seeds the next process", () => {
    isolatedHistoryPath();
    recordMemoryRestart(NOW - 2_000);
    recordMemoryRestart(NOW - 1_000);
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: NOW - 1_000, recentCount: 2 });
  });

  test("recording prunes expired entries and caps the file", () => {
    const path = isolatedHistoryPath();
    const stale = Array.from({ length: 5 }, (_, i) => NOW - RESTART_HISTORY_WINDOW_MS - (i + 1) * 1_000);
    writeFileSync(path, JSON.stringify({ version: 1, restarts: stale }), "utf-8");
    for (let i = 0; i < 30; i++) recordMemoryRestart(NOW - (30 - i) * 1_000);
    const persisted = JSON.parse(readFileSync(path, "utf-8")) as { restarts: number[] };
    expect(persisted.restarts.length).toBeLessThanOrEqual(20);
    expect(Math.min(...persisted.restarts)).toBeGreaterThan(NOW - RESTART_HISTORY_WINDOW_MS);
  });

  test("a write failure is swallowed (history must never block the restart)", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "ocx-restart-history-"));
    // Point the history "file" at an existing DIRECTORY: writeFileSync/rename must fail on every OS.
    const dirAsFile = join(tempRoot, "history-dir");
    mkdirSync(dirAsFile);
    setRestartHistoryPathForTests(dirAsFile);
    expect(() => recordMemoryRestart(NOW)).not.toThrow();
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: 0, recentCount: 0 });
  });

  test("creates the parent directory when missing", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "ocx-restart-history-"));
    const nested = join(tempRoot, "deep", "nested", "memory-watchdog-restarts.json");
    setRestartHistoryPathForTests(nested);
    recordMemoryRestart(NOW);
    expect(loadMemoryRestartHistory(NOW)).toEqual({ lastRestartAt: NOW, recentCount: 1 });
  });

  test("persists only timestamps — no config, request or account data", () => {
    const path = isolatedHistoryPath();
    recordMemoryRestart(NOW);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["restarts", "version"]);
    expect((raw.restarts as unknown[]).every(t => typeof t === "number")).toBe(true);
  });
});
