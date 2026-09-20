/**
 * #5261: a browser that never opened must not look like a login that is working.
 *
 * The launcher used to swallow its own failure and return nothing, so the Codex login route
 * reported the same success whether a browser opened, failed to open, or was deliberately
 * skipped. The user then waited at a terminal showing a URL nobody had opened.
 *
 * Nothing here opens a real browser. The started case is deliberately untested rather than
 * faked: the launcher command is fixed per platform, so proving it would mean actually
 * launching one on the machine running the suite.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
    try {
      process.env.PATH = mkdtempSync(`${tmpdir()}/ocx-empty-path-`);
      expect(await openUrl("http://127.0.0.1:1455/auth/callback")).toEqual({
        status: "failed",
        reason: "spawn-error",
      });
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
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
