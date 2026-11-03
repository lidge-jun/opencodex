import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperPath } from "./repo-root";
import { removeTreeWithRetry } from "./remove-tree";

type SeedMode = "write" | "unknown-write";
type SeedOutput = { account: string; [key: string]: unknown };
const templates = new Map<SeedMode, { home: string; output: SeedOutput }>();

/** Seed once per mode, after the worker releases its lease and exits. */
export function seededAffinityTemplate(mode: SeedMode): string {
  const cached = templates.get(mode);
  if (cached) return cached.home;
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-template-"));
  try {
    const result = Bun.spawnSync([process.execPath, helperPath("codex-affinity-restart-worker.ts"), mode], {
      env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`Affinity seed ${mode} failed: ${result.stderr.toString()}`);
    const output = JSON.parse(result.stdout.toString()) as SeedOutput;
    if (mode === "write" && output.account !== "a") throw new Error("Affinity seed did not select account a");
    for (const database of ["codex-affinity.sqlite", "spend-ledger-owner.sqlite"]) {
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        if (existsSync(join(home, database + suffix))) throw new Error(`Affinity seed left ${database + suffix}`);
      }
    }
    templates.set(mode, { home, output });
    return home;
  } catch (error) {
    removeTreeWithRetry(home);
    throw error;
  }
}

/** Ownership loading rejects a copied manifest whose root still names the template home. */
export function copySeededAffinityHome(mode: SeedMode, destination: string): SeedOutput {
  cpSync(seededAffinityTemplate(mode), destination, { recursive: true });
  for (const name of [".opencodex-owner.json", ".opencodex-uninstall.json"]) {
    const path = join(destination, name);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.root = realpathSync.native(destination);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return templates.get(mode)!.output;
}

export function removeSeededAffinityTemplates(): void {
  for (const { home } of templates.values()) removeTreeWithRetry(home);
  templates.clear();
}
