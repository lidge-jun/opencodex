import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { updateCommand, updateCommandStr } from "../../src/update/index";
import { repoPath } from "../helpers/repo-root";

/**
 * Issue #8361: npm 12 blocks dependency lifecycle scripts by default, so an `ocx update` that
 * ran a bare `npm install -g` removed the old files and installed a package whose bundled `bun`
 * dependency never unpacked. The next `ocx` then failed with "the `bun` dependency is not
 * installed". Every path that builds an npm install argument must approve exactly that one script.
 *
 * The flag is not conditional on the npm major: npm 8 through 11 all install with it on a global
 * install (some npm 11 releases warn that it is unknown to the CLI config, then install).
 * A version gate would add a failure mode that depends on which npm happened to be first on PATH.
 */
describe("npm update allows bun's postinstall (#8361)", () => {
  test("the update command passes --allow-scripts=bun before the package spec", () => {
    expect(updateCommand("npm", "latest", "2.7.24")).toEqual({
      bin: "npm",
      args: ["install", "-g", "--allow-scripts=bun", "@bitkyc08/opencodex@2.7.24"],
    });
    // The tag fallback (registry resolution unavailable) keeps the same approval.
    expect(updateCommand("npm", "preview", null).args).toEqual([
      "install", "-g", "--allow-scripts=bun", "@bitkyc08/opencodex@preview",
    ]);
    expect(updateCommandStr("npm", "latest", "2.7.24"))
      .toBe("npm install -g --allow-scripts=bun @bitkyc08/opencodex@2.7.24");
  });

  test("the other managers keep their own build approval instead of npm's flag", () => {
    expect(updateCommand("pnpm", "latest", "2.7.24").args).toEqual([
      "add", "-g", "--allow-build=bun", "@bitkyc08/opencodex@2.7.24",
    ]);
    expect(updateCommand("bun", "latest", "2.7.24").args).toEqual([
      "add", "-g", "@bitkyc08/opencodex@2.7.24",
    ]);
  });

  test("the Node launcher's own npm reinstall carries the same approval", () => {
    // The launcher is plain Node and runs before this module loads, so it repeats the argv.
    // Source-pinned because loading it executes the CLI.
    const launcher = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");
    expect(launcher).toContain('["install", "-g", "--allow-scripts=bun", `${PKG}@${selector}`]');
    // The manual-update failure hint and the fatal runtime message name the same command.
    expect(launcher).toContain('"npm install -g --allow-scripts=bun @bitkyc08/opencodex"');
    expect(launcher).toContain('["install", "-g", "--allow-scripts=bun", `${PKG}@${latest || tag}`]');
  });
});
