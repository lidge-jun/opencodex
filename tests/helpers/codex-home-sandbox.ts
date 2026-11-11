/**
 * Import FIRST in a test file that writes Codex paths directly (raw fs calls the write guard cannot
 * see). Module evaluation follows import order, so this runs before src/codex/paths fixes its paths
 * from CODEX_HOME.
 *
 * Under this repository's preload the sandbox already holds (OCX_TEST_HOME_GUARD=1) and this does
 * nothing. A run started outside the repository loads no preload; there it points CODEX_HOME at a
 * temp directory this module creates and owns, and removes only that directory when the process
 * exits. Imports nothing from src/ on purpose.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.OCX_TEST_HOME_GUARD !== "1") {
  const owned = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-test-codex-home-")));
  process.env.CODEX_HOME = owned;
  process.on("exit", () => { rmSync(owned, { recursive: true, force: true }); });
}
