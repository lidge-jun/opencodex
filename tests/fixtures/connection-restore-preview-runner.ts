/**
 * Child process for tests/server/connection-status-routes.test.ts: the Codex restore preview
 * oracle. The parent points CODEX_HOME, OPENCODEX_HOME and HOME at fresh temporary directories
 * and this child refuses to start otherwise. Each scenario takes the read-only preview, then runs
 * the real native restore on the same home and prints one JSON line with both key-level diffs.
 * Config values never appear in the output.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const temp = realpathSync.native(tmpdir()) + sep;
for (const name of ["CODEX_HOME", "OPENCODEX_HOME", "HOME"] as const) {
  const value = process.env[name];
  if (!value || !realpathSync.native(value).startsWith(temp)) {
    throw new Error("fixture requires " + name + " under the temporary directory");
  }
}
const home = process.env.CODEX_HOME!;
const { injectCodexConfig, restoreNativeCodexAsync } = await import("../../src/codex/inject");
const { previewCodexNativeRestore, codexConfigKeyChanges } = await import("../../src/codex/restore-preview");
const configPath = join(home, "config.toml");
const profilePath = join(home, "opencodex.config.toml");
const journalPath = join(home, "opencodex-journal.json");
const [scenario = ""] = process.argv.slice(2);

type InjectSettings = Parameters<typeof injectCodexConfig>[1];
async function inject(): Promise<void> {
  const settings = { port: 10100, providers: {}, defaultProvider: "openai", injectionModel: "gpt-5.6-sol", injectionEffort: "high" };
  const result = await injectCodexConfig(10100, settings as unknown as InjectSettings, { catalogPath: null });
  if (!result.success) throw new Error("fixture injection failed: " + result.message);
}
const readOrNull = (path: string): string | null => existsSync(path) ? readFileSync(path, "utf8") : null;

switch (scenario) {
  case "injected": await inject(); break;
  case "edited": {
    await inject();
    const text = readFileSync(configPath, "utf8");
    const firstTable = text.search(/^\[/m);
    writeFileSync(configPath, text.slice(0, firstTable) + 'approval_policy = "never"\n' + text.slice(firstTable));
    break;
  }
  case "native": break;
  case "profile-symlink": {
    writeFileSync(configPath, 'model_provider = "opencodex"\n\n[model_providers.opencodex]\nname = "opencodex"\nbase_url = "http://127.0.0.1:10100/v1"\n');
    const target = join(process.env.HOME!, "profile-target.toml");
    writeFileSync(target, "# not ours\n");
    symlinkSync(target, profilePath);
    break;
  }
  case "external-provider":
    writeFileSync(configPath, 'model_provider = "corp"\n\n[model_providers.corp]\nname = "corp"\nbase_url = "https://gateway.example.test/v1"\n');
    break;
  case "foreign-owner": {
    await inject();
    const other = join(process.env.HOME!, "other-opencodex-home");
    mkdirSync(other, { recursive: true });
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    writeFileSync(journalPath, JSON.stringify({ ...journal, opencodexHome: other }));
    break;
  }
  default: throw new Error("unknown scenario " + scenario);
}

const beforeConfig = readOrNull(configPath);
const beforeProfile = readOrNull(profilePath);
const beforeJournal = readOrNull(journalPath);
const preview = previewCodexNativeRestore({ historyDisposition: () => ({ kind: "proceed" }) });
const untouched = readOrNull(configPath) === beforeConfig && readOrNull(profilePath) === beforeProfile
  && readOrNull(journalPath) === beforeJournal;
const restored = await restoreNativeCodexAsync();
const afterConfig = readOrNull(configPath);
const afterProfile = readOrNull(profilePath);
const actual = [
  ...codexConfigKeyChanges(beforeConfig, afterConfig),
  ...(beforeProfile === afterProfile ? [] : [{
    file: "opencodex.config.toml", key: "*",
    change: beforeProfile === null ? "add" : afterProfile === null ? "remove" : "update",
  }]),
];
console.log(JSON.stringify({ preview, actual, success: restored.success, untouched }));
