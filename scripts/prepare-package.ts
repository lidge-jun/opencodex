import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REMOTE_AGENT_PUBLIC_KEY_PEM,
  REMOTE_AGENT_SPECS,
  verifyRemoteAgentBundle,
} from "../src/remote/agent-bundle";

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

function packageVersion(): string {
  const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || value.version.length === 0) throw new Error("package.json version is unavailable");
  return value.version;
}

function verificationPublicKey(): string {
  const path = process.env.OPENCODEX_REMOTE_AGENT_DRY_RUN_PUBLIC_KEY_FILE?.trim();
  if (!path) return REMOTE_AGENT_PUBLIC_KEY_PEM;
  if (process.env.OPENCODEX_RELEASE_DRY_RUN !== "true") {
    throw new Error("Remote Agent public-key overrides are allowed only for release dry-runs");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024) {
    throw new Error("Remote Agent dry-run public key must be a bounded regular file");
  }
  return readFileSync(path, "utf8");
}

chmodIfExists(join(root, "bin", "ocx.mjs"), 0o755);
chmodIfExists(join(root, "bin", "package-main.mjs"), 0o644);
chmodTree(join(root, "gui", "dist"));

const remoteAgentRoot = join(root, "bin", "remote-agent");
if (existsSync(remoteAgentRoot)) {
  verifyRemoteAgentBundle(remoteAgentRoot, verificationPublicKey(), packageVersion());
  for (const spec of REMOTE_AGENT_SPECS) {
    chmodIfExists(
      join(remoteAgentRoot, spec.package, spec.executable),
      spec.package.startsWith("windows-") ? 0o644 : 0o755,
    );
  }
} else if (process.env.OPENCODEX_REQUIRE_REMOTE_AGENT_BUNDLE === "1") {
  throw new Error("A complete signed Remote Agent bundle is required for release packaging");
}
