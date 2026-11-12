/**
 * Import FIRST in a test file whose code writes Codex paths (raw fs calls, or source that writes
 * the import-time paths of src/codex/paths). Module evaluation follows import order.
 *
 * Unconditional, and decided by paths, never by an inherited flag:
 * - If src/codex/paths has not been evaluated yet (no preload ran), CODEX_HOME is pointed at a temp
 *   directory this module creates in this process; only that directory is removed at exit.
 * - If it has (this repository's preload loads it), its CODEX_HOME was fixed by the preload.
 * Either way the test file then calls {@link assertCodexHomeOwned} with the Codex home its paths
 * actually resolved to, and refuses to load unless that directory is the one created here, or the
 * `.codex` of a test root whose owner marker (scripts/test-temp.ts) names this very process.
 * Imports nothing from src/ on purpose.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const OWNER_FILE = ".opencodex-test-owner.json";

function pathsModuleLoaded(): boolean {
  return Object.keys(require.cache).some(key => key.replaceAll("\\", "/").endsWith("/src/codex/paths.ts"));
}

let created: string | null = null;
if (!pathsModuleLoaded()) {
  created = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-test-codex-home-")));
  process.env.CODEX_HOME = created;
  const owned = created;
  process.on("exit", () => { rmSync(owned, { recursive: true, force: true }); });
}

/** Whether `dir` is the `.codex` of a test root whose owner marker names this process. */
function ownedTestRootCodexHome(dir: string): boolean {
  if (basename(dir) !== ".codex") return false;
  const root = dirname(dir);
  const marker = join(root, OWNER_FILE);
  try {
    if (!existsSync(marker) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) return false;
    const owner = JSON.parse(readFileSync(marker, "utf8")) as { kind?: unknown; root?: unknown; pid?: unknown };
    return owner.kind === "opencodex-test-root" && owner.pid === process.pid
      && typeof owner.root === "string" && realpathSync.native(owner.root) === root;
  } catch {
    return false;
  }
}

/** Throw unless `codexHome` is a Codex home this process owns (see the module comment). */
export function assertCodexHomeOwned(codexHome: string): void {
  let resolved: string;
  try { resolved = realpathSync.native(codexHome); } catch { resolved = codexHome; }
  if (created !== null && resolved === created) return;
  if (ownedTestRootCodexHome(resolved)) return;
  throw new Error(`refusing to run: the Codex home ${resolved} is not a temp directory this test process owns. Import tests/helpers/codex-home-sandbox.ts before anything that loads src/codex/paths.`);
}

/** The directory this module created, or null when the preload had already fixed the paths. */
export function createdCodexHomeForTests(): string | null {
  return created;
}
