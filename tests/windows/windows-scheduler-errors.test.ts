import { describe, expect, test } from "bun:test";
import { WindowsSchtasksError, WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER } from "../../src/lib/windows-elevation";
import { schtasks, schtasksErrorDetail, type WindowsSchedulerTaskProbe } from "../../src/service/windows-scheduler";
import { isWindowsSchedulerEndBenign } from "../../src/service/windows-ops";

const task = "opencodex-proxy";
// Literal CP949 bytes; UTF-8 decoding corrupts the child's diagnostic before formatting.
const stderr = Buffer.from("bfa1b7af3a20bed7bcbcbdbab0a120b0c5baceb5c7befabdc0b4cfb4d92e", "hex");
const deleteArgs = ["/delete", "/tn", task, "/f"];

function failure(status = 1, output = stderr) {
  return Object.assign(new Error(`Command failed: schtasks.exe\n${output.toString("utf8")}`), {
    status, stderr: output, stdout: Buffer.alloc(0),
  });
}

function failedCommand(args: string[], error: Error, state: WindowsSchedulerTaskProbe = { status: "present" }) {
  try {
    schtasks(args, { run: () => { throw error; }, probeTask: () => state });
  } catch (cause) {
    expect(cause).toBeInstanceOf(WindowsSchtasksError);
    return cause as WindowsSchtasksError;
  }
  throw new Error("Expected Task Scheduler failure");
}

describe("Task Scheduler failure diagnostics (#7772)", () => {
  test("delete exit 1 with a surviving task gives the exact elevated command without child stderr", () => {
    const error = failedCommand(deleteArgs, failure());
    expect(error.reason).toBe("access-denied");
    expect(error.message).toBe("Windows access denied while running Task Scheduler. Run this command from an elevated terminal (Run as administrator): schtasks /delete /tn opencodex-proxy /f");
    expect(error.message).not.toContain("\uFFFD");
    expect(error.machineMarker).toBeNull();
  });

  for (const operation of ["/delete", "/run", "/end"]) {
    test(`${operation} explicit denial names elevation rather than install recovery`, () => {
      const args = [operation, "/tn", task, ...(operation === "/delete" ? ["/f"] : [])];
      const error = failedCommand(args, failure(1, Buffer.from("ERROR: Access is denied.")));
      expect(error.reason).toBe("access-denied");
      expect(error.message).toContain("from an elevated terminal (Run as administrator)");
      expect(error.message).toContain(`schtasks ${args.join(" ")}`);
      expect(error.message).not.toContain("normally registers without elevation");
      expect(error.message).not.toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    });
  }

  for (const state of [{ status: "absent" }, { status: "unknown", detail: "query failed" }] as const) {
    test(`delete exit 1 with task ${state.status} fails without claiming access denial`, () => {
      const error = failedCommand(deleteArgs, failure(), state);
      expect(error.reason).toBe("other");
      expect(error.message).toBe("Task Scheduler command failed (exit code 1): schtasks /delete /tn opencodex-proxy /f");
    });
  }

  test("non-permission failures across install/start/stop/query suppress child stderr", () => {
    for (const operation of ["/create", "/run", "/end", "/query", "/delete"]) {
      const error = failedCommand([operation, "/tn", task], failure(2));
      expect(error.reason).toBe("other");
      expect(error.message).toBe(`Task Scheduler command failed (exit code 2): schtasks ${operation} /tn ${task}`);
    }
  });

  test("foreign tasks never receive the owned-delete exit-code fallback", () => {
    expect(failedCommand(["/delete", "/tn", "other-task", "/f"], failure()).reason).toBe("other");
  });

  test("a failed presence probe cannot replace the original delete failure", () => {
    expect(() => schtasks(deleteArgs, {
      run: () => { throw failure(); },
      probeTask: () => { throw new Error("probe unavailable"); },
    })).toThrow("Task Scheduler command failed (exit code 1)");
  });

  test("already-stopped end remains benign without echoing the child diagnostic", () => {
    const error = failedCommand(["/end", "/tn", task], failure(1, Buffer.from("ERROR: There is no running instance of the task. (0x41330)")));
    expect(isWindowsSchedulerEndBenign(error)).toBe(true);
    expect(error.message).not.toContain("Command failed");
  });

  test("successful operations do not run a presence probe", () => {
    expect(schtasks(deleteArgs, {
      run: args => { expect(args).toEqual(deleteArgs); return "ok"; },
      probeTask: () => { throw new Error("unexpected probe"); },
    })).toBe("ok");
  });

  test("presence-probe diagnostics also suppress raw child stderr", () => {
    expect(schtasksErrorDetail(failure())).toBe("Task Scheduler command failed (exit code 1): schtasks /query");
  });
});
