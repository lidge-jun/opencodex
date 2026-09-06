import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import { clearPoolRotationState } from "../src/codex/pool-rotation";
import { clearCodexUpstreamHealth, clearThreadAccountMap, recordCodexUpstreamOutcome, resolveCodexAccountForThread } from "../src/codex/routing";
import { clearKeyCooldowns, getKeyCooldownUntil, rotateKeyOn429 } from "../src/providers/key-failover";
import type { OcxConfig } from "../src/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hasGo = Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
const binary = hasGo ? (() => { const p = join(mkdtempSync(join(tmpdir(), "ocx-go-routing-")), "ocx-sidecar"); const r = Bun.spawnSync(["go", "build", "-o", p, "./cmd/ocx-sidecar"], { cwd: join(root, "go"), env: { ...process.env, CGO_ENABLED: "0" }, stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr)); return p; })() : null;
let home = "";

function config(strategy = "quota", active = "a", threshold = 80): OcxConfig { return { providers: {}, accountPoolStrategy: strategy as OcxConfig["accountPoolStrategy"], activeCodexAccountId: active, autoSwitchThreshold: threshold, codexAccounts: ["a", "b", "c"].map(id => ({ id, email: id + "@example.test", isMain: false })) } as OcxConfig; }
function credential(id: string) { saveCodexAccountCredential(id, { accessToken: "access-" + id, refreshToken: "refresh-" + id, expiresAt: Date.now() + 60_000, chatgptAccountId: "acct-" + id }); }
function go(vector: unknown) { const r = Bun.spawnSync([binary!, "routingcheck", JSON.stringify([vector])], { stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr)); return JSON.parse(new TextDecoder().decode(r.stdout))[0]; }

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-go-routing-state-")); process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home; clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); clearKeyCooldowns(); ["a", "b", "c"].forEach(credential); });
afterEach(() => { delete process.env.OPENCODEX_HOME; delete process.env.CODEX_HOME; clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); clearKeyCooldowns(); });

describe.skipIf(!hasGo || !binary)("Go hot-path routing differential (ticket #30)", () => {
  test("quota account selection uses resolveCodexAccountForThread as its oracle", () => {
    const cfg = config(); updateAccountQuota("a", 90); updateAccountQuota("b", 10); updateAccountQuota("c", 30);
    const ts = resolveCodexAccountForThread(null, cfg);
    const decision = go({ nowMs: Date.now(), activeAccountId: "a", autoSwitchThreshold: 80, accounts: [{ id: "a", usable: true, usagePercent: 90 }, { id: "b", usable: true, usagePercent: 10 }, { id: "c", usable: true, usagePercent: 30 }] });
    expect(decision).toEqual({ accountId: ts });
  });

  test("cooldown admission excludes the same account as resolveCodexAccountForThread", () => {
    const now = Date.now(); const cfg = config(); updateAccountQuota("a", 10); updateAccountQuota("b", 20); updateAccountQuota("c", 30);
    recordCodexUpstreamOutcome(cfg, "a", 429, { now, retryAfter: "60" });
    const ts = resolveCodexAccountForThread(null, cfg);
    const decision = go({ nowMs: now, activeAccountId: "a", accounts: [{ id: "a", usable: true, usagePercent: 10, cooldownUntilMs: now + 60_000 }, { id: "b", usable: true, usagePercent: 20 }, { id: "c", usable: true, usagePercent: 30 }] });
    expect(decision).toEqual({ accountId: ts });
  });

  test("key failover uses rotateKeyOn429 as its oracle", () => {
    const now = 1_000_000; const keys = [{ id: "k1", key: "one", addedAt: 1 }, { id: "k2", key: "two", addedAt: 2 }, { id: "k3", key: "three", addedAt: 3 }];
    const cfg = { defaultProvider: "p", providers: { p: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "one", apiKeyPool: keys } } } as unknown as OcxConfig;
    const rotated = rotateKeyOn429(cfg, "p", "7", now, "one");
    const ts = { keyId: rotated?.apiKey === "two" ? "k2" : rotated?.apiKey === "three" ? "k3" : undefined, cooldownUntilMs: getKeyCooldownUntil("p", "k1", now) ?? undefined };
    const decision = go({ nowMs: now, keys: [{ id: "k1" }, { id: "k2" }, { id: "k3" }], failedKeyId: "k1", status: 429, retryAfter: "7" });
    expect(decision).toEqual(ts);
  });
});
