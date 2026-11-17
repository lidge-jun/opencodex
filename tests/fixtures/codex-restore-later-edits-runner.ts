/**
 * Child process for tests/codex-integration/codex-restore-later-edits.test.ts and
 * tests/codex-integration/codex-app-rewrite-routing.test.ts. The parent points CODEX_HOME,
 * OPENCODEX_HOME and HOME at fresh temporary directories, and this child refuses to start otherwise.
 * It prints one JSON line describing what survived, never config values.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// Refuse before any src module computes a home path: all three homes must sit under the temp dir.
const temp = realpathSync.native(tmpdir()) + sep;
for (const name of ["CODEX_HOME", "OPENCODEX_HOME", "HOME"] as const) {
  const value = process.env[name];
  if (!value || !realpathSync.native(value).startsWith(temp)) {
    throw new Error("fixture requires " + name + " under the temporary directory");
  }
}
const home = process.env.CODEX_HOME!;
const { injectCodexConfig, restoreNativeCodex, restoreNativeCodexAsync } = await import("../../src/codex/inject");
const { setBeforeCodexConfigPublishForTests } = await import("../../src/codex/inject/config-write-section");
const { retainOcxProviderTableOnDisk } = await import("../../src/codex/inject/remove");
const { reconcileJournal, restoreJournalState } = await import("../../src/codex/journal");
const configPath = join(home, "config.toml");
const journalPath = join(home, "opencodex-journal.json");
const [scenario = "", variant = ""] = process.argv.slice(2);
const ACTIVE_CLIENT = "fixture-active-client";
const DEAD_PID = 2_147_480_000;

const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => {
  if (pid === DEAD_PID) throw Object.assign(new Error("fixture owner exited"), { code: "ESRCH" });
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
