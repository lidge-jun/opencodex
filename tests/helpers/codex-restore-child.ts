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
