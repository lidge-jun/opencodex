import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

// GHSA-fc5q-39xc-vjpf (picomatch <= 4.0.7 ReDoS) has no patched release. picomatch reaches the
// GUI only through vite's build tooling (vite > tinyglobby > fdir/picomatch), never gui/dist or
// the published package. Remove the exception once a patched picomatch is available.
const ALLOWED_GUI_IGNORES = ["GHSA-fc5q-39xc-vjpf"];

test("the prepublish audit ignores only the reviewed GUI build-tool advisory", () => {
  const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { scripts: Record<string, string> };
  const [root, gui, ...rest] = pkg.scripts["audit:high"]!.split("&&").map(part => part.trim());
  expect(rest).toEqual(["bun audit --audit-level=high" + ALLOWED_GUI_IGNORES.map(id => ` --ignore=${id}`).join("")]);
  expect(root).toBe("bun audit --audit-level=high");
  expect(gui).toBe("cd gui");
  expect(pkg.scripts.prepublishOnly).toContain("bun run audit:high");
});
