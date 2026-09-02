import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const runner = join(repoRoot, "scripts", "ocx-run");

describe("ocx-run", () => {
  test.skipIf(process.platform !== "linux")(
    "runs the command from a requested workdir containing spaces",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-run-"));
      const workdirName = "requested workdir";
      const workdir = join(root, workdirName);
      const cdPath = join(root, "cdpath");
      const stateDir = join(root, "state");
      const name = "workdir";

      try {
        mkdirSync(workdir);
        mkdirSync(join(cdPath, workdirName), { recursive: true });
        const result = Bun.spawnSync(["bash", runner, name, workdirName, "5s", "pwd", "-P"], {
          cwd: root,
          env: { ...process.env, CDPATH: cdPath, OCX_RUN_DIR: stateDir },
          stdout: "pipe",
          stderr: "pipe",
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(join(stateDir, `${name}.log`), "utf8")).toBe(`${realpathSync(workdir)}\n`);
      } finally {
        removeTreeWithRetry(root);
      }
    },
  );
});
