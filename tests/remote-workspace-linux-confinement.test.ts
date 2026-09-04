import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlatformRemoteWorkspaceCommandRunner,
  linuxRemoteWorkspaceCommandRunnerAvailable,
} from "../src/remote-control";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

test("hosted Linux proves workspace write and denies adjacent access, loopback, and detached survival", async () => {
  const required = process.env.OCX_REQUIRE_LINUX_REMOTE_WORKSPACE_CONFINEMENT === "1";
  const available = process.platform === "linux"
    && existsSync("/usr/bin/bwrap")
    && linuxRemoteWorkspaceCommandRunnerAvailable();
  if (!required && !available) return;
  expect(process.platform).toBe("linux");
  expect(existsSync("/usr/bin/bwrap")).toBe(true);
  expect(available).toBe(true);

  const parent = mkdtempSync(join(tmpdir(), "ocx-remote-linux-confinement-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const marker = join(workspace, "probe-marker");
  const outsideRead = join(parent, "outside-secret");
  const outsideWrite = join(parent, "outside-write");
  mkdirSync(workspace);
  writeFileSync(join(workspace, ".keep"), "workspace");
  writeFileSync(outsideRead, "must-not-be-visible");

  let acceptedConnections = 0;
  const listener = createServer(socket => {
    acceptedConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("loopback probe did not bind TCP");
  const runner = createPlatformRemoteWorkspaceCommandRunner({
    linux: { writableRoots: [workspace] },
  });
  if (!runner) throw new Error("production Linux Remote Workspace runner was not created");

  try {
    const result = await runner.run({
      root: workspace,
      cwd: workspace,
      command: [
        "bun",
        "-e",
        [
          'import { readFileSync, writeFileSync } from "node:fs";',
          'const [outsideRead, outsideWrite, port] = process.argv.slice(1);',
          'if (!outsideRead || !outsideWrite || !port) process.exit(31);',
          'if (process.execPath !== "/ocx-runtime/bin/bun") process.exit(29);',
          'writeFileSync("probe-marker", "sandboxed");',
          'try { readFileSync(outsideRead); process.exit(26); } catch (error) { void error; }',
          'try { writeFileSync(outsideWrite, "escaped"); process.exit(27); } catch (error) { void error; }',
          'try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }); process.exit(28); } catch (error) { void error; }',
        ].join("\n"),
        "--",
        outsideRead,
        outsideWrite,
        String(address.port),
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("sandboxed");
    expect(existsSync(outsideWrite)).toBe(false);
    expect(acceptedConnections).toBe(0);
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }

  const lateMarker = join(workspace, "late-marker");
  const controller = new AbortController();
  const pending = runner.run({
    root: workspace,
    cwd: workspace,
    command: [
      "/bin/bash",
      "-c",
      "setsid /bin/bash -c 'sleep 0.5; printf escaped > late-marker' >/dev/null 2>&1 & sleep 30",
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024,
    signal: controller.signal,
  });
  await Bun.sleep(100);
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  await Bun.sleep(750);
  expect(existsSync(lateMarker)).toBe(false);

  const unsafeWorkspace = join(parent, "unsafe-workspace");
  mkdirSync(unsafeWorkspace);
  linkSync(outsideRead, join(unsafeWorkspace, "outside-alias"));
  expect(createPlatformRemoteWorkspaceCommandRunner({
    linux: { writableRoots: [unsafeWorkspace] },
  })).toBeUndefined();
  expect(readFileSync(outsideRead, "utf8")).toBe("must-not-be-visible");
});
