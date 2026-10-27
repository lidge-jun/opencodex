// Real persisted bytes and separate producer/reader processes. POSIX uid/mode,
// liveness and directory fsync are injected; this is not native POSIX crash proof.
import { expect, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexCliUpdateRecovery, codexCliUpdateRecoveryBlocksAdmission,
  finishClosedCodexCliUpdateRecovery } from "../../src/codex/cli-update-recovery";
import { removeTreeWithRetry } from "./remove-tree";

const scenario = process.argv[2]!, mode = process.argv[3];
if (!mode) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "ocx-recovery-restart-")));
  try {
    for (const stage of ["produce", "read"]) {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), scenario, stage, root], {
        env: process.env, encoding: "utf8", windowsHide: true, timeout: 20_000,
      });
      expect({ stage, status: result.status, error: result.error?.message,
        output: result.stdout + result.stderr }).toMatchObject({ status: 0 });
    }
  } finally { removeTreeWithRetry(root); }
} else {
  const root = process.argv[4]!, store = join(root, "codex-cli-update-recovery");
  const tokenPath = join(root, "token"), producerPath = join(root, "producer");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
  const uid = process.geteuid?.() ?? 1234, realStat = fs.lstatSync, realFstat = fs.fstatSync;
  let unsafeInode: number | undefined;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
    const value = realStat(path);
    return Object.assign(value, { uid, mode: value.isDirectory() ? 0o40700 : 0o100600 });
  }) as typeof fs.lstatSync);
  const fstat = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const value = realFstat(fd);
    return Object.assign(value, { uid, mode: value.ino === unsafeInode ? 0o100666 : 0o100600 });
  }) as typeof fs.fstatSync);
  const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {});
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  Object.defineProperty(process, "geteuid", { value: () => uid, configurable: true });
  try {
    if (mode === "produce") {
      const token = randomUUID(), recovery = createCodexCliUpdateRecovery(token, root);
      fs.writeFileSync(tokenPath, token); fs.writeFileSync(producerPath, String(process.pid));
      if (!scenario.endsWith("-no-record")) {
        recovery.arm();
        // Parent terminal publication must recover both armed and child records.
        if (scenario !== "parent-terminal" && !scenario.startsWith("worker-")) recovery.child(424242);
      } else if (scenario === "worker-no-record") {
        const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("interrupted_arm"); });
        try { expect(() => recovery.arm()).toThrow("interrupted_arm"); } finally { rename.mockRestore(); }
      }
      const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("interrupted_terminal"); });
      try {
        expect(() => scenario.startsWith("parent-")
          ? finishClosedCodexCliUpdateRecovery(token, root) : recovery.terminal()).toThrow("interrupted_terminal");
      } finally { rename.mockRestore(); }
      const suffix = scenario.startsWith("parent-") ? ".terminal.pending" : ".pending";
      const pending = join(store, token + suffix), bytes = fs.readFileSync(pending, "utf8");
      expect(JSON.parse(bytes)).toMatchObject({ token, phase: "terminal", pgid: null, parentPid: process.pid });
      if (!scenario.includes("-competing-") && scenario.endsWith("-malformed")) fs.writeFileSync(pending, bytes.slice(0, -1));
      if (!scenario.includes("-competing-")
        && ["foreign", "armed", "wrong-parent", "nonnull-group"].some(kind => scenario.endsWith("-" + kind))) {
        const record = JSON.parse(bytes);
        if (scenario.endsWith("-foreign")) record.token = randomUUID();
        if (scenario.endsWith("-armed")) record.phase = "armed";
        if (scenario.endsWith("-wrong-parent")) record.parentPid += 1;
        if (scenario.endsWith("-nonnull-group")) record.pgid = 424242;
        fs.writeFileSync(pending, JSON.stringify(record));
      }
      if (scenario.includes("-competing-")) {
        const other = join(store, token + (scenario.startsWith("parent-") ? ".pending" : ".terminal.pending"));
        fs.writeFileSync(other, scenario.endsWith("-malformed") ? "{"
          : JSON.stringify({ ...JSON.parse(bytes), phase: scenario.endsWith("-armed") ? "armed" : "terminal" }), { mode: 0o600 });
      }
      if (scenario.endsWith("-other-owner")) createCodexCliUpdateRecovery(randomUUID(), root).arm();
    } else {
      const token = fs.readFileSync(tokenPath, "utf8"), producer = Number(fs.readFileSync(producerPath, "utf8"));
      expect(process.pid).not.toBe(producer);
      if (scenario.endsWith("-unsafe")) unsafeInode = realStat(join(store, token
        + (scenario.startsWith("parent-") ? ".terminal.pending" : ".pending"))).ino;
      let groupLive = scenario.endsWith("-live-group") || scenario.endsWith("-reprobe");
      const probes: number[] = [];
      const kill = spyOn(process, "kill").mockImplementation(((pid: number) => {
        probes.push(pid);
        if (scenario.endsWith("-denied")) throw Object.assign(new Error("probe_denied"), { code: "EPERM" });
        if ((pid < 0 && groupLive) || (pid > 0 && scenario.endsWith("-live-parent"))) return true;
        throw Object.assign(new Error("probe_absent"), { code: "ESRCH" });
      }) as typeof process.kill);
      const before = fs.readdirSync(store).map(name => [name, fs.readFileSync(join(store, name), "utf8")]);
      try {
        const admits = ["child-terminal", "parent-terminal", "parent-no-record", "worker-no-record",
          "child-competing-terminal", "parent-competing-terminal", "worker-armed-terminal"].includes(scenario);
        expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(!admits);
        if (scenario.endsWith("-reprobe")) {
          groupLive = false;
          expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(false);
          expect(probes).toContain(-424242);
        }
        if (admits) expect(probes).toContain(producer);
        // Admission recognizes terminal evidence without mutating disk or receipts.
        expect(fs.readdirSync(store).map(name => [name, fs.readFileSync(join(store, name), "utf8")])).toEqual(before);
        expect(fs.existsSync(join(store, token + ".terminal"))).toBe(false);
      } finally { kill.mockRestore(); }
    }
  } finally {
    stat.mockRestore(); fstat.mockRestore(); sync.mockRestore();
    Object.defineProperty(process, "platform", platform);
    if (geteuid) Object.defineProperty(process, "geteuid", geteuid); else Reflect.deleteProperty(process, "geteuid");
  }
}
