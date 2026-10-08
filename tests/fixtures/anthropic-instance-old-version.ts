/** Hosted-only STATE-11 probe: execute the pinned pre-feature source against synthetic homes. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PIN = "6a7632db2a85c359da9feac976180450ebb42c60";
const [checkoutArg, receiptArg] = process.argv.slice(2);
assert(checkoutArg && receiptArg, "Provide pinned checkout and receipt paths");
const checkout = resolve(checkoutArg);
const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(head, PIN, "Old-version probe must use the pinned pre-feature commit");
const sandbox = mkdtempSync(join(tmpdir(), "ocx-old-anthropic-instance-"));
const roots = { HOME: sandbox, USERPROFILE: sandbox, OPENCODEX_HOME: join(sandbox, "ocx"),
  CODEX_HOME: join(sandbox, "codex"), CLAUDE_CONFIG_DIR: join(sandbox, "claude"), XDG_CONFIG_HOME: join(sandbox, "xdg") };
for (const [key, value] of Object.entries(roots)) {
  mkdirSync(value, { recursive: true, mode: 0o700 });
  process.env[key] = value;
}
globalThis.fetch = (async () => { throw new Error("Network forbidden in old-version fixture"); }) as typeof fetch;
const loadOld = (path: string) => import(pathToFileURL(join(checkout, path)).href);
try {
  const store = await loadOld("src/oauth/store.ts") as typeof import("../../src/oauth/store");
  const config = await loadOld("src/config.ts") as typeof import("../../src/config");
  assert.equal(store.getAuthStorePath(), join(roots.OPENCODEX_HOME, "auth.json"));
  const credential = (name: string) => ({ access: `synthetic-old-${name}-access`,
    refresh: `synthetic-old-${name}-refresh`, expires: 4_000_000_000_000, accountId: `synthetic-old-${name}-id`, source: "oauth" });
  const auth = Object.fromEntries(["anthropic", "anthropic2"].map(provider => [provider, {
    activeAccountId: "shared-slot", selectionRevision: "11111111-1111-4111-8111-111111111111",
    accounts: [{ id: "shared-slot", loginId: provider === "anthropic"
      ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
      credential: credential(provider), addedAt: 1_000 }],
  }]));
  const authPath = store.getAuthStorePath();
  writeFileSync(authPath, JSON.stringify(auth) + "\n", { mode: 0o600 });
  const initial = store.loadAuthStore();
  assert.deepEqual(initial.anthropic2, auth.anthropic2, "Old read must retain orphan B");
  const primaryBefore = structuredClone(initial.anthropic);
  assert.equal(await store.setAccountAlias("anthropic", "shared-slot", "primary"), true);
  const afterAWrite = JSON.parse(readFileSync(authPath, "utf8"));
  assert.deepEqual(afterAWrite.anthropic2, initial.anthropic2, "Old A write must retain B");
  const aAfter = structuredClone(afterAWrite.anthropic);
  assert.equal(await store.setAccountAlias("anthropic2", "shared-slot", "secondary"), true);
  const afterBWrite = JSON.parse(readFileSync(authPath, "utf8"));
  assert.deepEqual(afterBWrite.anthropic, aAfter, "Old B write must not mutate A");
  assert.deepEqual(afterBWrite.anthropic2.accounts[0].credential, initial.anthropic2.accounts[0].credential);

  const raw = { port: 10100, defaultProvider: "anthropic", providers: {
    anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" },
    anthropic2: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com",
      anthropicOAuthInstance: "anthropic2", anthropicAccountPool: { enabled: true } },
  }, anthropicAccountPool: { enabled: false }, webSearchSidecar: { backend: "anthropic", anthropicInstance: "anthropic2" } };
  writeFileSync(config.getConfigPath(), JSON.stringify(raw) + "\n", { mode: 0o600 });
  const loaded = config.loadConfig();
  assert.equal(loaded.defaultProvider, "anthropic");
  assert.equal(loaded.anthropicAccountPool?.enabled, false);
  assert.equal(loaded.providers.anthropic2?.anthropicAccountPool?.enabled, true);
  const authBeforeSalvage = readFileSync(authPath, "utf8");
  const malformed = { ...raw, combos: { invalidEntry: 42 } };
  writeFileSync(config.getConfigPath(), JSON.stringify(malformed) + "\n", { mode: 0o600 });
  const salvaged = config.loadConfig();
  assert.equal(salvaged.defaultProvider, "anthropic");
  assert.equal(salvaged.providers.anthropic.adapter, "anthropic");
  assert.equal(salvaged.anthropicAccountPool?.enabled, false);
  assert.equal(salvaged.combos?.invalidEntry, undefined);
  assert.deepEqual(salvaged.providers.anthropic2, loaded.providers.anthropic2);
  assert.equal(salvaged.webSearchSidecar?.anthropicInstance, "anthropic2");
  assert.equal(readFileSync(authPath, "utf8"), authBeforeSalvage, "Config salvage must not mutate auth");
  assert.equal(primaryBefore.accounts[0]!.credential.access, credential("anthropic").access);
  const receipt = {
    criterion: "STATE-11", pinnedCommit: head, runtime: Bun.version,
    orphanBReadPreserved: true, orphanBAfterAWritePreserved: true,
    primaryAfterBWritePreserved: true, configSalvageKeptPrimary: true,
    configSalvageTouchedAuth: false, inPlaceDowngradeSupported: false,
    syntheticOnly: true,
  };
  mkdirSync(resolve(receiptArg, ".."), { recursive: true });
  writeFileSync(resolve(receiptArg), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
