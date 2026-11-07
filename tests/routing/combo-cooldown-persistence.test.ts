import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { PersistedCooldownMap } from "../../src/combos/cooldown-store";
import { clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos/failover";

type Row = { cooldownUntil: number; revision: number; status?: number };

let home: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-cooldown-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  clearComboTargetCooldowns();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

test("a combo cooldown is written with an absolute expiry and reloaded by a fresh map", async () => {
  const target = { provider: "provider-a", model: "model-x" };
  expect(coolComboTarget("combo-a", target, { retryAfter: "600", status: 429 })).toBe(true);
  // The production write is debounced (250 ms); wait it out before reading the file.
  await wait(500);
  const rows = JSON.parse(readFileSync(join(home, "combo-cooldowns.json"), "utf8")) as Record<string, { cooldownUntil: number; status?: number }>;
  const key = Object.keys(rows).find(k => k.includes("provider-a/model-x"))!;
  expect(rows[key]!.cooldownUntil).toBeGreaterThan(Date.now() + 500_000);
  expect(rows[key]!.status).toBe(429);

  // A restart is a new map reading the same file.
  const restarted = new PersistedCooldownMap<Row>(() => 1);
  expect(restarted.has(key)).toBe(true);
  expect(restarted.get(key)?.status).toBe(429);
  expect(isComboTargetInCooldown("combo-a", target)).toBe(true);
});

test("expired rows and a corrupt file are ignored", () => {
  writeFileSync(join(home, "combo-cooldowns.json"), JSON.stringify({
    stale: { cooldownUntil: Date.now() - 1000 },
    live: { cooldownUntil: Date.now() + 60_000 },
  }));
  const map = new PersistedCooldownMap<Row>(() => 1);
  expect(map.has("stale")).toBe(false);
  expect(map.has("live")).toBe(true);

  writeFileSync(join(home, "combo-cooldowns.json"), "{not json");
  expect(new PersistedCooldownMap<Row>(() => 1).size).toBe(0);
});
