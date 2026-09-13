import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

// Bridge support floor, not a claim about every historical vendor release.
// Verify the complete official workspace/readState protocol at this floor as well.
export const DESKTOP_NODE_MIN_MAJOR = 24;
const checks = new Map<string, boolean>();
const script = `
try {
  if (process.release.name !== 'node' || process.versions.bun ||
      Number(process.versions.node.split('.')[0]) < ${DESKTOP_NODE_MIN_MAJOR} ||
      typeof Object.hasOwn !== 'function' || typeof fetch !== 'function') process.exit(1);
  const db = new (require('node:sqlite').DatabaseSync)(':memory:');
  if (db.prepare('SELECT 1 AS value').get().value !== 1) process.exit(1);
  db.close();
  process.stdout.write('compatible');
} catch { process.exit(1); }
`;

/** Check each absolute PATH entry, rather than trusting the first node or Bun's launcher. */
export function resolveDesktopNode(path = process.env.PATH ?? ""): string {
  let found = false;
  const seen = new Set<string>();
  const deadline = Date.now() + 3_000;
  for (const directory of [...new Set(path.split(delimiter))].filter(isAbsolute).slice(0, 64)) {
    let node: string;
    let key: string;
    try {
      node = realpathSync(join(directory, "node"));
      if (seen.has(node)) continue;
      seen.add(node);
      accessSync(node, constants.X_OK);
      const st = statSync(node);
      if (!st.isFile()) continue;
      found = true;
      key = JSON.stringify([node, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs]);
    } catch { continue; }
    let compatible = checks.get(key);
    if (compatible === undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // No inherited NODE_OPTIONS, preload hooks, credentials or vendor stderr.
      const result = spawnSync(node, ["--no-warnings", "-e", script], {
        env: { PATH: "/usr/bin:/bin" }, cwd: "/", encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"], timeout: Math.min(1_000, remaining),
        killSignal: "SIGKILL", maxBuffer: 128,
      });
      compatible = !result.error && result.status === 0 && result.stdout === "compatible";
      if (checks.size >= 64) checks.clear();
      checks.set(key, compatible);
    }
    if (compatible) return node;
  }
  throw new Error(found ? "node_incompatible" : "node_missing");
}
