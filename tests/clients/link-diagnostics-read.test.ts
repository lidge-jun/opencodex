import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkDiagnosticSink } from "../../src/link/diagnostics";
import { LINK_DIAGNOSTICS_MAX_LIMIT, readLinkDiagnostics } from "../../src/link/diagnostics-read";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
const posixOnly = process.platform === "win32" ? test.skip : test;

function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), "ocx-link-diagnostics-read-"));
  roots.push(configDir);
  const dir = join(configDir, "link");
  return { configDir, dir, current: join(dir, "diagnostics.jsonl"), backup: join(dir, "diagnostics.jsonl.1") };
}
const line = (value: unknown): string => JSON.stringify(value) + "\n";
const transition = (timestamp: number, attempt = 1) => ({ event: "tunnel_transition", outcome: "network", state: "reconnecting", previousState: "connected", attempt, tunnelPort: 43110, timestamp });

/** Size, mtime and mode of every entry, so a reader that writes, chmods or creates anything shows up. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const info = statSync(child, { throwIfNoEntry: false });
      if (!info) continue;
      out[child] = info.size + ":" + info.mtimeMs + ":" + info.mode;
      if (info.isDirectory()) walk(child);
    }
  };
  walk(root);
  return out;
}

describe("readLinkDiagnostics", () => {
  test("an absent link directory reads as absent and creates nothing", async () => {
    const { configDir } = fixture();
    const result = await readLinkDiagnostics({ configDir });
    expect(result).toEqual({
      files: [{ name: "diagnostics.jsonl.1", state: "absent", truncated: false }, { name: "diagnostics.jsonl", state: "absent", truncated: false }],
      records: [], matched: 0, skipped: 0,
    });
    expect(readdirSync(configDir)).toEqual([]);
  });

  test("returns the backup before the current file, in line order, and keeps the newest records under a limit", async () => {
    const { configDir, dir, current, backup } = fixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(backup, line(transition(30, 1)) + line(transition(10, 2)));
    writeFileSync(current, line(transition(20, 3)) + line(transition(40, 4)));
    const all = await readLinkDiagnostics({ configDir });
    expect(all.records.map(record => record.attempt)).toEqual([1, 2, 3, 4]);
    expect(all.files.map(file => file.state)).toEqual(["read", "read"]);
    const latest = await readLinkDiagnostics({ configDir, limit: 2 });
    expect(latest.records.map(record => record.attempt)).toEqual([3, 4]);
    expect(latest.matched).toBe(4);
    const since = await readLinkDiagnostics({ configDir, since: 25 });
    expect(since.records.map(record => record.attempt)).toEqual([1, 4]);
    expect(since.matched).toBe(2);
    // The limit is clamped, never trusted to size the result.
    expect((await readLinkDiagnostics({ configDir, limit: 10 ** 9 })).records).toHaveLength(4);
    expect(LINK_DIAGNOSTICS_MAX_LIMIT).toBeLessThanOrEqual(1000);
  });

  test("re-applies the writer's allowlist: unknown fields, values and events never come back", async () => {
    const { configDir, dir, current } = fixture();
    mkdirSync(dir, { recursive: true });
    const requestId = randomUUID();
    const evil = "\u001b[31mowned\u001b[0m\u0007";
    writeFileSync(current, [
      line({ event: "owner_lookup", outcome: "match", requestId, checkId: requestId + "\nX", state: "connected", previousState: evil,
        elapsedMs: 1.5, generation: 2, attempt: 0.5, tunnelPort: 70000, retryAfterMs: -1, timestamp: 5, suppressed: 3,
        alias: evil, error: "private-error", linkId: "lnk_0123456789abcdef", url: "https://private.test" }),
      line({ event: evil, outcome: "match", timestamp: 6 }),
      line({ event: "owner_lookup", outcome: evil, timestamp: 7 }),
      line({ event: "relay_failure", outcome: "auth_timeout", timestamp: "8", suppressed: 0 }),
      line(["owner_lookup", "match"]),
      line("owner_lookup"),
      "{not json " + evil + "\n",
      "\n",
      '{"event":"relay_retry","outcome":"deadline","timestamp":9,"__proto__":{"polluted":"x"}}\n',
    ].join(""));
    const result = await readLinkDiagnostics({ configDir });
    expect(result.records).toEqual([
      { event: "owner_lookup", outcome: "match", requestId, state: "connected", generation: 2, elapsedMs: 1.5, timestamp: 5, suppressed: 3 },
      { event: "relay_failure", outcome: "auth_timeout" },
      { event: "relay_retry", outcome: "deadline", timestamp: 9 },
    ]);
    expect(result.skipped).toBe(5);
    const serialized = JSON.stringify(result);
    for (const leaked of ["owned", "private", "lnk_", "\\u001b", "\\u0007", "polluted"]) expect(serialized).not.toContain(leaked);
  });

  test("a timestamp outside the JavaScript Date range is dropped and the record kept", async () => {
    const { configDir, dir, current } = fixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(current, line({ event: "owner_lookup", outcome: "match", timestamp: 9_000_000_000_000_000 })
      + line({ event: "owner_lookup", outcome: "mismatch", timestamp: 8_640_000_000_000_000 }));
    const result = await readLinkDiagnostics({ configDir });
    expect(result.records).toEqual([
      { event: "owner_lookup", outcome: "match" },
      { event: "owner_lookup", outcome: "mismatch", timestamp: 8_640_000_000_000_000 },
    ]);
  });

  test("reads only the newest 256 KiB of an oversized file and skips overlong lines", async () => {
    const { configDir, dir, current } = fixture();
    mkdirSync(dir, { recursive: true });
    const record = line(transition(1));
    const count = Math.ceil((300 * 1024) / record.length);
    writeFileSync(current, record.repeat(count) + JSON.stringify({ ...transition(2), pad: "x".repeat(8192) }) + "\n" + line(transition(3, 9)));
    const result = await readLinkDiagnostics({ configDir, limit: LINK_DIAGNOSTICS_MAX_LIMIT });
    expect(result.files[1]).toEqual({ name: "diagnostics.jsonl", state: "read", truncated: true });
    expect(result.matched).toBeLessThan(count);
    expect(result.matched * record.length).toBeLessThanOrEqual(256 * 1024);
    expect(result.records.at(-1)).toEqual(transition(3, 9));
    // The cut first line and the 8 KiB line are both skipped, never parsed.
    expect(result.skipped).toBe(2);
  });

  posixOnly("never follows a symlinked file or link directory, and never opens a FIFO", async () => {
    const { configDir, dir, current, backup } = fixture();
    mkdirSync(dir, { recursive: true });
    const outside = join(configDir, "outside.jsonl");
    writeFileSync(outside, line(transition(1)));
    symlinkSync(outside, current);
    expect(Bun.spawnSync(["mkfifo", backup]).exitCode).toBe(0);
    const started = Date.now();
    const result = await readLinkDiagnostics({ configDir });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.files.map(file => file.state)).toEqual(["refused", "refused"]);
    expect(result.records).toEqual([]);

    const other = fixture();
    const realDir = join(other.configDir, "real-link");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "diagnostics.jsonl"), line(transition(1)));
    symlinkSync(realDir, other.dir);
    const viaLink = await readLinkDiagnostics({ configDir: other.configDir });
    expect(viaLink.files.map(file => file.state)).toEqual(["refused", "refused"]);
    expect(viaLink.records).toEqual([]);
  });

  posixOnly("is read-only: no new files, no chmod, no rewrite of what it read", async () => {
    const { configDir, dir, current, backup } = fixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(backup, line(transition(1)));
    writeFileSync(current, line(transition(2)) + "garbage\n");
    chmodSync(dir, 0o755);
    chmodSync(current, 0o644);
    const before = snapshot(configDir);
    await new Promise(resolve => setTimeout(resolve, 20));
    const result = await readLinkDiagnostics({ configDir });
    expect(result.records).toHaveLength(2);
    expect(snapshot(configDir)).toEqual(before);
  });

  test("reads back exactly what the writer recorded", async () => {
    const { configDir } = fixture();
    let now = 1_000;
    const sink = createLinkDiagnosticSink({ configDir, now: () => now });
    sink({ event: "tunnel_transition", outcome: "spawned", previousState: "idle", state: "connecting", attempt: 1, tunnelPort: 43110 });
    now = 3_000;
    sink({ event: "tunnel_transition", outcome: "connected", previousState: "connecting", state: "connected", attempt: 0, tunnelPort: 43110 });
    await sink.flush();
    const result = await readLinkDiagnostics({ configDir });
    expect(result.records).toEqual([
      { event: "tunnel_transition", outcome: "spawned", state: "connecting", previousState: "idle", attempt: 1, tunnelPort: 43110, timestamp: 1_000 },
      { event: "tunnel_transition", outcome: "connected", state: "connected", previousState: "connecting", attempt: 0, tunnelPort: 43110, timestamp: 3_000 },
    ]);
    expect(result.skipped).toBe(0);
  });
});
