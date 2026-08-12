import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCompatibilityVersionManifest } from "./generate-compatibility-version";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function chmodIfExists(path: string, mode: number): void {
  if (!existsSync(path)) return;
  try { chmodSync(path, mode); } catch { /* best-effort for read-only filesystems */ }
}

function chmodTree(path: string): void {
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (st.isDirectory()) {
    chmodIfExists(path, 0o755);
    for (const entry of readdirSync(path)) chmodTree(join(path, entry));
    return;
  }
  chmodIfExists(path, 0o644);
}

// Generate the exact CL-00 implementation manifest immediately before package
// assembly. The output stays untracked to avoid a self-referential digest, but
// package.json already ships src/** so the generated artifact is embedded.
generateCompatibilityVersionManifest(root);

chmodIfExists(join(root, "bin", "ocx.mjs"), 0o755);
chmodIfExists(join(root, "bin", "package-main.mjs"), 0o644);
chmodTree(join(root, "gui", "dist"));
