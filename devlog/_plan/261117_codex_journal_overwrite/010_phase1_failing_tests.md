# 010 — Phase 1: seam and failing tests (wp2)

Goal: one commit that adds a behavior-neutral test seam plus tests that fail on 61bc4428b7 for every defect in `000_plan.md`. No production behavior changes in this phase.

## Seam (MODIFY)

`src/codex/inject/config-write-section.ts` — append:

```ts
/** Where a restore publishes config.toml; the test seam below names the site. */
export type CodexConfigPublishSite = "journal" | "remove" | "retain";
let beforeCodexConfigPublishForTests: ((site: CodexConfigPublishSite) => void) | undefined;
/** Test seam: runs after a restore decided its bytes and before it publishes config.toml. */
export function setBeforeCodexConfigPublishForTests(hook: typeof beforeCodexConfigPublishForTests): void {
  beforeCodexConfigPublishForTests = hook;
}
export function runBeforeCodexConfigPublishForTests(site: CodexConfigPublishSite): void {
  beforeCodexConfigPublishForTests?.(site);
}
```

Call sites (no-ops in production):

- `src/codex/journal.ts:436` — before `publishCodexArtifact(CODEX_CONFIG_PATH, …)` insert `runBeforeCodexConfigPublishForTests("journal");` and add it to the existing `./inject/config-write-section` import.
- `src/codex/inject/remove.ts:263` — before the strip publish: `runBeforeCodexConfigPublishForTests("remove");`
- `src/codex/inject/remove.ts:65` — inside `if (next !== content)`, before publishing: `runBeforeCodexConfigPublishForTests("retain");`

## Tests (NEW)

- `tests/helpers/codex-restore-child.ts` — homes + child runner (below).
- `tests/fixtures/codex-restore-later-edits-runner.ts` — the child (below).
- `tests/codex-integration/codex-restore-later-edits.test.ts` — INV-RESTORE-02 (below).
- `tests/codex-integration/codex-app-rewrite-routing.test.ts` — app rewrite cases (below).

Register both test files (as built: in the new shard `scripts/test-layout/layout-codex-journal.json`, because `layout.json` sits at the 2,000-line ratchet threshold): originally planned for `scripts/test-layout/layout.json` codex-integration explicit map and `tests/fixtures/test-layout-expected.json`, alphabetically beside `codex-restore-app-rewrite.test.ts`:

```json
"codex-app-rewrite-routing.test.ts": "codex-integration",
"codex-restore-later-edits.test.ts": "codex-integration",
```

## Expected on the base (fail-first evidence)

| Test | Base result | Why |
|---|---|---|
| start-recovery, client-recovery | FAIL | routing left in place (`journal.ts:403-409`) |
| stale-journal | FAIL | journal retained + "incomplete" warning |
| race-replay in-place, race-strip in-place, race-retain | FAIL | concurrent write overwritten |
| race-* rename | FAIL or child error | inode refusal then compensation over the foreign file |
| app-stale-values | FAIL | stale URL kept + snapshotted |
| catalog drift, heal notice | FAIL | not detected / not exported |
| stop-sync, stop-async, disconnect-recovery, reinject-stop, untouched-*, app-drops-keys | PASS | guards for behavior that must not regress |

Command: `bun test tests/codex-integration/codex-restore-later-edits.test.ts tests/codex-integration/codex-app-rewrite-routing.test.ts`.

### codex-restore-child.ts

```ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath, repoRoot } from "./repo-root";
import { SPAWN_BUDGET_MS } from "./test-budget";

/** Seed config.toml: a hook trust hash, a trusted project and a disabled plugin, like a real Codex home. */
export const SEED_CONFIG = [
  'model = "gpt-5.5"',
  "",
  '[hooks.state."plugin:demo:hook"]',
  'trusted_hash = "sha256:before"',
  "",
  '[projects."/fixture/existing"]',
  'trust_level = "trusted"',
  "",
  '[plugins."demo@market"]',
  "enabled = false",
  "",
].join("\n");

export const ALL_LATER_EDITS_KEPT = { rootKey: true, hookModified: true, hookAdded: true, projectAdded: true, pluginEnabled: true };
export const NO_OPENCODEX_ROUTING = { openaiBaseUrl: null, realtime: false, catalog: false, providerTable: false };

export interface RestoreChildReport {
  kept: Record<keyof typeof ALL_LATER_EDITS_KEPT, boolean>;
  concurrentKept: boolean;
  routing: { openaiBaseUrl: string | null; realtime: boolean; catalog: boolean; providerTable: boolean };
  journal: boolean;
  configSha256: string;
  [extra: string]: unknown;
}

/** Fresh temporary CODEX_HOME, OPENCODEX_HOME and HOME under one root; the real homes are never named. */
export function makeRestoreHomes(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  for (const dir of ["codex", "ocx", "home"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "codex", "config.toml"), SEED_CONFIG);
  return root;
}

/** Run one scenario of tests/fixtures/codex-restore-later-edits-runner.ts under the homes in root. */
export function runRestoreChild(root: string, scenario: string, variant = ""): { report: RestoreChildReport; stderr: string } {
  const result = spawnSync(process.execPath, [fixturePath("codex-restore-later-edits-runner.ts"), scenario, variant], {
    cwd: repoRoot(),
    env: { ...process.env, CODEX_HOME: join(root, "codex"), OPENCODEX_HOME: join(root, "ocx"), HOME: join(root, "home") },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  if (result.status !== 0 || result.signal !== null) {
    throw new Error("restore child failed: status=" + result.status + " signal=" + (result.signal ?? "none") + "\n" + stderr.slice(-4000));
  }
  return { report: JSON.parse(stdout.split("\n").at(-1) ?? "{}") as RestoreChildReport, stderr };
}
```

### codex-restore-later-edits-runner.ts

```ts
/**
 * Child process for tests/codex-integration/codex-restore-later-edits.test.ts and
 * tests/codex-integration/codex-app-rewrite-routing.test.ts. The parent points CODEX_HOME,
 * OPENCODEX_HOME and HOME at fresh temporary directories; this file never resolves a real home.
 * It prints one JSON line describing what survived, never config values.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { injectCodexConfig, restoreNativeCodex, restoreNativeCodexAsync } from "../../src/codex/inject";
import { setBeforeCodexConfigPublishForTests } from "../../src/codex/inject/config-write-section";
import { retainOcxProviderTableOnDisk } from "../../src/codex/inject/remove";
import { reconcileJournal, restoreJournalState } from "../../src/codex/journal";

const home = process.env.CODEX_HOME;
if (!home) throw new Error("fixture requires CODEX_HOME");
const configPath = join(home, "config.toml");
const journalPath = join(home, "opencodex-journal.json");
const [scenario = "", variant = ""] = process.argv.slice(2);
const ACTIVE_CLIENT = "fixture-active-client";
const DEAD_PID = 2_147_480_000;

const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => {
  if (pid === DEAD_PID && signal === 0) throw Object.assign(new Error("fixture owner exited"), { code: "ESRCH" });
  return realKill(pid, signal);
}) as typeof process.kill;

type InjectSettings = Parameters<typeof injectCodexConfig>[1];
async function inject(port = 10100): Promise<void> {
  const settings = { port, providers: {}, defaultProvider: "openai", injectionModel: "gpt-5.6-sol", injectionEffort: "high" };
  const result = await injectCodexConfig(port, settings as unknown as InjectSettings, { catalogPath: null });
  if (!result.success) throw new Error("fixture injection failed: " + result.message);
}

const read = (): string => readFileSync(configPath, "utf8");
/** Codex writes config.toml with toml_edit + write_atomically: a whole new file renamed into place. */
function replaceAtomically(next: string): void {
  const staged = configPath + ".codex-edit";
  writeFileSync(staged, next);
  renameSync(staged, configPath);
}

/** The edits Codex and the user make while OpenCodex is injected. */
function laterEdits(): void {
  let text = read();
  const firstTable = text.search(/^\[/m);
  text = text.slice(0, firstTable) + 'approval_policy = "never"\n' + text.slice(firstTable);
  text = text.replace('trusted_hash = "sha256:before"', 'trusted_hash = "sha256:after"').replace("enabled = false", "enabled = true");
  text += '\n[hooks.state."plugin:added:hook"]\ntrusted_hash = "sha256:added"\n\n[projects."/fixture/later"]\ntrust_level = "trusted"\n';
  replaceAtomically(text);
}

/** A writer landing after a restore decided its bytes; in place keeps the inode, rename replaces it. */
function concurrentWrite(): void {
  const next = read() + '\n[projects."/fixture/concurrent"]\ntrust_level = "trusted"\n';
  if (variant === "rename") replaceAtomically(next);
  else writeFileSync(configPath, next);
}

function setOwner(owner: { kind: "process"; pid: number } | { kind: "client"; apiKeyId: string }): void {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
  writeFileSync(journalPath, JSON.stringify({ ...journal, pid: DEAD_PID, owner }));
}

/** The Codex app reserializing from its own model: comments dropped, optionally keys rewritten. */
function appRewrite(transform: (line: string) => string | null): void {
  replaceAtomically(read().split("\n").map(transform).filter((line): line is string => line !== null).join("\n"));
}

function journalOriginal(): string | null {
  if (!existsSync(journalPath)) return null;
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { originalConfig: string };
  return Buffer.from(journal.originalConfig, "base64").toString("utf8");
}

function report(extra: Record<string, unknown> = {}): void {
  const text = existsSync(configPath) ? read() : "";
  const parsed = Bun.TOML.parse(text) as Record<string, any>;
  console.log(JSON.stringify({
    kept: {
      rootKey: parsed.approval_policy === "never",
      hookModified: parsed.hooks?.state?.["plugin:demo:hook"]?.trusted_hash === "sha256:after",
      hookAdded: parsed.hooks?.state?.["plugin:added:hook"]?.trusted_hash === "sha256:added",
      projectAdded: parsed.projects?.["/fixture/later"]?.trust_level === "trusted",
      pluginEnabled: parsed.plugins?.["demo@market"]?.enabled === true,
    },
    concurrentKept: parsed.projects?.["/fixture/concurrent"]?.trust_level === "trusted",
    routing: {
      openaiBaseUrl: typeof parsed.openai_base_url === "string" ? parsed.openai_base_url : null,
      realtime: "experimental_realtime_ws_base_url" in parsed,
      catalog: "model_catalog_json" in parsed,
      providerTable: Boolean(parsed.model_providers?.opencodex),
    },
    journal: existsSync(journalPath),
    configSha256: createHash("sha256").update(text).digest("hex"),
    ...extra,
  }));
}

switch (scenario) {
  case "stop-sync": {
    await inject(); laterEdits();
    const result = restoreNativeCodex({ skipHistory: true });
    report({ success: result.success });
    break;
  }
  case "stop-async": {
    await inject(); laterEdits();
    const result = await restoreNativeCodexAsync();
    report({ configState: result.artifacts.config.state });
    break;
  }
  case "start-recovery": {
    await inject(); laterEdits(); setOwner({ kind: "process", pid: DEAD_PID });
    report({ restored: reconcileJournal() });
    break;
  }
  case "client-recovery": {
    await inject(); laterEdits(); setOwner({ kind: "client", apiKeyId: "fixture-other-client" });
    report({ restored: reconcileJournal({ activeClientApiKeyId: ACTIVE_CLIENT }) });
    break;
  }
  case "disconnect-recovery": {
    await inject(); laterEdits(); setOwner({ kind: "client", apiKeyId: ACTIVE_CLIENT });
    const result = restoreJournalState({ preserveConfigEdits: true, recoverConfigForClient: ACTIVE_CLIENT });
    report({ complete: result.complete });
    break;
  }
  case "reinject-stop": {
    await inject(); laterEdits(); await inject(10200);
    const result = restoreNativeCodex({ skipHistory: true });
    report({ success: result.success });
    break;
  }
  case "untouched-stop": {
    await inject();
    report({ success: restoreNativeCodex({ skipHistory: true }).success });
    break;
  }
  case "untouched-start": {
    await inject(); setOwner({ kind: "process", pid: DEAD_PID });
    report({ restored: reconcileJournal() });
    break;
  }
  case "stale-journal": {
    // A field-level stop keeps the journal (unbound) with the pre-injection snapshot.
    await inject(); laterEdits();
    if (!restoreNativeCodex({ skipHistory: true }).success) throw new Error("fixture stop failed");
    replaceAtomically(read() + '\n[projects."/fixture/after-stop"]\ntrust_level = "trusted"\n');
    setOwner({ kind: "process", pid: DEAD_PID });
    const before = createHash("sha256").update(read()).digest("hex");
    report({ restored: reconcileJournal(), beforeSha256: before });
    break;
  }
  case "race-replay": {
    // Untouched since injection, so restore takes the whole-file replay.
    await inject();
    setBeforeCodexConfigPublishForTests(site => { if (site === "journal") concurrentWrite(); });
    const result = restoreNativeCodex({ skipHistory: true });
    report({ success: result.success });
    break;
  }
  case "race-strip": {
    // Changed since injection, so restore takes the field-level strip.
    await inject(); laterEdits();
    setBeforeCodexConfigPublishForTests(site => { if (site === "remove") concurrentWrite(); });
    const result = restoreNativeCodex({ skipHistory: true });
    report({ success: result.success });
    break;
  }
  case "race-retain": {
    laterEdits();
    setBeforeCodexConfigPublishForTests(site => { if (site === "retain") concurrentWrite(); });
    const block = '[model_providers.opencodex]\nname = "OpenCodex"\nbase_url = "http://127.0.0.1:10100/v1"\n';
    let threw = false;
    try { retainOcxProviderTableOnDisk(block); } catch { threw = true; }
    report({ threw });
    break;
  }
  case "app-stale-values": {
    // The app writes back values from an EARLIER injection, without our marker comments.
    await inject(10100); await inject(10200); laterEdits();
    appRewrite(line => line.trim().startsWith("#") ? null : line.replaceAll("127.0.0.1:10200", "127.0.0.1:10100"));
    await inject(10200);
    const synced = Bun.TOML.parse(read()) as Record<string, unknown>;
    const original = journalOriginal() ?? "";
    const result = restoreNativeCodex({ skipHistory: true });
    report({ syncedUrl: synced.openai_base_url ?? null, snapshotHasLoopback: original.includes("127.0.0.1"), success: result.success });
    break;
  }
  case "app-drops-keys": {
    await inject(); laterEdits();
    appRewrite(line => line.trim().startsWith("#") || /^(openai_base_url|model_catalog_json|experimental_realtime_ws_base_url)\s*=/.test(line) ? null : line);
    await inject();
    const original = journalOriginal() ?? "";
    const synced = Bun.TOML.parse(read()) as Record<string, unknown>;
    const result = restoreNativeCodex({ skipHistory: true });
    report({ syncedUrl: synced.openai_base_url ?? null, snapshotHasLaterEdit: original.includes("approval_policy"), snapshotHasLoopback: original.includes("127.0.0.1"), success: result.success });
    break;
  }
  default:
    throw new Error("unknown fixture scenario");
}
```

### codex-restore-later-edits.test.ts

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_LATER_EDITS_KEPT,
  NO_OPENCODEX_ROUTING,
  SEED_CONFIG,
  makeRestoreHomes,
  runRestoreChild,
} from "../helpers/codex-restore-child";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * INV-RESTORE-02: restore never reverts config.toml changes made after injection.
 *
 * Every restore entry point runs in a child under temporary CODEX_HOME, OPENCODEX_HOME and HOME:
 * inject, let "Codex" change hook trust, project trust, a plugin flag and a root key, then restore.
 * Each path must keep every later change and take out only what OpenCodex wrote. The race cases
 * land a write after a restore decided its bytes and before it publishes them.
 */
describe("INV-RESTORE-02 restore keeps every change made after injection", () => {
  let root: string;
  beforeEach(() => { root = makeRestoreHomes("ocx-restore-later-edits-"); });
  afterEach(() => removeTreeWithRetry(root));

  for (const path of ["stop-sync", "stop-async", "start-recovery", "client-recovery", "disconnect-recovery", "reinject-stop"]) {
    test(path + " keeps later Codex edits and removes only OpenCodex routing", () => {
      const { report } = runRestoreChild(root, path);
      expect(report.kept).toEqual(ALL_LATER_EDITS_KEPT);
      expect(report.routing).toEqual(NO_OPENCODEX_ROUTING);
    }, SPAWN_BUDGET_MS);
  }

  for (const path of ["untouched-stop", "untouched-start"]) {
    test(path + " restores an untouched config byte for byte", () => {
      const { report } = runRestoreChild(root, path);
      expect(report.configSha256).toBe(createHash("sha256").update(SEED_CONFIG).digest("hex"));
      expect(report.journal).toBe(false);
    }, SPAWN_BUDGET_MS);
  }

  test("a stale journal left by a field-level stop changes nothing and is cleared at the next start", () => {
    const { report, stderr } = runRestoreChild(root, "stale-journal");
    expect(report.configSha256).toBe(report.beforeSha256 as string);
    expect(report.kept).toEqual(ALL_LATER_EDITS_KEPT);
    expect(report.journal).toBe(false);
    expect(stderr).not.toContain("incomplete");
    expect(stderr).not.toContain("did not shut down cleanly");
  }, SPAWN_BUDGET_MS);
});

describe("INV-RESTORE-02 restore never overwrites a write that lands while it is restoring", () => {
  let root: string;
  beforeEach(() => { root = makeRestoreHomes("ocx-restore-race-"); });
  afterEach(() => removeTreeWithRetry(root));

  for (const scenario of ["race-replay", "race-strip"]) {
    for (const variant of ["in-place", "rename"]) {
      test(scenario + " keeps a concurrent " + variant + " write and refuses instead of publishing", () => {
        const { report } = runRestoreChild(root, scenario, variant);
        expect(report.concurrentKept).toBe(true);
        expect(report.success).toBe(false);
        // The refusal kept the journal, so a retry can still restore.
        expect(report.journal).toBe(true);
      }, SPAWN_BUDGET_MS);
    }
  }

  test("the provider-table retention write refuses when config.toml changed after it was read", () => {
    const { report } = runRestoreChild(root, "race-retain", "in-place");
    expect(report.concurrentKept).toBe(true);
    expect(report.threw).toBe(true);
    expect(readFileSync(join(root, "codex", "config.toml"), "utf8")).not.toContain("[model_providers.opencodex]");
  }, SPAWN_BUDGET_MS);
});
```

### codex-app-rewrite-routing.test.ts

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { codexConfigDrift } from "../../src/codex/config-drift-heal";
import { ALL_LATER_EDITS_KEPT, NO_OPENCODEX_ROUTING, makeRestoreHomes, runRestoreChild } from "../helpers/codex-restore-child";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * The Codex app rewrites config.toml from its own model and can drop or overwrite the keys
 * OpenCodex injected. OpenCodex re-asserts only its own keys, never adopts its own earlier
 * values as the user's, and a later restore never replays stale content.
 */
describe("Codex app rewrites of injected routing keys", () => {
  let root: string;
  beforeEach(() => { root = makeRestoreHomes("ocx-app-rewrite-"); });
  afterEach(() => removeTreeWithRetry(root));

  test("an app rewrite back to an earlier injection's values is re-pointed, never journaled as the user's", () => {
    const { report } = runRestoreChild(root, "app-stale-values");
    expect(report.syncedUrl).toBe("http://127.0.0.1:10200/v1");
    expect(report.snapshotHasLoopback).toBe(false);
    expect(report.routing).toEqual(NO_OPENCODEX_ROUTING);
    expect(report.kept).toEqual(ALL_LATER_EDITS_KEPT);
  }, SPAWN_BUDGET_MS);

  test("an app rewrite that drops the injected keys is re-injected at key level and snapshotted fresh", () => {
    const { report } = runRestoreChild(root, "app-drops-keys");
    expect(report.syncedUrl).toBe("http://127.0.0.1:10100/v1");
    expect(report.snapshotHasLaterEdit).toBe(true);
    expect(report.snapshotHasLoopback).toBe(false);
    expect(report.routing).toEqual(NO_OPENCODEX_ROUTING);
    expect(report.kept).toEqual(ALL_LATER_EDITS_KEPT);
  }, SPAWN_BUDGET_MS);
});

describe("config drift detection", () => {
  const url = "http://127.0.0.1:10100/v1";
  const journal = () => ({ injectedOpenaiBaseUrl: url, injectedRealtimeWsBaseUrl: null, injectedCatalogPath: "/fixture/opencodex-catalog.json" });

  test("a dropped model_catalog_json is drift even while the routing URL survives", () => {
    const drift = codexConfigDrift(journal, "/fixture/config.toml", () => 'openai_base_url = "' + url + '"\n', () => true);
    expect(drift).toEqual({ drifted: true, missingKeys: ["model_catalog_json"] });
  });

  test("the first heal of an app rewrite is reported once, later heals quietly", async () => {
    const heal = await import("../../src/codex/config-drift-heal") as Record<string, unknown>;
    expect(typeof heal.codexConfigHealNotice).toBe("function");
    const notice = heal.codexConfigHealNotice as (missing: readonly string[], firstReport: boolean) => { level: "warn" | "info"; message: string };
    const first = notice(["openai_base_url", "model_catalog_json"], true);
    expect(first.level).toBe("warn");
    expect(first.message).toContain("openai_base_url, model_catalog_json");
    expect(first.message).toContain("other settings were kept");
    expect(notice(["openai_base_url"], false).level).toBe("info");
  });
});
```

