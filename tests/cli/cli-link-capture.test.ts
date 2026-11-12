import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";
import { linkDir } from "../../src/link/paths";
import { sshCaptureDir } from "../../src/link/ssh-capture";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const T0 = Date.UTC(2026, 10, 11, 9, 0, 0);
let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-capture-cli-"));
  process.env.OPENCODEX_HOME = root;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function harness(now = T0) {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  const deps: LinkCliDeps = {
    captureNow: () => now,
    // Capture is local: it needs neither the management API nor a live proxy.
    fetchImpl: async () => { throw new Error("capture must not call the management API"); },
    findLiveProxy: async () => { throw new Error("capture must not discover the proxy"); },
  };
  return { out, err, deps, restore: () => { console.log = log; console.error = error; } };
}

describe("ocx link capture", () => {
  test("status on a fresh home reports off and creates nothing", async () => {
    const h = harness(); try {
      expect(await runLinkCommand(["capture", "status", "--json"], h.deps)).toBe(0);
      expect(JSON.parse(h.out.join("\n"))).toMatchObject({ enabled: false, logLevel: "ERROR", files: [], removed: 0,
        directory: sshCaptureDir(linkDir(root)), retentionHours: 72, maxMinutes: 60 });
      expect(readdirSync(root)).toEqual([]);
    } finally { h.restore(); }
  });

  test("start and stop open and close the window under OPENCODEX_HOME", async () => {
    const h = harness(); try {
      expect(await runLinkCommand(["capture", "start", "--minutes", "5", "--json"], h.deps)).toBe(0);
      expect(JSON.parse(h.out.join("\n"))).toMatchObject({ enabled: true, logLevel: "DEBUG1",
        startedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 5 * 60_000).toISOString() });
      expect(existsSync(join(sshCaptureDir(linkDir(root)), "control.json"))).toBe(true);
      h.out.length = 0;
      expect(await runLinkCommand(["capture", "stop"], h.deps)).toBe(0);
      expect(h.out[0]).toBe("SSH capture: off (the next tunnel attempt runs ssh with LogLevel=ERROR)");
      expect(existsSync(join(sshCaptureDir(linkDir(root)), "control.json"))).toBe(false);
    } finally { h.restore(); }
  });

  test("human start output says when it ends and how a connected tunnel picks it up", async () => {
    const h = harness(); try {
      expect(await runLinkCommand(["capture", "start"], h.deps)).toBe(0);
      expect(h.out[0]).toBe("SSH capture: on until " + new Date(T0 + 15 * 60_000).toISOString() + " (the next tunnel attempt runs ssh with LogLevel=DEBUG1)");
      expect(h.out.join("\n")).toContain("ocx link reconnect --link-id <id>");
    } finally { h.restore(); }
  });

  test.each([[["start", "--minutes", "0"]], [["start", "--minutes", "61"]], [["start", "--minutes", "ten"]], [["stop", "--all"]], [["status", "extra"]], [["enable"]], [[]]])(
    "refuses %j as a usage error without writing", async args => {
      const h = harness(); try {
        expect(await runLinkCommand(["capture", ...args], h.deps)).toBe(2);
        expect(existsSync(join(sshCaptureDir(linkDir(root)), "control.json"))).toBe(false);
      } finally { h.restore(); }
    });
});

