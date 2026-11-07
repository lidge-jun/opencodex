import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, ptr, read, toBuffer } from "bun:ffi";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath } from "../helpers/repo-root";
import { queryWindowsFixtureObjectName } from "../fixtures/windows-cli-child-object-name";
import { WindowsChildNative, securityAttributes, wide, WIN64_CHILD_ABI } from "../../src/codex/windows-cli-child-native";
import { WindowsChildPipe } from "../../src/codex/windows-cli-child-pipe";
import { cleanupUnstartedWindowsChild, startWindowsCliChildWithNative, windowsCliChildPolicy,
  type WindowsCliChild, type WindowsCliChildInvocation, type WindowsCliChildPolicy } from "../../src/codex/windows-cli-child";

const windows = process.platform === "win32" && process.arch === "x64";
const directory = mkdtempSync(join(tmpdir(), "ocx-native-child-"));
const owners: WindowsCliChild[] = [];
let sequence = 0;
const path = () => join(directory, `fixture-${++sequence}`);
const invocation = (args: string[], policy: WindowsCliChildPolicy = "pack"): WindowsCliChildInvocation => ({
  executable: process.execPath, args: [fixturePath("windows-cli-child.ts"), ...args], cwd: directory, env: process.env, policy,
});
function launch(args: string[], policy: WindowsCliChildPolicy = "pack", native = new WindowsChildNative()) {
  const child = startWindowsCliChildWithNative(invocation(args, policy), native); owners.push(child); return child;
}
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("fixture condition deadline"); await Bun.sleep(5); }
}
async function finish(child: WindowsCliChild) {
  const result = child.process ? await child.wait() : (await cleanupUnstartedWindowsChild(child), null);
  expect(child.native.handles.size).toBe(0); expect(child.native.closeErrors).toEqual([]);
  expect(child.native.borrowedMemory.size).toBe(0);
  return result;
}
afterAll(async () => {
  // These are task-owned gates and exact original process/Job handles only.
  for (let i = 1; i <= sequence; i++) writeFileSync(join(directory, `fixture-${i}`), "release");
  for (const child of owners) {
    if (!child.native.handles.size) continue;
    if (child.setupFailure) child.reapUnstarted();
    const result = child.process ? await child.wait() : (await cleanupUnstartedWindowsChild(child), { terminal: true });
    if (!result.terminal || child.native.handles.size) throw new Error(`owned fixture not reaped: pid=${child.pid} start=${child.creationTime} handles=${child.native.handles.size}`);
  }
  rmSync(directory, { recursive: true });
});

describe("Windows child policy", () => {
  test("installer/pack have no deadline, active-process cap, abort kill, or kill-on-close", () => {
    for (const kind of ["installer", "pack"] as const) {
      expect(windowsCliChildPolicy(kind)).toEqual({ captureBytes: kind === "pack" ? 1048576 : 0,
        deadlineMs: null, reapMs: null, terminate: false });
    }
    expect(windowsCliChildPolicy("version")).toEqual({ captureBytes: 16384, deadlineMs: 8000, reapMs: 1000, terminate: true });
    // Accounting is a count, not a bounded PID array. No 32-process fanout fixture.
    const accounting = Buffer.alloc(WIN64_CHILD_ABI.jobAccounting);
    accounting.writeUInt32LE(4096, WIN64_CHILD_ABI.activeProcesses);
    expect(accounting.readUInt32LE(40)).toBe(4096);
  });
});

describe.skipIf(!windows)("Windows x64 actual owned native child", () => {
  test("ABI layouts feed real native calls, preserve argv/UTF-8, original handles and exit 259", async () => {
    expect(WIN64_CHILD_ABI).toMatchObject({ startupInfo: 104, startupInfoEx: 112, attributes: 104,
      securityAttributes: 24, processInformation: 24, overlapped: 32, event: 24, jobAccounting: 48, activeProcesses: 40 });
    const args = ["space value", 'quoted"value', "trailing\\", "", "한글🙂", "a\\\\\"b"];
    const argv = launch(["args", ...args]);
    expect(argv.setupFailure).toBeNull(); expect(BigInt(argv.creationTime!)).toBeGreaterThan(0n);
    const extra = dlopen("kernel32.dll", { GetProcessId: { args: ["u64"], returns: "u32" } });
    expect(extra.symbols.GetProcessId!(argv.process)).toBe(argv.pid); extra.close();
    expect(JSON.parse((await finish(argv))!.stdout)).toEqual(args);
    expect((await finish(launch(["unicode"])))!.stdout).toBe("한글🙂終");
    const exit = (await finish(launch(["exit259"])))!;
    expect(exit.terminal).toBe(true); expect(exit.exitCode).toBe(259);
    expect(argv.observe()).toEqual({ terminal: true, exitCode: 0, unknown: false });
    expect((await argv.wait()).terminal).toBe(true); expect(argv.reapUnstarted()).toBe(false);
  });

  test("Unicode environment is explicit, ordinally sorted and rejects case aliases before CreateProcess", async () => {
    const native = new WindowsChildNative();
    const child = startWindowsCliChildWithNative({ ...invocation(["env", "Z", "a", "한글", "EMPTY", "MISSING"]),
      env: { Z: "last", a: "first", "한글": "값🙂", EMPTY: "" } }, native); owners.push(child);
    expect(JSON.parse((await finish(child))!.stdout)).toEqual(["last", "first", "값🙂", "", null]);
    const marker = path(), invalid = startWindowsCliChildWithNative({ ...invocation(["marker", marker]),
      env: { Path: "first", PATH: "second" } }, new WindowsChildNative()); owners.push(invalid);
    expect(invalid.setupFailure).toBe("windows_child_invalid_environment"); expect(invalid.process).toBe(0n);
    await finish(invalid); expect(existsSync(marker)).toBe(false);
  });

  test("real named pipe has a protected single-principal DACL, rejects remote clients and uses overlapped mode", async () => {
    const native = new WindowsChildNative(), pipe = new WindowsChildPipe(native);
    const extra = dlopen("advapi32.dll", {
      GetSecurityDescriptorControl: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
      GetSecurityDescriptorDacl: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    });
    const create = native.k.CreateNamedPipeW!;
    native.k.CreateNamedPipeW = (...args) => {
      expect(args[1]).toBe(0x40080001); expect(args[2]).toBe(8); expect(args[3]).toBe(1);
      const sa = toBuffer(args[7]!, 0, 24), descriptor = sa.readBigUInt64LE(8);
      expect(sa.readUInt32LE()).toBe(24); expect(sa.readUInt32LE(16)).toBe(0); expect(descriptor).not.toBe(0n);
      const control = Buffer.alloc(2), revision = Buffer.alloc(4), present = Buffer.alloc(4), acl = Buffer.alloc(8), defaulted = Buffer.alloc(4);
      expect(extra.symbols.GetSecurityDescriptorControl!(descriptor, ptr(control), ptr(revision))).toBe(1);
      expect(control.readUInt16LE() & 0x1000).toBe(0x1000); // SE_DACL_PROTECTED
      expect(extra.symbols.GetSecurityDescriptorDacl!(descriptor, ptr(present), ptr(acl), ptr(defaulted))).toBe(1);
      expect(present.readUInt32LE()).toBe(1); expect(defaulted.readUInt32LE()).toBe(0);
      expect(read.u16(acl.readBigUInt64LE(), 4)).toBe(1); // One allow ACE, not a default ACL.
      return create(...args);
    };
    try { pipe.open(); } finally { await pipe.dispose(); extra.close(); }
    expect(native.handles.size).toBe(0); expect(native.dispose()).toBe(true);
  });

  test("two overlapping owned setups whitelist their own stdio and exclude a foreign inheritable file by identity", async () => {
    const first = new WindowsChildNative(), second = new WindowsChildNative();
    const extra = dlopen("kernel32.dll", { GetHandleInformation: { args: ["u64", "ptr"], returns: "i32" } });
    const inheritance = (handle: bigint) => {
      const flags = Buffer.alloc(4);
      expect(extra.symbols.GetHandleInformation!(handle, ptr(flags))).toBe(1);
      return flags.readUInt32LE() & 1;
    };
    const sentinelPath = path(); writeFileSync(sentinelPath, "foreign-sentinel");
    const attributes = securityAttributes(true);
    const sentinel = first.keep(first.k.CreateFileW!(ptr(wide(sentinelPath)), 0x80000000, 3, ptr(attributes), 3, 0, 0n));
    const sentinelName = queryWindowsFixtureObjectName(sentinel)!; expect(sentinelName).toBeString();
    const firstAudit = path(), secondAudit = path();
    const lists: bigint[][] = [[], []];
    for (const [index, native] of [first, second].entries()) {
      const original = native.k.UpdateProcThreadAttribute!;
      native.k.UpdateProcThreadAttribute = (...args) => {
        expect(args[2]).toBe(0x20002n); expect(args[4]).toBe(24n);
        lists[index] = [0, 8, 16].map(offset => read.u64(args[3]!, offset));
        return original(...args);
      };
      const resume = native.k.ResumeThread!;
      native.k.ResumeThread = thread => { expect(inheritance(BigInt(thread))).toBe(0); return resume(thread); };
    }
    const createFirst = first.k.CreateProcessW!, createSecond = second.k.CreateProcessW!;
    let other: WindowsCliChild | undefined;
    first.k.CreateProcessW = (...firstArgs) => {
      let firstResult = 0;
      second.k.CreateProcessW = (...secondArgs) => {
        // Both complete stdio sets are still inheritable here, before either CreateProcess.
        const objects = lists.map(list => list.map(handle => ({ handle: handle.toString(), name: queryWindowsFixtureObjectName(handle)! })));
        expect(objects.flat().every(item => typeof item.name === "string")).toBe(true);
        for (const [index, native] of [first, second].entries()) {
          for (const handle of native.handles) {
            expect(inheritance(handle)).toBe(handle === sentinel || lists[index]!.includes(handle) ? 1 : 0);
          }
        }
        // Each pipe name and the sentinel file are unique objects. NUL names are
        // deliberately not identity evidence for another invocation's NUL handles.
        writeFileSync(firstAudit, JSON.stringify({ own: objects[0], foreign: [objects[1]![1], { handle: sentinel.toString(), name: sentinelName }] }));
        writeFileSync(secondAudit, JSON.stringify({ own: objects[1], foreign: [objects[0]![1], { handle: sentinel.toString(), name: sentinelName }] }));
        for (const args of [firstArgs, secondArgs]) { expect(args[4]).toBe(1); expect(Number(args[5]) & 0x80004).toBe(0x80004); }
        firstResult = createFirst(...firstArgs);
        return createSecond(...secondArgs);
      };
      other = launch(["audit", secondAudit], "pack", second);
      return firstResult;
    };
    const child = launch(["audit", firstAudit], "pack", first);
    first.close(sentinel); // Fixture-owned foreign handle, never in either child's whitelist.
    for (const item of [child, other!]) {
      expect(item.setupFailure).toBeNull();
      for (const handle of item.native.handles) expect(inheritance(handle)).toBe(0);
      const result = JSON.parse((await finish(item))!.stdout);
      expect(result.own).toEqual([true, true, true]); expect(result.foreign).toEqual([false, false]);
      expect(result.standards).toEqual([true, true, true]);
    }
    extra.close();
    // Forward isolation only; foreign unrestricted CreateProcess(TRUE) is not claimed safe.
  });

  test("primary exit is nonterminal while a normally created stdout-free descendant remains in the Job", async () => {
    const gate = path(), child = launch(["descendant", gate]);
    try {
      await until(() => existsSync(`${gate}.ready`));
      await until(() => Number(child.native.k.WaitForSingleObject!(child.process, 0)) === 0);
      expect(child.observe()).toEqual({ terminal: false, exitCode: null, unknown: false });
      expect(child.native.handles.size).toBeGreaterThan(0);
    } finally { writeFileSync(gate, "release"); }
    expect((await finish(child))!.terminal).toBe(true); expect(existsSync(`${gate}.done`)).toBe(true);
  });

  test("real incompatible nested Job assignment refuses before fixture code", async () => {
    const native = new WindowsChildNative(), marker = path();
    const gate = path(), other = launch(["gate", gate]);
    const outer = native.keep(native.k.CreateJobObjectW!(null, null));
    try {
      const assign = native.k.AssignProcessToJobObject!;
      native.k.AssignProcessToJobObject = (job, process) => {
        expect(assign(outer, process)).toBe(1);
        // Establish a different nonempty hierarchy. A process already in outer
        // cannot join this nonempty Job outside its current Job hierarchy.
        expect(assign(job, other.process)).toBe(1);
        return assign(job, process);
      };
      const child = launch(["marker", marker], "pack", native);
      expect(child.setupFailure).toBe("job_assignment");
      native.close(outer);
      writeFileSync(gate, "release"); await finish(other);
      expect((await finish(child))!.terminal).toBe(true); expect(existsSync(marker)).toBe(false);
    } finally { native.close(outer); writeFileSync(gate, "release"); }
  });

  test("assignment/resume failures kill only the still-suspended owned primary before user code", async () => {
    for (const stage of ["AssignProcessToJobObject", "ResumeThread"] as const) {
      const native = new WindowsChildNative(), marker = path();
      if (stage === "AssignProcessToJobObject") native.k.AssignProcessToJobObject = () => 0;
      else native.k.ResumeThread = () => 0xffffffff;
      const child = launch(["marker", marker], "installer", native);
      expect(child.setupFailure).toBe(stage === "ResumeThread" ? "resume_thread" : "job_assignment");
      expect((await finish(child))!.terminal).toBe(true); expect(existsSync(marker)).toBe(false);
    }
  });

  test("failed pre-user-code termination stays owned and unknown until exact handle reap", async () => {
    const native = new WindowsChildNative(), marker = path(), terminate = native.k.TerminateProcess!;
    native.k.ResumeThread = () => 0xffffffff; native.k.TerminateProcess = () => 0;
    const child = launch(["marker", marker], "installer", native);
    expect((await child.wait()).terminal).toBe(false); expect(native.handles.size).toBeGreaterThan(0);
    native.k.TerminateProcess = terminate; expect(child.reapUnstarted()).toBe(true);
    expect((await finish(child))!.terminal).toBe(true); expect(existsSync(marker)).toBe(false);
  });

  test("pre-create setup failures release every handle exactly once and delete initialized attributes", async () => {
    for (const stage of ["CreateNamedPipeW", "CreateEventW", "CreateFileW", "InitializeProcThreadAttributeList", "UpdateProcThreadAttribute", "CreateProcessW"] as const) {
      const native = new WindowsChildNative(), deleted: number[] = [], closed = new Set<string>();
      const keep = native.keep.bind(native);
      native.keep = value => { const handle = keep(value); closed.delete(String(handle)); return handle; };
      const originalClose = native.k.CloseHandle!, originalDelete = native.k.DeleteProcThreadAttributeList!;
      native.k.CloseHandle = handle => { expect(closed.has(String(handle))).toBe(false); closed.add(String(handle)); return originalClose(handle); };
      native.k.DeleteProcThreadAttributeList = pointer => {
        expect(native.borrowedMemory.size).toBe(2);
        deleted.push(1); return originalDelete(pointer);
      };
      if (stage === "CreateNamedPipeW" || stage === "CreateEventW" || stage === "CreateFileW") native.k[stage] = (() => 0n) as never;
      else if (stage === "InitializeProcThreadAttributeList") {
        const initialize = native.k.InitializeProcThreadAttributeList!;
        native.k.InitializeProcThreadAttributeList = (...args) => args[0] === null ? initialize(...args) : 0;
      } else native.k[stage] = (() => 0) as never;
      const child = launch(["marker", path()], "pack", native);
      expect(child.process).toBe(0n); expect(child.setupFailure).toBeString();
      await finish(child);
      expect(deleted.length).toBe(stage === "UpdateProcThreadAttribute" || stage === "CreateProcessW" ? 1 : 0);
    }
  });

  test("pack byte cap drains/discards excess without termination; installer also has no kill policy", async () => {
    for (const policy of ["pack", "installer"] as const) {
      const native = new WindowsChildNative(); let kills = 0;
      native.k.TerminateJobObject = () => { kills++; throw new Error("unexpected installer/pack termination"); };
      const result = (await finish(launch(["overflow", String(2 * 1024 * 1024)], policy, native)))!;
      expect(result.terminal).toBe(true); expect(result.exitCode).toBe(0); expect(kills).toBe(0);
      expect(result.stdout.length).toBe(policy === "pack" ? 1024 * 1024 : 0);
      expect(result.overflow).toBe(policy === "pack");
    }
  });

  test("ordinary last Job handle close does not kill a running installer", async () => {
    const gate = path(), child = launch(["gate", gate], "installer");
    await until(() => existsSync(`${gate}.ready`));
    child.native.close(child.job); // Deliberate own-fixture close, loses the helper's terminal proof.
    expect(Number(child.native.k.WaitForSingleObject!(child.process, 0))).toBe(258);
    expect(child.observe().unknown).toBe(true);
    writeFileSync(gate, "release");
    await until(() => Number(child.native.k.WaitForSingleObject!(child.process, 0)) === 0);
    expect(existsSync(`${gate}.done`)).toBe(true);
    // The test intentionally destroyed the Job proof; exact own primary and I/O cleanup only.
    await child.pipe.dispose(); child.native.close(child.process); expect(child.native.dispose()).toBe(true);
    expect(child.native.handles.size).toBe(0);
  });

  test("WAIT_FAILED/query failure never counts as terminal; >32 active accounting is nonterminal", async () => {
    for (const fault of ["wait", "query", "many"] as const) {
      const native = new WindowsChildNative(), wait = native.k.WaitForSingleObject!, query = native.k.QueryInformationJobObject!;
      const child = launch(["unicode"], "pack", native);
      if (fault === "wait") native.k.WaitForSingleObject = () => 0xffffffff;
      else if (fault === "query") native.k.QueryInformationJobObject = () => 0;
      else native.k.QueryInformationJobObject = (job, kind, output, length, size) => {
        const result = query(job, kind, output, length, size);
        // FFI view is used only after a real native query succeeds.
        if (result) toBuffer(output!, 0, 48).writeUInt32LE(4096, 40);
        return result;
      };
      expect(child.observe().terminal).toBe(false);
      if (fault !== "many") expect((await child.wait()).terminal).toBe(false);
      native.k.WaitForSingleObject = wait; native.k.QueryInformationJobObject = query;
      expect((await finish(child))!.terminal).toBe(true);
    }
  });

  test("read error is a failure, not lifetime proof, and overlapped cancellation settles before close", async () => {
    const gate = path(), native = new WindowsChildNative();
    const extra = dlopen("kernel32.dll", { SetLastError: { args: ["u32"], returns: "void" } });
    const readFile = native.k.ReadFile!;
    native.k.ReadFile = () => { extra.symbols.SetLastError!(31); return 0; };
    const child = launch(["gate", gate], "pack", native);
    child.pipe.pump(() => {}); expect(child.pipe.error).toBe(true); expect(child.observe().terminal).toBe(false);
    native.k.ReadFile = readFile; writeFileSync(gate, "release");
    expect((await finish(child))!.failed).toBe(true); extra.close();

    const io = new WindowsChildNative(), pipe = new WindowsChildPipe(io); pipe.open();
    pipe.pump(() => {}); expect(pipe.pending).toBe(true);
    const close = io.k.CloseHandle!, cancel = io.k.CancelIoEx!; let canceled = false;
    io.k.CancelIoEx = (...args) => { canceled = true; return cancel(...args); };
    io.k.CloseHandle = handle => {
      if (handle === pipe.handle || handle === pipe.event) expect(pipe.pending).toBe(false);
      return close(handle);
    };
    await pipe.dispose(); expect(canceled).toBe(true); expect(io.handles.size).toBe(0); expect(io.dispose()).toBe(true);
  });

  test("version overflow and failed termination remain unknown until actual Job drain", async () => {
    const native = new WindowsChildNative(); let calls = 0;
    native.k.TerminateJobObject = () => { calls++; return 0; };
    const child = launch(["overflow", "32768", "300"], "version", native);
    const unknown = await child.wait();
    expect(unknown.terminal).toBe(false); expect(unknown.overflow).toBe(true); expect(calls).toBe(1);
    expect(native.handles.size).toBeGreaterThan(0);
    await until(() => child.observe().terminal);
    const final = (await finish(child))!; expect(final.terminal).toBe(true); expect(final.failed).toBe(true);
  });

  test("version reap deadline is unknown even when termination was acknowledged", async () => {
    const native = new WindowsChildNative(); let calls = 0;
    // An acknowledged request is deliberately not applied by the native fault seam.
    // The fixture itself exits, proving that acknowledgment is never terminal evidence.
    native.k.TerminateJobObject = () => { calls++; return 1; };
    const child = launch(["overflow", "32768", "1500"], "version", native), started = Date.now();
    expect((await child.wait()).terminal).toBe(false); expect(calls).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(Number(native.k.WaitForSingleObject!(child.process, 0))).toBe(258);
    await until(() => child.observe().terminal);
    expect((await finish(child))!.terminal).toBe(true);
  });

  test("version 8 second deadline terminates only its owned Job and reaps within the separate policy", async () => {
    const gate = path(), child = launch(["gate", gate], "version"), started = Date.now();
    const result = (await finish(child))!;
    expect(result.terminal).toBe(true); expect(result.failed).toBe(true); expect(result.reason).toBe("deadline");
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900); expect(Date.now() - started).toBeLessThan(10000);
    expect(existsSync(`${gate}.done`)).toBe(false);
  }, 12000);
});
