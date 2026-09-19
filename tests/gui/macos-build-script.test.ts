import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoPath, repoRoot as findRepoRoot } from "../helpers/repo-root";

// The macOS build script deletes whatever sits at its destination, so its containment
// check is a safety boundary rather than a convenience. These run the real script.
//
// Every case here shipped as a defect at some point:
//   - the original check compared two values derived from the same variable, so any
//     OUTPUT_DIR passed;
//   - resolving logical paths let a repository-local symlink point outside;
//   - re-appending an unresolved tail let `.nope/../../outside` escape entirely;
//   - resolving physically BEFORE normalising let `..` reveal a symlink that was then
//     never followed.

const repoRoot = findRepoRoot();
const script = repoPath("scripts", "build-macos-app.sh");
const isMacOS = process.platform === "darwin";

const scriptText = await Bun.file(script).text();

async function runScript(outputDir: string, cwd: string = repoRoot) {
  const proc = Bun.spawn(["bash", script], {
    cwd,
    env: { ...process.env, OUTPUT_DIR: outputDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr, exitCode };
}

/// Runs `body` with a uniquely named sandbox that this test owns and always removes.
///
/// An earlier version deleted FIXED paths such as `<repo-parent>/ocx-escaped-probe`,
/// which would have destroyed unrelated data if anything already lived there. A test
/// for a safety boundary must not itself be destructive.
async function withSandbox<T>(body: (sandbox: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "ocx-containment-"));
  try {
    return await body(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe.skipIf(!isMacOS)("macOS build script containment", () => {
  test("refuses a destination outside the repository and creates nothing", async () => {
    // Deliberately NOT derived from process.env.HOME: other suites replace HOME with a
    // temp directory, and temp is a permitted root — so this test built successfully and
    // failed during a full-suite run. A sibling of the repository is stable and is
    // outside every permitted root.
    const target = resolve(repoRoot, "..", `.ocx-outside-${process.pid}-${Date.now()}`);

    const { stderr, exitCode } = await runScript(target);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to build");
    expect(existsSync(target)).toBe(false);
  }, 120_000);

  test("refuses an unresolved .. traversal before creating any directory", async () => {
    const intermediate = join(repoRoot, `.ocx-traversal-${process.pid}`);
    const escapedName = `.ocx-escaped-${process.pid}-${Date.now()}`;
    const escaped = resolve(repoRoot, "..", escapedName);

    // String concatenation, NOT path.join: join() normalises `..` itself, so the script
    // would never receive the traversal that was the actual bypass. Written with join()
    // this test passed against the broken resolver.
    const traversal = `${intermediate}/../../${escapedName}`;

    const { stderr, exitCode } = await runScript(traversal);

    expect(exitCode).not.toBe(0);
    // The message names the RESOLVED path, which is the proof normalisation happened.
    expect(stderr).toContain(escapedName);
    expect(stderr).toContain("Refusing to build into");
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(intermediate)).toBe(false);
  }, 120_000);

  test("follows a symlink revealed by a .. traversal instead of trusting the link path", async () => {
    const link = join(repoRoot, `.ocx-link-${process.pid}`);
    const missing = join(repoRoot, `.ocx-missing-${process.pid}`);

    const { stderr, exitCode } = await withSandbox(async (sandbox) => {
      const outside = join(sandbox, "outside-target");
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, link);
      try {
        // Nothing exists at the missing component, so `..` has to be applied lexically
        // before the symlink can be resolved.
        return await runScript(`${missing}/../${link.split("/").pop()}`);
      } finally {
        rmSync(link, { recursive: true, force: true });
        rmSync(missing, { recursive: true, force: true });
      }
    });

    // The link points at a directory that does not exist, so the script refuses to
    // build THROUGH it rather than guessing where it leads. What must never happen is
    // treating the unresolved link path as a destination inside the repository.
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to build");
    expect(stderr).not.toContain(`${missing}/`);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(missing)).toBe(false);
  }, 300_000);

  test("refuses a symlink that points outside the permitted roots", async () => {
    const link = join(repoRoot, `.ocx-outward-${process.pid}`);
    const outside = join(
      process.env.HOME ?? "/Users/shared",
      `.ocx-symtarget-${process.pid}-${Date.now()}`,
    );

    rmSync(link, { recursive: true, force: true });
    symlinkSync(outside, link);
    try {
      const { stderr, exitCode } = await runScript(link);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Refusing to build");
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  }, 120_000);

  // The third bypass: a RELATIVE dangling target was joined onto the resolved prefix
  // without normalising, so `link -> ../../outside` became `<repo>/../../outside`,
  // satisfied the `<repo>/*` prefix check, and escaped during mkdir -p.
  test("refuses a symlink whose relative target escapes the repository", async () => {
    const link = join(repoRoot, `.ocx-rel-${process.pid}`);
    const escaped = resolve(repoRoot, "..", "..", `ocx-rel-target-${process.pid}`);

    rmSync(link, { recursive: true, force: true });
    symlinkSync(`../../ocx-rel-target-${process.pid}`, link);
    try {
      const { stderr, exitCode } = await runScript(link);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Refusing to build");
      expect(existsSync(escaped)).toBe(false);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  }, 120_000);

  // Runs the child in a directory that CONTAINS a matching entry, so the old unquoted
  // loop would have expanded the star. With cwd=repoRoot and the glob under dist/, the
  // pattern matched nothing and the test passed against the broken implementation too.
  test("treats glob characters as literal path components", async () => {
    await withSandbox(async (sandbox) => {
      const decoy = join(sandbox, "ocx-glob-decoy-probe");
      mkdirSync(decoy, { recursive: true });

      const { stderr } = await runScript(join(sandbox, "ocx-glob-*-probe"), sandbox);

      expect(stderr).not.toContain("Refusing to build");
      // The literal-star path is the one that was used, not the decoy it could match.
      expect(existsSync(join(sandbox, "ocx-glob-*-probe"))).toBe(true);
      expect(existsSync(join(decoy, "OpenCodex.app"))).toBe(false);
    });
  }, 300_000);

  test("allows a destination inside the repository", async () => {
    const inside = join(repoRoot, "dist", `ocx-inside-${process.pid}`);
    try {
      const { stderr } = await runScript(inside);
      expect(stderr).not.toContain("Refusing to build into");
    } finally {
      rmSync(inside, { recursive: true, force: true });
    }
  }, 300_000);

  test("allows a temp destination", async () => {
    await withSandbox(async (sandbox) => {
      const { stderr } = await runScript(join(sandbox, "build"));
      expect(stderr).not.toContain("Refusing to build into");
    });
  }, 300_000);
});

describe("macOS widget packaging", () => {
  test("stages, signs, and validates the WidgetKit appex", () => {
    expect(scriptText).toContain("--product OpenCodexWidget");
    expect(scriptText).toContain("Contents/PlugIns/OpenCodexWidget.appex");
    expect(scriptText).toContain("Widget-Info.plist");
    expect(scriptText).toContain("Widget.entitlements");
    expect(scriptText).toContain("Contents/PlugIns/OpenCodexWidget.appex/Contents/MacOS/OpenCodexWidget");
    expect(scriptText).toContain("container fallback path");
  });
});
