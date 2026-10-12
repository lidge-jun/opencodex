import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { codexHomeIsAbsent } from "./codex-home-owner";

/**
 * Create a proven-missing home before a writer that has always created it.
 * A failed request keeps the directory: a pathname-based removal cannot prove it
 * still names the directory this request created, so deleting it could remove a
 * concurrent replacement. An empty home is what Codex itself would create.
 */
export function prepareCodexHome(home: string, mode?: number): void {
  if (!codexHomeIsAbsent(home)) return;
  mkdirSync(dirname(home), { recursive: true, mode });
  try { mkdirSync(home, { mode }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
