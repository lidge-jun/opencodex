import { describe, expect, test } from "bun:test";
import { ptr, toArrayBuffer } from "bun:ffi";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { inspectDesktopRecovery, parseRecoveryAnswer, recoveryHomeIdentity,
  type DesktopRecoveryIo } from "../../src/service/desktop-recovery";
import { linuxRecoveryBirth, linuxRecoveryListeners, linuxRecoverySocket, macRecoveryPaths, macRecoveryRequirement,
  parseMacRecoveryPath, recoveryImageCandidate, recoverySibling, verifyMacRecoveryImage } from "../../src/service/desktop-recovery-process";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const instance = "a".repeat(32);
const endpoint = { pid: 123, port: 12345 };
const native = { pid: 123, born: "98765", image: "device:inode", app: "/trusted/opencodex-desktop" };
const image = { app: native.app, cli: "/trusted/ocx", image: native.image, trusted: true };
const home = "/fixture/config";
const response = (nonce: string, state = "recovering", scope: string | null = home) =>
  `ocx-desktop-recovery-v1 ${nonce} ${instance} 123 ${state} ${scope === null ? "-" : Buffer.from(scope).toString("hex")}\n`;

function fixture(changes: Partial<DesktopRecoveryIo> = {}): DesktopRecoveryIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, images: () => [image], processes: () => [native], home: () => home, now: () => 0,
    listeners: () => { calls.push("listeners"); return [endpoint.port]; },
    open: async () => ({ connection: { serverPort: endpoint.port, clientPort: 54321 },
      ask: async nonce => { calls.push(nonce); return response(nonce); }, close: () => { calls.push("closed"); } }),
    owner: () => { calls.push("owner"); return "socket-inode"; }, ...changes,
  };
}

function macPathLibrary(path: string | null = null) {
  // A delayed errno read need not retain the failed call's ESRCH. This valid pointer models
  // that observation; it does not claim to reproduce native macOS FFI behavior on other hosts.
  const delayedErrno = new Int32Array([0]);
  const calls: number[] = [];
  return {
    calls, closes: 0,
    symbols: {
      proc_pidpath(pid: number, buffer: ReturnType<typeof ptr>, length: number) {
        calls.push(pid);
        return path === null ? 0 : new TextEncoder().encodeInto(path, new Uint8Array(toArrayBuffer(buffer, 0, length))).written;
      },
      __error: () => ptr(delayedErrno),
    },
    close() { this.closes++; },
  };
}

describe("native Desktop recovery evidence", () => {
  test("two fresh challenges bind the same accepted socket and live native incarnation", async () => {
    const io = fixture();
    expect(await inspectDesktopRecovery(io)).toEqual({ kind: "recovering" });
    const nonces = io.calls.filter(call => /^[0-9a-f]{64}$/.test(call));
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(io.calls.filter(call => call === "owner")).toHaveLength(2);
    expect(io.calls.at(-1)).toBe("closed");
  });

  test("renamed unrelated processes and attacker locators cannot invent an anchored installation", async () => {
    for (const changes of [{ images: () => [] }, { processes: () => [] }]) {
      const io = fixture({ ...changes, listeners: () => { throw new Error("unrelated listeners must not be read"); } });
      expect(await inspectDesktopRecovery(io)).toEqual({ kind: "none" });
      expect(io.calls).toEqual([]);
    }
  });

  test("a live independently identified app with unavailable evidence refuses without trusting discovery", async () => {
    for (const changes of [
      { images: () => [{ ...image, trusted: false }] },
      { processes: () => { throw new Error("OS process read denied"); } },
      { listeners: () => [] },
      { open: async () => { throw new Error("refused"); } },
      { owner: () => { throw new Error("foreign socket"); } },
    ]) expect(await inspectDesktopRecovery(fixture(changes))).toEqual({ kind: "unknown" });
  });

  test("a structurally unsupported image reports the platform limit, not conflicting evidence", async () => {
    expect(await inspectDesktopRecovery(fixture({ images: () => [{ ...image, trusted: false, unsupported: true }] })))
      .toEqual({ kind: "unknown", unsupported: true });
    expect(await inspectDesktopRecovery(fixture({ images: () => [{ ...image, trusted: false }] })))
      .toEqual({ kind: "unknown" });
  });

  test("a Windows candidate earns the platform mark only from complete stable observations", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-recovery-win-")));
    const cli = join(root, "ocx.exe"), app = join(root, "opencodex-desktop.exe");
    writeFileSync(cli, "cli"); writeFileSync(app, "app");
    chmodSync(cli, 0o755); chmodSync(app, 0o755);
    const sibling = () => app;
    const nativeAt = (image: { app: string; image: string }) => [{ pid: 123, born: "1", image: image.image, app: image.app }];
    try {
      const stable = recoveryImageCandidate({ cli, app, rootOnly: false }, "win32", undefined, { sibling });
      expect(stable).toMatchObject({ app, cli, trusted: false, unsupported: true });
      expect(await inspectDesktopRecovery(fixture({ images: () => [stable], processes: () => nativeAt(stable) })))
        .toEqual({ kind: "unknown", unsupported: true });

      // Identity drift on either selected file is conflicting evidence, never a platform limit.
      for (const changed of [app, cli]) {
        let observations = 0;
        const drifted = recoveryImageCandidate({ cli, app, rootOnly: false }, "win32", undefined,
          { sibling, identify: path => `${path}:${path === changed ? ++observations : 0}` });
        expect(drifted.trusted).toBe(false);
        expect(drifted.unsupported).toBeUndefined();
        expect(await inspectDesktopRecovery(fixture({ images: () => [drifted], processes: () => nativeAt(drifted) })))
          .toEqual({ kind: "unknown" });
      }

      // A thrown observation keeps the derived path but never the platform mark.
      const missing = recoveryImageCandidate({ cli: join(root, "gone-ocx.exe"), app, rootOnly: false }, "win32", undefined, { sibling });
      expect(missing.trusted).toBe(false);
      expect(missing.unsupported).toBeUndefined();
      expect(await inspectDesktopRecovery(fixture({ images: () => [missing], processes: () => nativeAt(missing) })))
        .toEqual({ kind: "unknown" });

      // A file replaced after the stability check is never adopted as the verified identity:
      // the image keeps the compared value, and the consumer's later B observation refuses.
      let appReads = 0;
      const replaced = recoveryImageCandidate({ cli, app, rootOnly: false }, "win32", undefined,
        { sibling, identify: path => path === app ? (++appReads <= 2 ? "verified-A" : "replaced-B") : "stable-cli" });
      expect(replaced).toMatchObject({ image: "verified-A", trusted: false, unsupported: true });
      expect(await inspectDesktopRecovery(fixture({
        images: () => [replaced],
        processes: () => [{ pid: 123, born: "1", image: "replaced-B", app }],
      }))).toEqual({ kind: "unknown" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the accepted socket owner is proven before any protocol wait", async () => {
    const io = fixture({ owner: () => { throw new Error("foreign accepted socket"); } });
    expect(await inspectDesktopRecovery(io)).toEqual({ kind: "unknown" });
    expect(io.calls.filter(call => /^[0-9a-f]{64}$/.test(call))).toEqual([]);
    expect(io.calls.at(-1)).toBe("closed");
  });

  test("each actual native listener gets a bounded probe and cannot hide another owned endpoint", async () => {
    let now = 0;
    const budgets: number[] = [];
    const io = fixture({ now: () => now, listeners: () => [12344, 12345], open: async (candidate, budget) => {
      budgets.push(budget);
      if (candidate.port === 12344) { now += budget; throw new Error("different native endpoint"); }
      return { connection: { serverPort: candidate.port, clientPort: 54321 },
        ask: async nonce => response(nonce, "recovering", "/other/config"), close() {} };
    } });
    expect(await inspectDesktopRecovery(io)).toEqual({ kind: "none" });
    expect(budgets).toEqual([750, 750]);
  });

  test("stale PID incarnation, replaced image, changed accepted socket and disappearing app refuse", async () => {
    for (const replacement of [{ ...native, born: "reused" }, { ...native, image: "replacement" }, null]) {
      let reads = 0;
      const io = fixture({ processes: () => ++reads === 1 ? [native] : replacement ? [replacement] : [] });
      expect(await inspectDesktopRecovery(io)).toEqual({ kind: "unknown" });
      expect(io.calls.at(-1)).toBe("closed");
    }
    let reads = 0;
    expect(await inspectDesktopRecovery(fixture({ owner: () => String(++reads) }))).toEqual({ kind: "unknown" });
  });

  test("a late proof does not outlive the shared probe budget", async () => {
    let now = 0, closed = false;
    const io = fixture({ now: () => now, open: async () => ({ connection: { serverPort: 1, clientPort: 2 },
      ask: async nonce => { now = 8_001; return response(nonce); }, close: () => { closed = true; } }) });
    expect(await inspectDesktopRecovery(io)).toEqual({ kind: "unknown" });
    expect(closed).toBe(true);
  });

  test("current Stop intent wins; an unresolved or changing home is not an absence", async () => {
    for (const [state, scope, expected] of [
      ["stopped", home, "stopped"], ["unknown", null, "unknown"], ["recovering", "/another/config", "none"],
    ] as const) {
      const io = fixture({ open: async () => ({ connection: { serverPort: 1, clientPort: 2 },
        ask: async nonce => response(nonce, state, scope), close() {} }) });
      expect(await inspectDesktopRecovery(io)).toEqual({ kind: expected });
    }
    let reads = 0;
    expect(await inspectDesktopRecovery(fixture({ open: async () => ({ connection: { serverPort: 1, clientPort: 2 },
      ask: async nonce => response(nonce, "recovering", ++reads === 1 ? home : "/another/config"), close() {} }) })))
      .toEqual({ kind: "unknown" });
  });

  test("a challenge from another request, native instance or PID is not evidence", () => {
    const nonce = "b".repeat(64);
    for (const value of [response("c".repeat(64)), response(nonce).replace(instance, "d".repeat(32)),
      response(nonce).replace(" 123 ", " 124 "), response(nonce) + "extra\n", response(nonce).replace("recovering", "absent")]) {
      expect(() => parseRecoveryAnswer(value, nonce, endpoint, instance)).toThrow();
    }
    expect(parseRecoveryAnswer(response(nonce), nonce, endpoint).home).toBe(home);
    let answers = 0;
    const io = fixture({ open: async () => ({ connection: { serverPort: 1, clientPort: 2 },
      ask: async request => response(request).replace(instance, ++answers === 1 ? instance : "e".repeat(32)), close() {} }) });
    return expect(inspectDesktopRecovery(io)).resolves.toEqual({ kind: "unknown" });
  });

  test("macOS failed kernel path skips a real reaped process despite unavailable delayed errno", async () => {
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 1_000, killSignal: "SIGKILL",
    });
    const library = macPathLibrary(), paths = macRecoveryPaths(library);
    try {
      expect(await child.exited).toBe(0);
      expect(paths.read(child.pid)).toBeNull();
      const io = fixture({ processes: () => paths.read(child.pid) === null ? [] : [native] });
      expect(await inspectDesktopRecovery(io)).toEqual({ kind: "none" });
      expect(io.calls).toEqual([]);
      expect(library.calls).toEqual([child.pid, child.pid]);
    } finally {
      paths.close();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    expect(library.closes).toBe(1);
  });

  test("macOS failed kernel path stays unknown for a real live process", async () => {
    const library = macPathLibrary(), paths = macRecoveryPaths(library);
    try {
      expect(() => paths.read(process.pid)).toThrow("kernel image path unavailable");
      const io = fixture({ processes: () => paths.read(process.pid) === null ? [] : [native] });
      expect(await inspectDesktopRecovery(io)).toEqual({ kind: "unknown" });
      expect(io.calls).toEqual([]);
    } finally { paths.close(); }
    expect(library.closes).toBe(1);
  });

  test.each(["EPERM", "EACCES", "ENOSYS", undefined])("macOS failed kernel path keeps probe error %s unknown", async code => {
    const library = macPathLibrary(), probes: [number, number][] = [];
    const paths = macRecoveryPaths(library, (pid, signal) => {
      probes.push([pid, signal]);
      throw Object.assign(new Error("process observation unavailable"), { code });
    });
    try {
      const io = fixture({ processes: () => paths.read(native.pid) === null ? [] : [native] });
      expect(await inspectDesktopRecovery(io)).toEqual({ kind: "unknown" });
      expect(io.calls).toEqual([]);
      expect(probes).toEqual([[native.pid, 0]]);
    } finally { paths.close(); }
    expect(library.closes).toBe(1);
  });

  test("macOS successful kernel path is parsed without probing process liveness", () => {
    const path = "/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop";
    const library = macPathLibrary(path);
    let probes = 0;
    const paths = macRecoveryPaths(library, () => { probes++; throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    try {
      expect(paths.read(native.pid)).toBe(path);
      expect(library.calls).toEqual([native.pid]);
      expect(probes).toBe(0);
    } finally { paths.close(); }
    expect(library.closes).toBe(1);
  });

  test("macOS kernel path rejects invalid PIDs before native calls or process-group probes", () => {
    const library = macPathLibrary();
    let probes = 0;
    const paths = macRecoveryPaths(library, () => { probes++; });
    try {
      for (const pid of [0, -1, 1.5, NaN, Infinity, 0x80000000, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => paths.read(pid)).toThrow("unverified process PID");
      }
      expect(library.calls).toEqual([]);
      expect(probes).toBe(0);
    } finally { paths.close(); }
    expect(library.closes).toBe(1);
  });

  test("macOS kernel paths are bounded and dynamic validation requires the selected code hashes", () => {
    const bytes = new Uint8Array(4096), path = "/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop";
    const length = new TextEncoder().encodeInto(path, bytes).written;
    expect(parseMacRecoveryPath(bytes, length)).toBe(path);
    for (const invalid of [0, -1, length - 1, length + 1, bytes.length]) expect(() => parseMacRecoveryPath(bytes, invalid)).toThrow();
    const invalidUtf8 = new Uint8Array([47, 255, 0]);
    expect(() => parseMacRecoveryPath(invalidUtf8, 2)).toThrow();
    const a = "a".repeat(40), b = "b".repeat(40), calls: string[][] = [];
    const requirement = macRecoveryRequirement(path, (_command, args, _env, stderr) => {
      expect(stderr).toBe(true);
      return `Executable=${path}\nCDHash=${args.includes("arm64") ? a : b}\n`;
    });
    expect(requirement).toBe(`=cdhash H"${a}" or cdhash H"${b}"`);
    verifyMacRecoveryImage(123, requirement, (command, args) => { expect(command).toBe("/usr/bin/codesign"); calls.push(args); return ""; });
    expect(calls).toEqual([["--verify", "--strict", "-R", requirement, "123"]]);
    expect(() => verifyMacRecoveryImage(123, requirement, () => { throw new Error("mapped image has a different cdhash"); })).toThrow();
    expect(() => macRecoveryRequirement(path, () => "CDHash=invalid")).toThrow();
    expect(() => verifyMacRecoveryImage(123, undefined, () => "")).toThrow();
  });

  test("installation layouts derive only a canonical sibling, and Windows homes normalize verbatim prefixes", () => {
    expect(recoverySibling("/Applications/OpenCodex.app/Contents/MacOS/ocx", "darwin")).toBe("/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop");
    expect(recoverySibling("/tmp/ocx", "darwin")).toBeNull();
    expect(recoverySibling("/usr/bin/bun", "linux")).toBeNull();
    expect(recoverySibling("ocx", "linux")).toBeNull();
    expect(recoveryHomeIdentity("\\\\?\\C:\\Users\\Fixture\\config", "win32")).toBe(recoveryHomeIdentity("C:\\Users\\Fixture\\config", "win32"));
    expect(recoveryHomeIdentity("/case/Sensitive", "linux")).toBe("/case/Sensitive");
  });

  test("Linux uses the start field after comm and the exact accepted socket tuple", () => {
    expect(linuxRecoveryBirth(`123 (name ) with spaces) ${["S", ...Array.from({ length: 18 }, () => "1"), "98765"].join(" ")}`)).toBe("98765");
    const row = " 0: 0100007F:3039 0100007F:D431 01 00000000:00000000 00:00000000 00000000 1000 0 777 1";
    expect(linuxRecoverySocket(row, { serverPort: 12345, clientPort: 54321 })).toBe("777");
    expect(linuxRecoverySocket(row.replace(" 01 ", " 0A "), { serverPort: 12345, clientPort: 54321 })).toBeNull();
    expect(linuxRecoverySocket(row, { serverPort: 12345, clientPort: 54322 })).toBeNull();
    expect(linuxRecoverySocket(`${row}\n${row}`, { serverPort: 12345, clientPort: 54321 })).toBeNull();
    const listener = row.replace("0100007F:D431 01", "00000000:0000 0A");
    expect(linuxRecoveryListeners(listener, new Set(["777"]))).toEqual([12345]);
    expect(linuxRecoveryListeners(listener, new Set(["other-process-inode"]))).toEqual([]);
    expect(linuxRecoveryListeners(listener.replace("0100007F", "00000000"), new Set(["777"]))).toEqual([]);
  });
});

// The Rust unit tests run in the native CI job. This Linux integration additionally executes
// the same producer and an actually compiled Bun consumer, without injecting any process proof.
test.skipIf(process.platform !== "linux" || !Bun.which("rustc"))("compiled bundled CLI verifies real native recovery and ignores a protocol-speaking renamed outsider", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-recovery-native-"));
  const appConfig = join(root, "xdg", "com.opencodex.desktop"), config = join(root, "config");
  const state = join(root, "state"), app = join(root, "opencodex-desktop"), cli = join(root, "ocx");
  mkdirSync(appConfig, { recursive: true }); mkdirSync(config); mkdirSync(join(config, "other")); chmodSync(root, 0o700);
  writeFileSync(state, "recovering");
  const rust = `#[path = ${JSON.stringify(repoPath("desktop", "src-tauri", "src", "recovery_presence.rs"))}] mod recovery_presence;
fn main() { let args: Vec<String> = std::env::args().collect(); let home = std::path::PathBuf::from(&args[2]); let state = args[3].clone();
let _presence = recovery_presence::Presence::start("a".repeat(32), std::sync::Arc::new(move || {
let state = std::fs::read_to_string(&state).unwrap(); recovery_presence::Snapshot { home: if state == "unknown" { None } else if state == "other" { Some(home.join("other")) } else { Some(home.clone()) }, wanted: state != "stopped" } })).unwrap();
println!("ready");
std::thread::park(); }`;
  const entry = join(root, "probe.ts"), nativeSource = join(root, "native.rs");
  writeFileSync(nativeSource, rust);
  writeFileSync(entry, `import { inspectDesktopRecovery } from ${JSON.stringify(repoPath("src", "service", "desktop-recovery.ts"))};
import { runDesktopColdStart, productionDesktopColdStartDeps } from ${JSON.stringify(repoPath("src", "cli", "ensure-desktop-cold-start.ts"))};
const evidence = await inspectDesktopRecovery(); const result = await runDesktopColdStart({ ...productionDesktopColdStartDeps(async () => ({ fixture: true })), desktopRecovery: async () => evidence, info: () => {} });
console.log(JSON.stringify({ evidence, result }));`);
  // The preload sandboxes HOME; rustup must still find the installed toolchain (#7884).
  const realHome = process.env.OCX_REAL_HOME?.trim() || userInfo().homedir;
  const rustEnv = { ...process.env,
    RUSTUP_HOME: process.env.RUSTUP_HOME || join(realHome, ".rustup"),
    CARGO_HOME: process.env.CARGO_HOME || join(realHome, ".cargo"),
  };
  // Hosted runs killed rustc at 30s while other heads passed. Keep a bounded
  // real-child budget and report the compiler's output rather than only a null/1 exit.
  const rustBuild = Bun.spawnSync([Bun.which("rustc")!, "--edition=2021", nativeSource, "-o", app], { env: rustEnv, stdout: "pipe", stderr: "pipe", timeout: SPAWN_BUDGET_MS });
  expect(rustBuild.exitCode, `rustc (signal=${rustBuild.signal}):\n${rustBuild.stderr.toString()}${rustBuild.stdout.toString()}`).toBe(0);
  const build = Bun.spawnSync([process.execPath, "build", "--compile", entry, "--outfile", cli], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(build.exitCode, `bun build (signal=${build.signal}):\n${build.stderr.toString()}${build.stdout.toString()}`).toBe(0);
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "xdg"), OPENCODEX_HOME: config };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const foreignSockets: Socket[] = [];
  const foreign = createServer(socket => { foreignSockets.push(socket); });
  await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
  const foreignPort = (foreign.address() as { port: number }).port;
  const start = async (executable: string) => {
    child = Bun.spawn([executable, appConfig, config, state], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n"); }
    finally { reader.releaseLock(); }
  };
  const stop = async () => { child?.kill(); await child?.exited; child = undefined; };
  const probe = async () => {
    const result = Bun.spawn([cli], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const [stdout, exitCode] = await Promise.all([new Response(result.stdout).text(), result.exited]);
    expect(exitCode).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  };
  try {
    // Prove that this server observes a real foreign connection before using its absence.
    const accepted = new Promise<Socket>(resolve => foreign.once("connection", resolve));
    const control = connect({ host: "127.0.0.1", port: foreignPort });
    (await accepted).destroy(); control.destroy();
    expect(foreignSockets).toHaveLength(1);
    foreignSockets.length = 0;
    await start(app);
    expect(await probe()).toEqual({ evidence: { kind: "recovering" }, result: { kind: "live", live: { fixture: true } } });
    // Files naming the real PID and a foreign silent endpoint cannot consume its proof budget,
    // including enough malformed records to have crowded out a legacy locator reader.
    for (let index = 0; index < 80; index++) {
      const instance = index.toString(16).padStart(32, "0");
      writeFileSync(join(appConfig, `recovery-${child!.pid}-${instance}.json`), index < 40 ? "{" : JSON.stringify({ version: 1, pid: child!.pid, port: foreignPort, instance }));
    }
    writeFileSync(state, "other");
    expect(await probe()).toEqual({ evidence: { kind: "none" }, result: { kind: "cli" } });
    expect(foreignSockets).toHaveLength(0);
    writeFileSync(state, "recovering");
    expect((await probe()).evidence).toEqual({ kind: "recovering" });
    writeFileSync(state, "stopped");
    expect((await probe()).evidence).toEqual({ kind: "stopped" });
    expect((await probe()).result.kind).toBe("failed");
    writeFileSync(state, "unknown");
    expect((await probe()).evidence).toEqual({ kind: "unknown" });
    writeFileSync(state, "recovering");
    const saved = join(root, "saved-native");
    copyFileSync(app, saved); unlinkSync(app);
    expect((await probe()).evidence).toEqual({ kind: "unknown" });
    symlinkSync(saved, app);
    expect((await probe()).evidence).toEqual({ kind: "unknown" });
    unlinkSync(app); mkdirSync(app);
    expect((await probe()).evidence).toEqual({ kind: "unknown" });
    rmSync(app, { recursive: true });
    copyFileSync(saved, app); chmodSync(app, 0o700);
    expect((await probe()).evidence).toEqual({ kind: "unknown" });
    await stop();
    unlinkSync(app);
    expect(await probe()).toEqual({ evidence: { kind: "none" }, result: { kind: "cli" } });
    copyFileSync(saved, app); chmodSync(app, 0o700);
    // Reuse the exact producer protocol from a different installation.
    // It is still no authority over this CLI merely because its basename matches Desktop.
    const outsider = join(root, "unrelated", "opencodex-desktop");
    mkdirSync(join(root, "unrelated")); copyFileSync(app, outsider); chmodSync(outsider, 0o700);
    writeFileSync(state, "recovering"); await start(outsider);
    expect(await probe()).toEqual({ evidence: { kind: "none" }, result: { kind: "cli" } });
  } finally {
    await stop(); foreignSockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => foreign.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, SPAWN_BUDGET_MS + 30_000);
