/**
 * #5261: a browser that never opened must not look like a login that is working.
 *
 * The launcher used to swallow its own failure and return nothing, which is what left the Codex
 * login route unable to tell a browser that opened from one that never did. These cover the
 * launcher itself and the recovery line it feeds; the route and the CLI block that consume the
 * result are covered where those live.
 *
 * Nothing here opens a real browser. The started case is deliberately untested rather than
 * faked: the launcher command is fixed per platform, so proving it would mean actually
 * launching one on the machine running the suite.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { tmpdir } from "node:os";
import { openUrl } from "../../src/lib/open-url";
import { BROWSER_LAUNCH_FAILED_HINT } from "../../src/cli/account-auth";

describe("browser launch is reported, not swallowed (#5261)", () => {
  test("a URL we will not hand to a launcher is reported as such", async () => {
    // Refusing a non-http scheme is the one failure that never reaches spawn, so it is also
    // the one that must not silently look like a launch.
    for (const url of ["", "not-a-url", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(await openUrl(url)).toEqual({ status: "failed", reason: "invalid-url" });
    }
  });

  test.skipIf(process.platform !== "linux")("a launcher that cannot be resolved reports a failure", async () => {
    // Linux only, and on purpose: this empties PATH so the launcher cannot be found, and on a
    // developer machine with a real browser any weaker setup risks actually opening one.
    const priorPath = process.env.PATH;
    let emptyDir: string | undefined;
    try {
      emptyDir = mkdtempSync(`${tmpdir()}/ocx-empty-path-`);
      process.env.PATH = emptyDir;
      expect(await openUrl("http://127.0.0.1:1455/auth/callback")).toEqual({
        status: "failed",
        reason: "spawn-error",
      });
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      if (emptyDir) removeTreeWithRetry(emptyDir);
    }
  });

  test("the CLI hint names the manual route and the reason the port cannot move", () => {
    // ChatGPT supplies the redirect URI, so the callback cannot move to a free port. That is
    // the part a user cannot work out alone, which is why the hint names it and --device.
    expect(BROWSER_LAUNCH_FAILED_HINT).toContain("1455");
    expect(BROWSER_LAUNCH_FAILED_HINT).toContain("--device");
    expect(BROWSER_LAUNCH_FAILED_HINT.toLowerCase()).toContain("open the url");
  });
});
