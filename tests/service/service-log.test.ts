import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { rotateServiceLog } from "../../src/service/logging";

const roots: string[] = [];
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-service-log-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
async function cli(service: boolean, args = ["start", "--port", "invalid"]) {
  const root = sandbox();
  const env = { ...process.env, HOME: root, OPENCODEX_HOME: join(root, ".opencodex"), CODEX_HOME: join(root, ".codex") };
  delete env.OCX_SERVICE;
  if (service) env.OCX_SERVICE = "1";
  const child = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), ...args], {
    cwd: repoRoot(), env, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("managed service log", () => {
  test("CLI start errors receive an ISO timestamp only under OCX_SERVICE", async () => {
    const managed = await cli(true);
    const interactive = await cli(false);
    expect(managed.code).toBe(1);
    expect(interactive.code).toBe(1);
    expect(managed.stderr.trim()).toMatch(timestamp);
    expect(managed.stderr.replace(new RegExp(timestamp.source, "gm"), "")).toBe(interactive.stderr);
  });

  test("inherited OCX_SERVICE does not change other CLI command output", async () => {
    const managed = await cli(true, ["--version"]);
    const interactive = await cli(false, ["--version"]);
    expect(managed.code).toBe(0);
    expect(managed.stdout).toBe(interactive.stdout);
    expect(managed.stdout).not.toMatch(timestamp);
  });

  test("all console sinks prefix every line and preserve formatted arguments", async () => {
    const path = join(sandbox(), "service.log");
    const child = Bun.spawn([process.execPath, "--eval", `
      const { startServiceLogging } = await import(${JSON.stringify(repoPath("src/service/logging.ts"))});
      const stop = startServiceLogging(${JSON.stringify(path)}, { OCX_SERVICE: "1" });
      console.log("hello %s\\nnext", "world");
      console.info("info"); console.debug("debug"); console.warn("warn");
      console.error(new Error("sample diagnostic"));
      stop(); console.log("plain");
    `], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines.pop()).toBe("plain");
    for (const line of [...lines, ...stderr.trimEnd().split("\n")]) expect(line).toMatch(timestamp);
    expect(stdout.replace(new RegExp(timestamp.source, "gm"), "")).toBe("hello world\nnext\ninfo\ndebug\nplain\n");
    expect(stderr).toContain("Error: sample diagnostic");
  });

  test("copy-truncate keeps the open append descriptor and two bounded generations", () => {
    const path = join(sandbox(), "service.log");
    writeFileSync(path, "oldest\nlatest\n");
    const inode = statSync(path).ino;
    const fd = openSync(path, "a");
    try {
      expect(rotateServiceLog(path, 7)).toBe(true);
      expect(statSync(path).ino).toBe(inode);
      expect(statSync(path).size).toBe(0);
      expect(readFileSync(`${path}.1`, "utf8")).toBe("latest\n");
      writeSync(fd, "second line\n");
      expect(readFileSync(path, "utf8")).toBe("second line\n");
      expect(rotateServiceLog(path, 7)).toBe(true);
      expect(readFileSync(`${path}.2`, "utf8")).toBe("latest\n");
      writeSync(fd, "third line\n");
      expect(rotateServiceLog(path, 7)).toBe(true);
      expect(readFileSync(`${path}.1`, "utf8")).toBe("d line\n");
      expect(readFileSync(`${path}.2`, "utf8")).toBe("d line\n");
      expect(existsSync(`${path}.3`)).toBe(false);
    } finally { closeSync(fd); }
  });

  test("missing, small, exact-cap and failed rotations leave logging usable", () => {
    const path = join(sandbox(), "service.log");
    expect(rotateServiceLog(path, 8)).toBe(false);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, "small");
    expect(rotateServiceLog(path, 8)).toBe(false);
    writeFileSync(path, "exactcap");
    expect(rotateServiceLog(path, 8)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(false);
    writeFileSync(path, "over the cap");
    writeFileSync(`${path}.1`, "previous");
    mkdirSync(`${path}.2`);
    expect(rotateServiceLog(path, 8)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("over the cap");
    expect(rotateServiceLog(path, 0)).toBe(false);
  });

  test("rotation checks at startup and periodically only for service processes", async () => {
    const path = join(sandbox(), "service.log");
    const child = Bun.spawn([process.execPath, "--eval", `
      const fs = await import("node:fs");
      const { startServiceLogging, SERVICE_LOG_MAX_BYTES: cap } = await import(${JSON.stringify(repoPath("src/service/logging.ts"))});
      const path = ${JSON.stringify(path)};
      const grow = () => { fs.writeFileSync(path, ""); fs.truncateSync(path, cap + 1); };
      grow();
      const original = console.log;
      startServiceLogging(path, {}, 10)();
      if (console.log !== original || fs.statSync(path).size !== cap + 1) process.exit(2);
      const stop = startServiceLogging(path, { OCX_SERVICE: "1" }, 10);
      if (fs.statSync(path).size !== 0 || fs.statSync(path + ".1").size !== cap) process.exit(3);
      grow();
      await Bun.sleep(80);
      stop();
      if (fs.statSync(path).size !== 0 || fs.statSync(path + ".2").size !== cap) process.exit(4);
    `], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  });
});
