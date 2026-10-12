import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MessageBudget } from "../../src/messaging/budget";
import { LocalMessageRpc } from "../../src/messaging/rpc";
import { localDaemonEndpoint, localSocket, trustedSocketPath, type SocketFilesystem } from "../../src/messaging/socket";
import { localMessagingFixture } from "../helpers/messaging-local";

const uid = 1234;
const socket = "/tmp/private/codex/app-server-control/app-server-control.sock";
/** Synthetic ownership is independent of the process uid and needs no root privileges. */
function filesystem(overrides: Record<string, { uid?: number; mode?: number; socket?: boolean; dir?: boolean }> = {}, real = socket): SocketFilesystem {
  return {
    realpath: () => real,
    lstat(path) {
      const entry = { uid: path === "/" || path === "/tmp" ? 0 : uid,
        mode: path === "/tmp" ? 0o1777 : 0o700, socket: path === real, dir: path !== real, ...overrides[path] };
      return { uid: entry.uid, mode: entry.mode, isSocket: () => entry.socket, isDirectory: () => entry.dir };
    },
  };
}

test("StrictModes accepts a private home with root-owned sticky /tmp ancestry", () => {
  expect(trustedSocketPath(socket, filesystem(), uid)).toBe(socket);
  const noSticky = filesystem({ "/tmp": { mode: 0o755 } });
  expect(trustedSocketPath(socket, noSticky, uid)).toBe(socket);
});

test("StrictModes checks socket type/owner and every ancestor including root", () => {
  for (const override of [
    { [socket]: { uid: uid + 1 } }, { [socket]: { socket: false } },
    { [dirname(socket)]: { mode: 0o770 } }, { [dirname(socket)]: { mode: 0o707 } },
    { "/tmp/private": { uid: uid + 1 } }, { "/tmp/private": { mode: 0o1707 } },
    { "/tmp/private": { dir: false } }, { "/tmp": { mode: 0o777 } },
    { "/": { uid: uid + 1 } }, { "/": { mode: 0o775 } },
  ]) {
    try { trustedSocketPath(socket, filesystem(override), uid); throw new Error("unexpected acceptance"); }
    catch (error) {
      expect(error).toMatchObject({ code: "untrusted_socket" });
      expect(String(error)).not.toContain(socket);
    }
  }
});

test("symlinks are judged by real ancestry, and inaccessible stats fail closed without path leakage", () => {
  expect(() => trustedSocketPath("/alias/control.sock", filesystem({ "/tmp/private": { mode: 0o777 } }), uid)).toThrow("not trusted");
  const fs = filesystem();
  fs.realpath = () => { throw new Error("private realpath details"); };
  try { trustedSocketPath(socket, fs, uid); throw new Error("unexpected acceptance"); }
  catch (error) { expect(error).toMatchObject({ code: "untrusted_socket" }); expect(String(error)).not.toContain("private realpath details"); }
});

describe.skipIf(process.platform === "win32")("real filesystem trust before connect", () => {
  test("0700 home and a symlinked CODEX_HOME connect through the trusted real socket", async () => {
    const fixture = localMessagingFixture(), budget = new MessageBudget();
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.codexHome, alias);
    let rpc: LocalMessageRpc | undefined;
    try {
      expect(trustedSocketPath(localDaemonEndpoint(fixture.codexHome).url.slice(10, -2)))
        .toBe(join(realpathSync(join(fixture.codexHome, "app-server-control")), "app-server-control.sock"));
      rpc = await LocalMessageRpc.connect(localDaemonEndpoint(alias).url, budget);
      expect(await rpc.loadedPage()).toMatchObject({ data: expect.any(Array) });
      expect(fixture.connectionCount).toBe(1);
    } finally { rpc?.close(); budget.dispose(); await fixture.close(); }
  });

  test("writable parent and symlink to that parent fail before a connection opens", async () => {
    const fixture = localMessagingFixture();
    try {
      const alias = join(fixture.root, "alias");
      symlinkSync(fixture.codexHome, alias);
      for (const mode of [0o770, 0o707, 0o777]) {
        chmodSync(fixture.codexHome, mode);
        for (const home of [fixture.codexHome, alias]) {
          expect(() => localSocket(localDaemonEndpoint(home).url)).toThrow("not trusted");
        }
      }
      expect(fixture.connectionCount).toBe(0);
    } finally { chmodSync(fixture.codexHome, 0o700); await fixture.close(); }
  });

  test("a regular file cannot impersonate the control socket", async () => {
    const fixture = localMessagingFixture();
    try {
      const home = join(fixture.root, "file-home"), control = join(home, "app-server-control");
      mkdirSync(control, { recursive: true, mode: 0o700 });
      writeFileSync(join(control, "app-server-control.sock"), "not a socket");
      expect(() => localSocket(localDaemonEndpoint(home).url)).toThrow("not trusted");
      expect(fixture.connectionCount).toBe(0);
    } finally { await fixture.close(); }
  });
});
