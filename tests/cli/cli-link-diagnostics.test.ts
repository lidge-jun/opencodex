import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinkCommand } from "../../src/cli/link";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { skipsCodexShimAutoRestore } from "../../src/cli/preflight-exemptions";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function fixture(): { configDir: string; dir: string; current: string } {
  const configDir = mkdtempSync(join(tmpdir(), "ocx-cli-link-diagnostics-"));
  roots.push(configDir);
  const dir = join(configDir, "link");
  return { configDir, dir, current: join(dir, "diagnostics.jsonl") };
}

/** No runtime discovery and no HTTP: a diagnostics read that reaches either fails the test. */
const offline = {
  findLiveProxy: async () => { throw new Error("diagnostics must not look for the proxy"); },
  fetch: (async () => { throw new Error("diagnostics must not fetch"); }) as unknown as typeof fetch,
};

async function run(args: string[], configDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  try {
    const code = await runLinkCommand(["diagnostics", ...args], { ...offline, linkConfigDir: configDir });
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const line = (value: unknown): string => JSON.stringify(value) + "\n";

describe("ocx link diagnostics", () => {
  test("an absent file says so with its path and creates nothing", async () => {
    const { configDir, current } = fixture();
    const result = await run([], configDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No Remote Link diagnostics recorded yet");
    expect(result.stdout).toContain(current);
    expect(readdirSync(configDir)).toEqual([]);
  });

  test("a timestamp outside the Date range never breaks either output", async () => {
    const { configDir, dir, current } = fixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(current, line({ event: "owner_lookup", outcome: "match", timestamp: 9_000_000_000_000_000 }));
    const human = await run([], configDir);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("owner_lookup");
    const json = await run(["--json"], configDir);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).records).toEqual([{ event: "owner_lookup", outcome: "match" }]);
  });

  test("--json prints the sanitized document and leaves the file untouched", async () => {
    const { configDir, dir, current } = fixture();
    mkdirSync(dir, { recursive: true });
    const content = line({ event: "tunnel_transition", outcome: "auth", previousState: "connecting", state: "failed", attempt: 3, tunnelPort: 43110, timestamp: 1_700_000_000_000, alias: "\u001b]0;evil\u0007" })
      + "not-json\n" + line({ event: "relay_recovered", outcome: "recovered", timestamp: 1_700_000_001_000, suppressed: 2 });
    writeFileSync(current, content);
    const result = await run(["--json"], configDir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "ocx.link.diagnostics/1",
      path: current,
      files: [{ name: "diagnostics.jsonl.1", state: "absent", truncated: false }, { name: "diagnostics.jsonl", state: "read", truncated: false }],
      matched: 2,
      skipped: 1,
      records: [
        { event: "tunnel_transition", outcome: "auth", state: "failed", previousState: "connecting", attempt: 3, tunnelPort: 43110, timestamp: 1_700_000_000_000 },
        { event: "relay_recovered", outcome: "recovered", timestamp: 1_700_000_001_000, suppressed: 2 },
      ],
    });
    expect(result.stdout).not.toContain("evil");
    expect(readFileSync(current, "utf8")).toBe(content);
    expect(readdirSync(dir)).toEqual(["diagnostics.jsonl"]);
  });

  test("human output is a compact table of the newest records", async () => {
    const { configDir, dir, current } = fixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(current, line({ event: "tunnel_transition", outcome: "spawned", previousState: "idle", state: "connecting", attempt: 1, tunnelPort: 43110, timestamp: Date.UTC(2026, 10, 11, 1, 2, 3) })
      + line({ event: "tunnel_transition", outcome: "network", previousState: "connected", state: "reconnecting", attempt: 2, tunnelPort: 43110, timestamp: Date.UTC(2026, 10, 11, 1, 2, 4), suppressed: 4 })
      + line({ event: "owner_lookup", outcome: "match" }));
    const result = await run(["--limit", "2"], configDir);
    expect(result.code).toBe(0);
    const rows = result.stdout.split("\n");
    expect(rows[0]).toMatch(/^TIME\s+EVENT\s+OUTCOME\s+STATE\s+ATTEMPT\s+PORT$/);
    expect(rows[1]).toMatch(/^2026-11-11T01:02:04\.000Z\s+tunnel_transition\s+network \(\+4 suppressed\)\s+connected -> reconnecting\s+2\s+43110$/);
    expect(rows[2]).toMatch(/^-\s+owner_lookup\s+match\s+-\s+-\s+-$/);
    expect(result.stdout).toContain("Showing 2 of 3 records from " + current);
  });

  test("--since and --limit are validated", async () => {
    const { configDir } = fixture();
    expect((await run(["--limit", "0"], configDir)).code).toBe(2);
    expect((await run(["--limit", "1001"], configDir)).code).toBe(2);
    expect((await run(["--since", "yesterday"], configDir)).code).toBe(2);
    expect((await run(["--bogus"], configDir)).code).toBe(2);
    expect((await run(["--since", "2026-11-11T00:00:00Z"], configDir)).code).toBe(0);
    expect((await run(["--since", "1700000000000"], configDir)).code).toBe(0);
  });

  test("is a local read: no management route, no mutation, no preflight repair", () => {
    const capability = CAPABILITIES.find(entry => entry.command.join(" ") === "link diagnostics");
    expect(capability).toBeDefined();
    expect(capability?.routes).toEqual([]);
    expect(capability?.mutates).toBe(false);
    // Exempt from the shim auto-restore and so from the config-root hardening wait as well.
    expect(skipsCodexShimAutoRestore("link", ["link", "diagnostics"])).toBe(true);
    expect(skipsCodexShimAutoRestore("link", ["link", "diagnostics", "--json"])).toBe(true);
    expect(skipsCodexShimAutoRestore("link", ["link", "status"])).toBe(false);
  });
});
