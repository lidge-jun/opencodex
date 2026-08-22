import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./remove-tree";

export interface IsolatedCodexHome {
  path: string;
  restore(): void;
}

export function installIsolatedCodexHome(prefix = "ocx-codex-home-"): IsolatedCodexHome {
  const previousCodexHome = process.env.CODEX_HOME;
  const path = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(path, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n', "utf8");
  process.env.CODEX_HOME = path;

  return {
    path,
    restore() {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      // The env restore above is the part other tests depend on; the directory is
      // disposable. On Windows a proxy or child that is still shutting down can hold
      // a file in this tree open past the retry budget, and rethrowing there failed a
      // test that had already finished asserting -- it read as a defect in whatever
      // ran here rather than as an OS release race. Leave the temp directory to the
      // OS instead; a stale directory under TEMP costs nothing, a false red costs a
      // real signal.
      try {
        removeTreeWithRetry(path);
      } catch {
        // Deliberately swallowed: see above.
      }
    },
  };
}
