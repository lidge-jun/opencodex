import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as proxyLiveness from "../../src/server/proxy-liveness";
import * as bunRuntime from "../../src/lib/bun-runtime";
import * as installDetection from "../../src/update/install-detection.mjs";
import { getDefaultConfig } from "../../src/config";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/cli/doctor";
import { collectBundledBunDiagnostic, formatBundledBunDiagnosticLines } from "../../src/cli/bundled-bun-diagnostic";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { STORE_BUDGET_MS } from "../helpers/test-budget";

/**
 * Issue #8361: npm 12 blocks lifecycle scripts by default, so `npm install -g` leaves the
 * bundled `bun` dependency as its un-downloaded placeholder. The launcher then reports
 * "the `bun` dependency is not installed" and only a reinstall that permits bun's own
 * postinstall repairs it. Doctor must name that state and the exact command.
 *
 * The bundled runtime and package-manager detection are faked at their module seams so the
 * case exercises `runDoctor`'s real call site rather than a helper in isolation.
 */
describe("doctor bundled Bun install guidance (#8361)", () => {
  let home: string;
  let codexHome: string;
  let previousHome: string | undefined;
  let previousCodexHome: string | undefined;
  let previousExitCode: typeof process.exitCode;
  let logged: string[];
  const restore: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-doctor-bun-install-"));
    codexHome = join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    previousHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    previousExitCode = process.exitCode;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = codexHome;
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...getDefaultConfig(), port: 9, codexAutoStart: false }));
    logged = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    restore.push(() => log.mockRestore());
    // Doctor's other sections probe upstream health; this fixture must stay offline.
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 503 }));
    restore.push(() => fetch.mockRestore());
    const live = spyOn(proxyLiveness, "findLiveProxy").mockResolvedValue({ pid: null, port: 9, hostname: "127.0.0.1", source: "config" });
    restore.push(() => live.mockRestore());
  });

  afterEach(() => {
    for (const cleanup of restore.splice(0).reverse()) cleanup();
    process.exitCode = previousExitCode;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(home)) removeTreeWithRetry(home);
  });

  test("an npm install whose Bun postinstall was skipped prints the exact repair command", async () => {
    // A skipped postinstall leaves no real binary (bundledBunPath returns null for the
    // placeholder stub). The package layout still identifies npm as the owner.
    const bundled = spyOn(bunRuntime, "bundledBunPath").mockReturnValue(null);
    restore.push(() => bundled.mockRestore());
    const detection = spyOn(installDetection, "detectInstallOwnershipFromPath")
      .mockReturnValue({ installer: "npm" });
    restore.push(() => detection.mockRestore());

    await runDoctor([]);
    const report = logged.join("\n");

    expect(report).toContain("the `bun` dependency is not installed");
    expect(report).toContain("npm install -g --allow-scripts=bun @bitkyc08/opencodex");
  }, STORE_BUDGET_MS);

  test("a ready bundled runtime does not suggest reinstalling", async () => {
    const bundled = spyOn(bunRuntime, "bundledBunPath").mockReturnValue("/opt/ocx/node_modules/bun/bin/bun");
    restore.push(() => bundled.mockRestore());

    await runDoctor([]);
    const report = logged.join("\n");

    expect(report).toContain("Bundled Bun runtime");
    expect(report).not.toContain("the `bun` dependency is not installed");
    expect(report).not.toContain("npm install -g --allow-scripts=bun");
  }, STORE_BUDGET_MS);

  test("a source checkout prints no empty Bundled Bun runtime heading", async () => {
    const bundled = spyOn(bunRuntime, "bundledBunPath").mockReturnValue(null);
    restore.push(() => bundled.mockRestore());
    const detection = spyOn(installDetection, "detectInstallOwnershipFromPath")
      .mockReturnValue({ installer: "source" });
    restore.push(() => detection.mockRestore());

    await runDoctor([]);

    expect(logged.join("\n")).not.toContain("Bundled Bun runtime");
  }, STORE_BUDGET_MS);

  test("a Windows npm install stops the proxy before reinstalling, since a live bun.exe holds bin", () => {
    // Windows fails the manual reinstall with EBUSY while the service's bun.exe is running.
    // `ocx update` handles this itself; the printed instruction has to match what it does.
    const diagnostic = collectBundledBunDiagnostic({
      platform: "win32",
      bundledPath: () => null,
      detectOwnership: () => ({ installer: "npm" }),
    });
    const lines = formatBundledBunDiagnosticLines(diagnostic).join("\n");

    expect(lines).toContain("the `bun` dependency is not installed");
    expect(lines.indexOf("ocx stop")).toBeLessThan(lines.indexOf("npm install -g --allow-scripts=bun"));
    expect(lines).toContain("npm install -g --allow-scripts=bun @bitkyc08/opencodex");
    expect(lines).toContain("ocx service restart");
  });
});
