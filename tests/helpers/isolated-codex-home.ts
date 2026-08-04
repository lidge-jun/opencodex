import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      // Windows can retain short-lived file or ACL handles after a test stops.
      // node:fs bounds retries for EBUSY, EPERM, and ENOTEMPTY when recursive.
      if (process.platform === "win32") {
        rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
      } else {
        rmSync(path, { recursive: true, force: true });
      }
    },
  };
}
