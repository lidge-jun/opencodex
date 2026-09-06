import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hasGo = Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
const binary = hasGo ? (() => {
  const path = join(mkdtempSync(join(tmpdir(), "ocx-go-routing-")), "ocx-sidecar");
  const result = Bun.spawnSync(["go", "build", "-o", path, "./cmd/ocx-sidecar"], { cwd: join(root, "go"), env: { ...process.env, CGO_ENABLED: "0" }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return path;
})() : null;

function go(vectors: Record<string, unknown>[]) {
  const result = Bun.spawnSync([binary!, "routingcheck", JSON.stringify(vectors)], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

describe.skipIf(!hasGo || !binary)("Go hot-path routing differential (ticket #30)", () => {
  test("quota/account, cooldown admission, and key failover decisions match state vectors", () => {
    // Values are worked from the TS routing rules in codex/routing.ts and
    // providers/key-failover.ts, then compared to the Go executable oracle.
    expect(go([
      { nowMs: 1000, activeAccountId: "a", accounts: [{ id: "a", usable: true, usagePercent: 90 }, { id: "b", usable: true, usagePercent: 10 }, { id: "c", usable: true, usagePercent: 1, cooldownUntilMs: 2000 }] },
      { nowMs: 1000, strategy: "fill-first", activeAccountId: "b", accounts: [{ id: "b", usable: true, usagePercent: 90 }, { id: "a", usable: true, usagePercent: 10 }] },
      { nowMs: 1000, accounts: [{ id: "a", usable: true, cooldownUntilMs: 5000 }, { id: "b", usable: true, softAvoidUntilMs: 3000 }] },
      { nowMs: 1000, keys: [{ id: "a" }, { id: "b" }, { id: "c", cooldownUntilMs: 9000 }], failedKeyId: "a", status: 429, retryAfter: "7" },
    ])).toEqual([
      { accountId: "b" },
      { accountId: "a" },
      { cooldownUntilMs: 3000 },
      { cooldownUntilMs: 8000, keyId: "b" },
    ]);
  });
});
