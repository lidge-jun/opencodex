import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSshCaptureOpener, pruneSshCapture, readSshCaptureControl, readSshCaptureStatus, SSH_CAPTURE_FILE_MAX_BYTES,
  SSH_CAPTURE_MAX_FILES, SSH_CAPTURE_RETENTION_MS, sshCaptureDir, startSshCapture, stopSshCapture,
} from "../../src/link/ssh-capture";
import { resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { resetWindowsPrincipalForTests, setAsyncWindowsPrincipalRunnerForTests, setWindowsPrincipalRunnerForTests } from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const T0 = Date.UTC(2026, 10, 11, 0, 0, 0);
const LINK = "lnk_0123456789abcdef";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), "ocx-ssh-capture-"));
  roots.push(configDir);
  const linkDirectory = join(configDir, "link");
  return { configDir, linkDirectory, dir: sshCaptureDir(linkDirectory) };
}

function records(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

describe("ssh capture is off by default", () => {
  test("no capture directory: the opener returns null and writes nothing", () => {
    const { configDir, linkDirectory } = fixture();
    const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
    expect(opener("home", LINK)).toBeNull();
    expect(opener("child", LINK)).toBeNull();
    expect(readdirSync(configDir)).toEqual([]);
  });

  test("a directory without a control file, or a stopped window, stays off", () => {
    const { linkDirectory } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    stopSshCapture(linkDirectory, T0 + 1);
    expect(createSshCaptureOpener({ linkDirectory, now: () => T0 + 2 })("home", LINK)).toBeNull();
  });
});

describe("ssh capture window", () => {
  test("start opens a 15-minute window by default, writes sanitized records, and expiry stops storage", async () => {
    const { linkDirectory, dir } = fixture();
    let now = T0;
    const status = startSshCapture({ linkDirectory, now });
    expect(status).toMatchObject({ enabled: true, logLevel: "DEBUG1", expiresAt: new Date(T0 + 15 * 60_000).toISOString(), files: [] });
    const opener = createSshCaptureOpener({ linkDirectory, now: () => now });
    const spawn = opener("home", LINK)!;
    expect(spawn.logLevel).toBe("DEBUG1");
    expect(spawn.stderrLine("debug1: Connecting to home.example.test [203.0.113.7] port 2222.")).toBe(false);
    expect(spawn.stderrLine("alice@home.example.test: Permission denied (publickey).")).toBe(true);
    spawn.stderrLine("mystery line hunter2");
    spawn.stderrLine("another mystery hunter2");
    await opener.flush();
    const path = join(dir, "ssh-" + T0 + ".jsonl");
    const written = records(path);
    expect(written).toEqual([
      { at: T0, tunnel: "home", linkId: LINK, level: "debug", event: "connect.start", text: "debug1: Connecting to <host> [<address>] port <port>." },
      { at: T0, tunnel: "home", linkId: LINK, level: "error", event: "auth.denied", text: "<user>@<host>: Permission denied (publickey)." },
      { at: T0, tunnel: "home", linkId: LINK, level: "error", event: "unrecognized", count: 2 },
    ]);
    expect(readFileSync(path, "utf8")).not.toMatch(/hunter2|alice|example\.test|203\.0|2222/);

    now = T0 + 15 * 60_000;
    // The running ssh still prints; classification keeps working, but nothing is stored.
    expect(spawn.stderrLine("Host key verification failed.")).toBe(true);
    await opener.flush();
    expect(records(path)).toHaveLength(3);
    expect(opener("home", LINK)).toBeNull();
    expect(readSshCaptureStatus(linkDirectory, now)).toMatchObject({ enabled: false, logLevel: "ERROR" });
  });

  test("minutes are bounded and a window beyond the hard maximum reads as off", () => {
    const { linkDirectory, dir } = fixture();
    expect(() => startSshCapture({ linkDirectory, now: T0, minutes: 0 })).toThrow("--minutes");
    expect(() => startSshCapture({ linkDirectory, now: T0, minutes: 61 })).toThrow("--minutes");
    expect(startSshCapture({ linkDirectory, now: T0, minutes: 60 }).expiresAt).toBe(new Date(T0 + 60 * 60_000).toISOString());
    // A hand-edited control file asking for a day is refused, and so is a clock that went backwards.
    writeFileSync(join(dir, "control.json"), JSON.stringify({ version: 1, startedAt: T0, expiresAt: T0 + 86_400_000 }), { mode: 0o600 });
    expect(readSshCaptureControl(dir, T0)).toBeNull();
    writeFileSync(join(dir, "control.json"), JSON.stringify({ version: 1, startedAt: T0, expiresAt: T0 + 60_000 }), { mode: 0o600 });
    expect(readSshCaptureControl(dir, T0)).not.toBeNull();
    expect(readSshCaptureControl(dir, T0 - 60 * 60_000)).toBeNull();
    writeFileSync(join(dir, "control.json"), JSON.stringify({ version: 1, startedAt: T0, expiresAt: T0 + 60_000, enable: "remote" }), { mode: 0o600 });
    expect(readSshCaptureControl(dir, T0)).toBeNull();
  });

  test("starting again while open moves the expiry and keeps the window's file", async () => {
    const { linkDirectory } = fixture();
    startSshCapture({ linkDirectory, now: T0, minutes: 5 });
    const status = startSshCapture({ linkDirectory, now: T0 + 60_000, minutes: 10 });
    expect(status.startedAt).toBe(new Date(T0).toISOString());
    expect(status.expiresAt).toBe(new Date(T0 + 11 * 60_000).toISOString());
  });

  test("stop closes the window at once, keeps the capture file, and the queue stores nothing more", async () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
    const spawn = opener("child", LINK)!;
    spawn.stderrLine("Host key verification failed.");
    await opener.flush();
    const stopped = stopSshCapture(linkDirectory, T0 + 1);
    expect(stopped.enabled).toBe(false);
    expect(stopped.files.map(file => file.name)).toEqual(["ssh-" + T0 + ".jsonl"]);
    expect(stopped.files[0]!.deleteAfter).toBe(new Date(statSync(join(dir, "ssh-" + T0 + ".jsonl")).mtimeMs + SSH_CAPTURE_RETENTION_MS).toISOString());
    spawn.stderrLine("Connection closed by 203.0.113.7 port 22");
    await opener.flush();
    expect(records(join(dir, "ssh-" + T0 + ".jsonl"))).toHaveLength(1);
  });

  test("the per-file size cap ends with one truncation marker and nothing after it", async () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    const path = join(dir, "ssh-" + T0 + ".jsonl");
    writeFileSync(path, " ".repeat(SSH_CAPTURE_FILE_MAX_BYTES - 400) + "\n", { mode: 0o600 });
    const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
    const spawn = opener("home", LINK)!;
    for (let index = 0; index < 50; index++) spawn.stderrLine("debug1: channel " + index + ": connected to 127.0.0.1 port 19001");
    await opener.flush();
    for (let index = 0; index < 50; index++) spawn.stderrLine("Host key verification failed.");
    await opener.flush();
    const size = statSync(path).size;
    expect(size).toBeLessThanOrEqual(SSH_CAPTURE_FILE_MAX_BYTES);
    const tail = readFileSync(path, "utf8").trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    expect(tail.at(-1)).toMatchObject({ event: "capture_truncated" });
    expect(tail.filter(record => record.event === "capture_truncated")).toHaveLength(1);
    expect(tail.some(record => record.event === "hostkey.verification_failed")).toBe(false);
  });

  test("a file already at the threshold gets its one marker, and a later process never appends after a marker", async () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    const path = join(dir, "ssh-" + T0 + ".jsonl");
    writeFileSync(path, " ".repeat(SSH_CAPTURE_FILE_MAX_BYTES - 100) + "\n", { mode: 0o600 });
    for (let round = 0; round < 2; round++) {
      // A fresh opener per round stands for a fresh process: it has no memory of a full session.
      const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
      opener("home", LINK)!.stderrLine("Host key verification failed.");
      await opener.flush();
    }
    const markers = readFileSync(path, "utf8").split("\n").filter(line => line.includes("capture_truncated"));
    expect(markers).toHaveLength(1);
    expect(statSync(path).size).toBeLessThanOrEqual(SSH_CAPTURE_FILE_MAX_BYTES);
  });

  test("a file that already ends with a marker takes nothing more, even well under the cap", async () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    const path = join(dir, "ssh-" + T0 + ".jsonl");
    const ended = JSON.stringify({ at: T0, event: "capture_truncated" }) + "\n";
    writeFileSync(path, ended, { mode: 0o600 });
    const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
    opener("home", LINK)!.stderrLine("Host key verification failed.");
    await opener.flush();
    expect(readFileSync(path, "utf8")).toBe(ended);
  });
});

describe("ssh capture queue under a flood", () => {
  test("an error line is stored even when debug lines filled the queue before the writer ran", async () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
    const spawn = opener("home", LINK)!;
    // All of these arrive before the asynchronous writer gets a turn, as on a slow disk.
    for (let index = 0; index < 1_500; index++) spawn.stderrLine("debug1: channel " + index + ": connected to 127.0.0.1 port 19001");
    spawn.stderrLine("alice@home.example.test: Permission denied (publickey).");
    await opener.flush();
    const stored = records(join(dir, "ssh-" + T0 + ".jsonl"));
    expect(stored.some(record => record.event === "auth.denied")).toBe(true);
    expect(stored.some(record => record.event === "queue_overflow")).toBe(true);
  });
});

describe("ssh capture window extension", () => {
  test("a tunnel spawned before an extension keeps recording until the extended expiry, and not after it", async () => {
    const { linkDirectory, dir } = fixture();
    let now = T0;
    startSshCapture({ linkDirectory, now: T0, minutes: 1 });
    const opener = createSshCaptureOpener({ linkDirectory, now: () => now });
    const spawn = opener("home", LINK)!;
    now = T0 + 30_000;
    startSshCapture({ linkDirectory, now, minutes: 2 });
    now = T0 + 70_000; // past the original 1:00 expiry, inside the extended 2:30 one
    spawn.stderrLine("Host key verification failed.");
    await opener.flush();
    now = T0 + 151_000; // past the extended expiry
    spawn.stderrLine("Host key verification failed.");
    await opener.flush();
    expect(records(join(dir, "ssh-" + T0 + ".jsonl")).map(record => record.at)).toEqual([T0 + 70_000]);
  });
});

describe("ssh capture retention", () => {
  test("files are deleted once retention passes after their last write, by status, start and the spawn path", () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    stopSshCapture(linkDirectory, T0);
    const old = join(dir, "ssh-" + (T0 - 1_000) + ".jsonl");
    const fresh = join(dir, "ssh-" + T0 + ".jsonl");
    const unrelated = join(dir, "notes.txt");
    for (const path of [old, fresh, unrelated]) writeFileSync(path, "{}\n", { mode: 0o600 });
    const lastWrite = new Date(T0);
    for (const path of [old, fresh, unrelated]) utimesSync(path, lastWrite, lastWrite);
    expect(readSshCaptureStatus(linkDirectory, T0 + SSH_CAPTURE_RETENTION_MS - 1).removed).toBe(0);
    expect(existsSync(old)).toBe(true);
    const status = readSshCaptureStatus(linkDirectory, T0 + SSH_CAPTURE_RETENTION_MS);
    expect(status.removed).toBe(2);
    expect(status.files).toEqual([]);
    expect(existsSync(old) || existsSync(fresh)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);

    writeFileSync(fresh, "{}\n", { mode: 0o600 });
    utimesSync(fresh, lastWrite, lastWrite);
    // A tunnel spawn applies retention too, even with capture off.
    expect(createSshCaptureOpener({ linkDirectory, now: () => T0 + SSH_CAPTURE_RETENTION_MS })("home", LINK)).toBeNull();
    expect(existsSync(fresh)).toBe(false);
  });

  test("the writer arms a retention timer that deletes the file it wrote", async () => {
    const { linkDirectory, dir } = fixture();
    let now = T0;
    const timers: Array<{ callback: () => void; ms: number }> = [];
    startSshCapture({ linkDirectory, now });
    const opener = createSshCaptureOpener({ linkDirectory, now: () => now,
      setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {} });
    opener("home", LINK)!.stderrLine("Host key verification failed.");
    await opener.flush();
    const path = join(dir, "ssh-" + T0 + ".jsonl");
    expect(existsSync(path)).toBe(true);
    // Armed for the file's own expiry (last write plus retention, one second late), never longer
    // than one retention period even when the file's clock runs ahead of this one.
    expect(timers.at(-1)!.ms).toBe(Math.min(Math.ceil(statSync(path).mtimeMs + SSH_CAPTURE_RETENTION_MS - T0) + 1_000, SSH_CAPTURE_RETENTION_MS + 1_000));
    utimesSync(path, new Date(T0), new Date(T0));
    now = T0 + SSH_CAPTURE_RETENTION_MS + 1_000;
    timers.at(-1)!.callback();
    expect(existsSync(path)).toBe(false);
  });

  test("after a restart, a process that never writes still deletes the file once retention passes", async () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    const writer = createSshCaptureOpener({ linkDirectory, now: () => T0, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {} });
    writer("home", LINK)!.stderrLine("Host key verification failed.");
    await writer.flush();
    stopSshCapture(linkDirectory, T0);
    const path = join(dir, "ssh-" + T0 + ".jsonl");
    utimesSync(path, new Date(T0), new Date(T0));
    for (const entry of ["startup", "spawn"] as const) {
      // The writing process is gone; a new one starts an hour later and writes nothing.
      let now = T0 + 3_600_000;
      const timers: Array<{ callback: () => void; ms: number }> = [];
      const restarted = createSshCaptureOpener({ linkDirectory, now: () => now,
        setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: () => {} });
      if (entry === "startup") restarted.retain();
      else expect(restarted("home", LINK)).toBeNull();
      expect(existsSync(path)).toBe(true);
      expect(timers.at(-1)?.ms).toBe(SSH_CAPTURE_RETENTION_MS - 3_600_000 + 1_000);
      if (entry === "spawn") {
        now = T0 + SSH_CAPTURE_RETENTION_MS + 1_000;
        timers.at(-1)!.callback();
        expect(existsSync(path)).toBe(false);
      }
    }
  });

  test("start keeps at most four files, deleting the oldest first", () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    stopSshCapture(linkDirectory, T0);
    for (let index = 1; index <= 5; index++) writeFileSync(join(dir, "ssh-" + (T0 - index * 60_000) + ".jsonl"), "{}\n", { mode: 0o600 });
    const status = startSshCapture({ linkDirectory, now: T0 + 1 });
    expect(status.removed).toBe(5 - (SSH_CAPTURE_MAX_FILES - 1));
    expect(readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort()).toEqual(
      [3, 2, 1].map(index => "ssh-" + (T0 - index * 60_000) + ".jsonl"));
  });
});

describe("ssh capture storage boundaries", () => {
  test.skipIf(process.platform === "win32")("directory, control and capture files are owner-only", async () => {
    const { linkDirectory, dir } = fixture();
    mkdirSync(linkDirectory, { mode: 0o755 });
    mkdirSync(dir, { mode: 0o755 });
    startSshCapture({ linkDirectory, now: T0 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "control.json")).mode & 0o777).toBe(0o600);
    const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
    chmodSync(dir, 0o700);
    opener("home", LINK)!.stderrLine("Host key verification failed.");
    await opener.flush();
    expect(statSync(join(dir, "ssh-" + T0 + ".jsonl")).mode & 0o777).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("a control file others can write, or a shared directory, keeps capture off", () => {
    const { linkDirectory, dir } = fixture();
    startSshCapture({ linkDirectory, now: T0 });
    chmodSync(join(dir, "control.json"), 0o622);
    expect(readSshCaptureControl(dir, T0)).toBeNull();
    chmodSync(join(dir, "control.json"), 0o600);
    chmodSync(dir, 0o777);
    expect(readSshCaptureControl(dir, T0)).toBeNull();
  });

  test.skipIf(process.platform === "win32")("symlinks are refused and their targets left untouched", async () => {
    const { configDir, linkDirectory, dir } = fixture();
    // A symlinked control file never enables capture.
    startSshCapture({ linkDirectory, now: T0 });
    stopSshCapture(linkDirectory, T0);
    const foreignControl = join(configDir, "foreign-control.json");
    writeFileSync(foreignControl, JSON.stringify({ version: 1, startedAt: T0, expiresAt: T0 + 60_000 }), { mode: 0o600 });
    symlinkSync(foreignControl, join(dir, "control.json"));
    expect(readSshCaptureControl(dir, T0)).toBeNull();
    // Stop removes the planted link itself, never its target.
    stopSshCapture(linkDirectory, T0);
    expect(existsSync(join(dir, "control.json"))).toBe(false);
    expect(readFileSync(foreignControl, "utf8")).toContain("startedAt");

    // A capture file planted as a symlink is never written through.
    startSshCapture({ linkDirectory, now: T0 });
    const target = join(configDir, "foreign.log");
    writeFileSync(target, "preserve");
    symlinkSync(target, join(dir, "ssh-" + T0 + ".jsonl"));
    const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
    opener("home", LINK)!.stderrLine("Host key verification failed.");
    await opener.flush();
    expect(readFileSync(target, "utf8")).toBe("preserve");
    expect(pruneSshCapture(dir, T0 + SSH_CAPTURE_RETENTION_MS * 2)).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("preserve");

    // A symlinked capture directory is refused by start and ignored by the runtime.
    const other = fixture();
    const elsewhere = join(other.configDir, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(other.linkDirectory, { mode: 0o700 });
    symlinkSync(elsewhere, other.dir);
    expect(() => startSshCapture({ linkDirectory: other.linkDirectory, now: T0 })).toThrow("not a plain directory");
    writeFileSync(join(elsewhere, "control.json"), JSON.stringify({ version: 1, startedAt: T0, expiresAt: T0 + 60_000 }), { mode: 0o600 });
    expect(createSshCaptureOpener({ linkDirectory: other.linkDirectory, now: () => T0 })("home", LINK)).toBeNull();
    expect(readdirSync(elsewhere)).toEqual(["control.json"]);
  });

  test("Windows hardens the directory, control file and capture file with the private ACL helpers", async () => {
    const { linkDirectory, dir } = fixture();
    const grants: string[] = [];
    const icacls = (args: readonly string[]) => {
      if (args.includes("/grant:r")) grants.push(args[0]!);
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    };
    const principal = { success: true, exitCode: 0, timedOut: false, stdout: "S-1-5-21-1-2-3-1001\nTEST\\user\n" };
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    setWindowsPrincipalRunnerForTests(() => principal);
    setAsyncWindowsPrincipalRunnerForTests(async () => principal);
    setIcaclsRunnerForTests(icacls);
    setAsyncIcaclsRunnerForTests(async args => icacls(args));
    try {
      startSshCapture({ linkDirectory, now: T0 });
      expect(grants).toContain(dir);
      expect(grants).toContain(join(dir, "control.json"));
      const opener = createSshCaptureOpener({ linkDirectory, now: () => T0 });
      opener("home", LINK)!.stderrLine("Host key verification failed.");
      await opener.flush();
      expect(grants).toContain(join(dir, "ssh-" + T0 + ".jsonl"));
      expect(records(join(dir, "ssh-" + T0 + ".jsonl"))).toHaveLength(1);
    } finally {
      setAsyncIcaclsRunnerForTests(null);
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      setAsyncWindowsPrincipalRunnerForTests(null);
      setWindowsPrincipalRunnerForTests(null);
      resetWindowsPrincipalForTests();
      resetHardenedStateForTests();
    }
  });

  test("a failed Windows ACL refuses to publish the capture window", () => {
    const { linkDirectory, dir } = fixture();
    const principal = { success: true, exitCode: 0, timedOut: false, stdout: "S-1-5-21-1-2-3-1001\nTEST\\user\n" };
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    setWindowsPrincipalRunnerForTests(() => principal);
    setIcaclsRunnerForTests(() => ({ success: false, exitCode: 5, timedOut: false, stdout: "" }));
    try {
      expect(() => startSshCapture({ linkDirectory, now: T0 })).toThrow();
      expect(existsSync(join(dir, "control.json"))).toBe(false);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      setWindowsPrincipalRunnerForTests(null);
      resetWindowsPrincipalForTests();
      resetHardenedStateForTests();
    }
  });
});

