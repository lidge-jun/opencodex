import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePackageModes } from "../scripts/prepare-package";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default. Same remedy as
// codex-history-provider / cursor-mcp-stdio.
setDefaultTimeout(30_000);

const root = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(root);

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function removeModeFixture(path: string): void {
  try { chmodSync(path, 0o700); } catch { /* best-effort cleanup */ }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("install scripts", () => {
  test("npm package main is a Node-safe wrapper while Bun keeps the TypeScript API", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      main?: string;
      exports?: { "."?: { bun?: string; default?: string } };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.main).toBe("./bin/package-main.mjs");
    expect(pkg.exports?.["."]?.bun).toBe("./src/index.ts");
    expect(pkg.exports?.["."]?.default).toBe("./bin/package-main.mjs");
    expect(pkg.dependencies?.zod).toBe("4.4.3");
    expect(pkg.devDependencies?.typescript).toBe("7.0.2");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.4.0");
    expect(pkg.scripts?.dev).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:proxy"]).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:gui"]).toBe("cd gui && bun run dev");
    expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
    expect(pkg.scripts?.prepack).toBe("bun run prepare:package");
    expect(pkg.files).toContain("assets/banner.png");
    expect(pkg.files).toContain("assets/architecture.png");
    expect(pkg.files).toContain("assets/claude-code-models.gif");
    expect(pkg.files).toContain("assets/codex-app-picker.png");
  });

  test("Node can import the package main without executing the CLI", () => {
    const result = spawnSync("node", [
      "-e",
      "import('./bin/package-main.mjs').then(m => { if (m.cliCommand !== 'ocx') process.exit(2); })",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  test("npmignore keeps GUI development docs out of the package", async () => {
    const npmignore = await readText(".npmignore");
    const guiNpmignore = await readText("gui/.npmignore");
    const guiReadme = await readText("gui/README.md");

    expect(npmignore).toContain("gui/README.md");
    expect(guiNpmignore).toContain("README.md");
    expect(guiReadme).toContain("opencodex dashboard");
    expect(guiReadme).toContain("bun run dev:proxy");
    expect(guiReadme).toContain("bun run dev:gui");
    expect(guiReadme).not.toContain("This template provides a minimal setup");
  });

  test("POSIX installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.sh");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("npm install -g @bitkyc08/opencodex");
    expect(script).toContain("command -v ocx");
    expect(script).toContain("ocx help");
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install");
  });

  test("PowerShell installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("& $npm.Source install -g @bitkyc08/opencodex");
    expect(script).toContain("$LASTEXITCODE");
    expect(script).toContain("Get-Command ocx.cmd");
    expect(script).toContain("Get-Command ocx");
    expect(script).toContain("& $ocx.Source help");
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install.ps1");
  });

  test("Node launcher handles npm self-update before starting Bun", async () => {
    const launcher = await readText("bin/ocx.mjs");

    expect(launcher).toContain('process.argv[2] === "update"');
    expect(launcher).toContain('["install", "-g", `${PKG}@${tag}`]');
    expect(launcher).toContain('return String(currentVersion).includes("-preview.") ? "preview" : "latest"');
    expect(launcher).toContain("!isBunGlobalInstall()");
    expect(launcher).toContain("repairCodexShimIfNeeded()");
    expect(launcher).toContain("runNpmSelfUpdate()");
  });

  test("release helper watches the workflow run it just dispatched", async () => {
    const script = await readText("scripts/release.ts");

    expect(script).toContain("waitForReleaseWorkflowRun");
    // The invariant is that the dispatched run is located by workflow, branch
    // and commit — not that the call is a shell string. Every external command
    // now goes through the shared launcher as an argv array, because Bun.$
    // resolved PATH itself and walked past the Windows `.cmd` test shims.
    expect(script).toContain('"gh", "run", "list", "--workflow", "release.yml", "--branch"');
    expect(script).toContain('"--commit"');
    expect(script).toContain("createdAt,databaseId,headSha,status,url");
    expect(script).toContain("await watchRun(releaseRun.databaseId)");
  });

  test.skipIf(process.platform === "win32")(
    "package mode normalization skips direct and nested filesystem links",
    () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-package-modes-"));
      const packageRoot = join(fixtureRoot, "package");
      const externalRoot = join(fixtureRoot, "external");
      const externalLauncher = join(externalRoot, "package-main.mjs");
      const externalDirectory = join(externalRoot, "dashboard");
      const externalAsset = join(externalDirectory, "asset.js");

      try {
        mkdirSync(join(packageRoot, "bin"), { recursive: true });
        mkdirSync(join(packageRoot, "gui", "dist", "nested"), { recursive: true });
        mkdirSync(externalDirectory, { recursive: true });

        writeFileSync(join(packageRoot, "bin", "ocx.mjs"), "launcher");
        writeFileSync(join(packageRoot, "gui", "dist", "asset.js"), "asset");
        writeFileSync(join(packageRoot, "gui", "dist", "nested", "chunk.js"), "chunk");
        writeFileSync(externalLauncher, "external launcher");
        writeFileSync(externalAsset, "external asset");

        chmodSync(join(packageRoot, "bin", "ocx.mjs"), 0o600);
        chmodSync(join(packageRoot, "gui", "dist"), 0o700);
        chmodSync(join(packageRoot, "gui", "dist", "asset.js"), 0o600);
        chmodSync(join(packageRoot, "gui", "dist", "nested"), 0o700);
        chmodSync(join(packageRoot, "gui", "dist", "nested", "chunk.js"), 0o600);
        chmodSync(externalLauncher, 0o600);
        chmodSync(externalDirectory, 0o700);
        chmodSync(externalAsset, 0o600);

        const launcherLink = join(packageRoot, "bin", "package-main.mjs");
        const nestedDirectoryLink = join(packageRoot, "gui", "dist", "nested", "external");
        symlinkSync(externalLauncher, launcherLink, "file");
        symlinkSync(externalDirectory, nestedDirectoryLink, "dir");

        normalizePackageModes(packageRoot);

        expect(lstatSync(launcherLink).isSymbolicLink()).toBeTrue();
        expect(lstatSync(nestedDirectoryLink).isSymbolicLink()).toBeTrue();
        expect(mode(externalLauncher)).toBe(0o600);
        expect(mode(externalDirectory)).toBe(0o700);
        expect(mode(externalAsset)).toBe(0o600);
        expect(mode(join(packageRoot, "bin", "ocx.mjs"))).toBe(0o755);
        expect(mode(join(packageRoot, "gui", "dist"))).toBe(0o755);
        expect(mode(join(packageRoot, "gui", "dist", "asset.js"))).toBe(0o644);
        expect(mode(join(packageRoot, "gui", "dist", "nested"))).toBe(0o755);
        expect(mode(join(packageRoot, "gui", "dist", "nested", "chunk.js"))).toBe(0o644);
      } finally {
        try { chmodSync(externalLauncher, 0o600); } catch { /* best-effort cleanup */ }
        try { chmodSync(externalDirectory, 0o700); } catch { /* best-effort cleanup */ }
        try { chmodSync(externalAsset, 0o600); } catch { /* best-effort cleanup */ }
        removeModeFixture(fixtureRoot);
      }
    },
  );

  test("package mode normalization does not traverse a linked output root", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-package-root-link-"));
    const packageRoot = join(fixtureRoot, "package");
    const externalOutput = join(fixtureRoot, "external-output");
    const externalAsset = join(externalOutput, "asset.js");

    try {
      mkdirSync(join(packageRoot, "gui"), { recursive: true });
      mkdirSync(externalOutput, { recursive: true });
      writeFileSync(externalAsset, "external asset");
      chmodSync(externalOutput, 0o555);
      chmodSync(externalAsset, 0o444);

      const outputLink = join(packageRoot, "gui", "dist");
      symlinkSync(externalOutput, outputLink, process.platform === "win32" ? "junction" : "dir");
      const directoryModeBefore = mode(externalOutput);
      const assetModeBefore = mode(externalAsset);

      normalizePackageModes(packageRoot);

      expect(lstatSync(outputLink).isSymbolicLink()).toBeTrue();
      expect(mode(externalOutput)).toBe(directoryModeBefore);
      expect(mode(externalAsset)).toBe(assetModeBefore);
    } finally {
      try { chmodSync(externalAsset, 0o600); } catch { /* best-effort cleanup */ }
      try { chmodSync(externalOutput, 0o700); } catch { /* best-effort cleanup */ }
      removeModeFixture(fixtureRoot);
    }
  });
});
