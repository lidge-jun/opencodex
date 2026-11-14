import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { preparePinnedCodex } from "../helpers/link-gate-binary";

// The link WebSocket release gate labels a run "release gate" when the sha256 of OCX_LINK_GATE_CODEX matches the
// reviewed digest (tests/fixtures/link-gate-codex.json). That label is only honest if the bytes it hashed are the bytes
// it runs. These cases need no real Codex: copies of the running Bun executable, named codex, stand in for it, and each
// copy prints its own path, so a run shows which file executed. That works the same on every platform.

const NAME = process.platform === "win32" ? "codex.exe" : "codex";
const PRINT_SELF = ["-e", "console.log(process.execPath)"];

let root = "";
afterEach(() => { if (root) removeTreeWithRetry(root); root = ""; });

/** A copy of this Bun named codex in `dir`. */
function fakeCodex(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, NAME);
  copyFileSync(process.execPath, file);
  chmodSync(file, 0o755);
  return file;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * Runs `path` from `cwd` with only `pathDir` on PATH; resolves with the path of the executable that ran.
 *
 * Both sides of every comparison go through realpathSync.native. The fixture root comes from tmpdir(), which on the
 * hosted Windows runner keeps the 8.3 short spelling (C:\Users\RUNNER~1\...), while the child reports its own
 * long name (runneradmin); the JS realpathSync leaves the short name in place, so one file compared unequal to itself
 * (dev run 43483630535). The native call resolves both to the same canonical path.
 */
async function whoRan(path: string, cwd: string, pathDir: string): Promise<string> {
  const child = Bun.spawn([path, ...PRINT_SELF], { cwd, env: { PATH: pathDir + delimiter + (process.env.PATH ?? "") }, stdout: "pipe", stderr: "pipe" });
  await child.exited;
  return realpathSync.native((await new Response(child.stdout).text()).trim());
}

describe("the pinned Codex binary of the release gate: what is hashed is what runs", () => {
  test("a bare name runs the file that was hashed, not another codex on PATH", async () => {
    root = mkdtempSync(join(tmpdir(), "ocx-gate-binary-"));
    const cwd = join(root, "work"); const onPath = join(root, "bin"); const scratch = join(root, "scratch");
    const hashed = fakeCodex(cwd);
    // The codex on PATH has other bytes than the hashed file, so the digest tells the two apart. It is executable
    // (0755) but never has to run: the gate must not reach it.
    mkdirSync(onPath);
    const onPathFile = join(onPath, NAME);
    writeFileSync(onPathFile, "another codex on PATH, not the hashed one\n");
    chmodSync(onPathFile, 0o755);
    mkdirSync(scratch);
    const prepared = preparePinnedCodex(NAME, { cwd, scratch })!;
    expect(prepared.digest).toBe(sha256(hashed));
    expect(prepared.digest).not.toBe(sha256(onPathFile));
    // The executable that runs is the file the gate names (the copy of the hashed file), never the codex on PATH.
    expect(await whoRan(prepared.path, cwd, onPath)).toBe(realpathSync.native(resolve(cwd, prepared.path)));
    expect(isAbsolute(prepared.path)).toBe(true);
    expect(sha256(prepared.path)).toBe(prepared.digest);
  });

  test("replacing the file after it was hashed does not change what runs", async () => {
    root = mkdtempSync(join(tmpdir(), "ocx-gate-binary-"));
    const cwd = join(root, "work"); const scratch = join(root, "scratch");
    const original = fakeCodex(cwd);
    mkdirSync(scratch);
    const prepared = preparePinnedCodex(original, { cwd, scratch })!;
    writeFileSync(original, "replaced after hashing");
    expect(await whoRan(prepared.path, cwd, join(root, "none"))).toBe(realpathSync.native(prepared.path));
    expect(sha256(prepared.path)).toBe(prepared.digest);
    // The copy that runs is read-only.
    if (process.platform !== "win32") expect(statSync(prepared.path).mode & 0o222).toBe(0);
  });

  test("the copy never replaces an existing file: a second copy into the same scratch directory is refused", () => {
    root = mkdtempSync(join(tmpdir(), "ocx-gate-binary-"));
    const cwd = join(root, "work"); const scratch = join(root, "scratch");
    const original = fakeCodex(cwd);
    mkdirSync(scratch);
    const prepared = preparePinnedCodex(original, { cwd, scratch })!;
    // Writable again, so only the exclusive flag (not the copy's 0555 mode) can refuse the second copy.
    chmodSync(prepared.path, 0o755);
    writeFileSync(original, "other bytes for the second copy");
    chmodSync(original, 0o755);
    let refused: unknown = null;
    try { preparePinnedCodex(original, { cwd, scratch }); } catch (error) { refused = error; }
    expect((refused as NodeJS.ErrnoException | null)?.code).toBe("EEXIST");
    expect(sha256(prepared.path)).toBe(prepared.digest);
  });

  test("a value that names no file is refused", () => {
    root = mkdtempSync(join(tmpdir(), "ocx-gate-binary-"));
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    expect(preparePinnedCodex("", { cwd: root, scratch })).toBeNull();
    expect(preparePinnedCodex("missing", { cwd: root, scratch })).toBeNull();
    expect(preparePinnedCodex(root, { cwd: root, scratch })).toBeNull();
  });

  test.skipIf(process.platform === "win32")("a file without execute permission is refused (POSIX permissions)", () => {
    root = mkdtempSync(join(tmpdir(), "ocx-gate-binary-"));
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    writeFileSync(join(root, "plain"), "not executable");
    expect(preparePinnedCodex("plain", { cwd: root, scratch })).toBeNull();
  });
});
