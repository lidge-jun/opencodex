import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A Windows home for Remote Link census tests (#8359): a Desktop ocx.exe that is really this bun.exe (so it reports
 * Bun's version, never an OpenCodex one), and an npm-style CLI entry this bun.exe runs as the served [bun.exe, entry]
 * pair. The entry answers --version with `version` and otherwise prints its arguments and stdin as JSON.
 * `track` receives the temporary root so the caller's cleanup owns it.
 */
export function windowsServedHome(track: (root: string) => void, version = "2.99.0") {
  const home = mkdtempSync(join(tmpdir(), "ocx-windows-served-"));
  track(home);
  const desktop = join(home, ".opencodex-desktop", "bin", "ocx.exe");
  mkdirSync(dirname(desktop), { recursive: true });
  copyFileSync(process.execPath, desktop);
  const entry = join(home, "npm prefix", "node_modules", "opencodex", "src", "cli", "index.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, [
    `if (process.argv[2] === "--version") { console.log("opencodex ${version}"); process.exit(0); }`,
    "console.log(JSON.stringify({ served: true, args: process.argv.slice(2), input: await Bun.stdin.text() }));",
  ].join("\n"));
  const ocxHome = join(home, ".opencodex");
  mkdirSync(ocxHome, { recursive: true });
  const census = (body: unknown) => writeFileSync(join(ocxHome, "serving-runtimes.json"), JSON.stringify(body, null, 2) + "\n");
  const run = async (argv: string[], env: Record<string, string | undefined> = { USERPROFILE: home, HOME: home, OPENCODEX_HOME: ocxHome }) => {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
    const child = Bun.spawn(argv, {
      env: childEnv,
      stdin: new Blob(["fixture-key-stdin"]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  return { home, entry, ocxHome, census, run };
}
