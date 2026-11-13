import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { preparePinnedCodex } from "../helpers/link-gate-binary";

// The link WebSocket release gate labels a run "release gate" when the sha256 of OCX_LINK_GATE_CODEX matches the
// reviewed digest (tests/fixtures/link-gate-codex.json). That label is only honest if the bytes it hashed are the bytes
// it runs. These cases need no real Codex: two small scripts named codex stand in for it.

let root = "";
afterEach(() => { if (root) removeTreeWithRetry(root); root = ""; });

function script(dir: string, says: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "codex");
  writeFileSync(file, "#!/bin/sh\necho " + says + "\n");
  chmodSync(file, 0o755);
  return file;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function run(path: string, cwd: string, pathDir: string): Promise<string> {
  const child = Bun.spawn([path], { cwd, env: { PATH: pathDir + ":/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  await child.exited;
  return (await new Response(child.stdout).text()).trim();
}

describe("the pinned Codex binary of the release gate: what is hashed is what runs", () => {
  test("a bare name runs the file that was hashed, not another codex on PATH", async () => {
    root = mkdtempSync(join(tmpdir(), "ocx-gate-binary-"));
    const cwd = join(root, "work"); const onPath = join(root, "bin"); const scratch = join(root, "scratch");
    const hashed = script(cwd, "hashed-copy");
    script(onPath, "path-copy");
    mkdirSync(scratch);
    const prepared = preparePinnedCodex("codex", { cwd, scratch })!;
    expect(prepared.digest).toBe(sha256(hashed));
    expect(await run(prepared.path, cwd, onPath)).toBe("hashed-copy");
    expect(isAbsolute(prepared.path)).toBe(true);
  });

  test("replacing the file after it was hashed does not change what runs", async () => {
    root = mkdtempSync(join(tmpdir(), "ocx-gate-binary-"));
    const cwd = join(root, "work"); const scratch = join(root, "scratch");
    const hashed = script(cwd, "hashed-copy");
    mkdirSync(scratch);
    const prepared = preparePinnedCodex(hashed, { cwd, scratch })!;
    script(cwd, "replaced");
    expect(await run(prepared.path, cwd, join(root, "none"))).toBe("hashed-copy");
    expect(sha256(prepared.path)).toBe(prepared.digest);
    // The copy that runs is read-only.
    expect(statSync(prepared.path).mode & 0o222).toBe(0);
  });

  test("a value that names no executable file is refused", () => {
    root = mkdtempSync(join(tmpdir(), "ocx-gate-binary-"));
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    expect(preparePinnedCodex("", { cwd: root, scratch })).toBeNull();
    expect(preparePinnedCodex("missing", { cwd: root, scratch })).toBeNull();
    expect(preparePinnedCodex(root, { cwd: root, scratch })).toBeNull();
    writeFileSync(join(root, "plain"), "not executable");
    expect(preparePinnedCodex("plain", { cwd: root, scratch })).toBeNull();
  });
});
