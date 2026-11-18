/**
 * Shared fixtures for the checked Windows stop tests: a supervised process tree and a
 * virtual clock. The clock advances only when a sleep is not aborted, so a capped step
 * that answers in time costs no virtual time and a hung one costs exactly its cap.
 */
import type { WindowsStopProcessEntry } from "../../src/service/windows-process-evidence";
import type { WindowsStopClock } from "../../src/service/windows-checked-stop";

export const HOME = "C:\\Users\\me\\.opencodex";
export const VBS = HOME + "\\opencodex-service-launcher.vbs";
export const CMD = HOME + "\\opencodex-service.cmd";
export const OTHER_HOME_VBS = "C:\\Users\\other\\.opencodex\\opencodex-service-launcher.vbs";
export const PATHS = [VBS, CMD] as const;
export const SCHEDULE_PID = 900;

export const entry = (
  pid: number,
  parentPid: number | null,
  name: string | null,
  commandLine: string | null,
  startTime: number | null,
): WindowsStopProcessEntry => ({ pid, parentPid, name, commandLine, startTime });

export const scheduleHost = entry(SCHEDULE_PID, 600, "svchost.exe", "C:\\Windows\\system32\\svchost.exe -k netsvcs -s Schedule", 1_000);
export const launcher = (pid = 20, parent = SCHEDULE_PID, start: number | null = 5_000) =>
  entry(pid, parent, "wscript.exe", 'C:\\Windows\\System32\\wscript.exe //B //NoLogo "' + VBS + '"', start);
export const loop = (pid = 30, parent = 20, start: number | null = 5_100) =>
  entry(pid, parent, "cmd.exe", 'C:\\Windows\\System32\\cmd.exe /c "' + CMD + '"', start);
export const proxy = (pid = 42, parent = 30, start = 5_200) =>
  entry(pid, parent, "bun.exe", "C:\\bun\\bun.exe C:\\pkg\\src\\cli\\index.ts start --port 10100", start);

/** svchost(Schedule) 900 -> wscript 20 (.vbs) -> cmd 30 (.cmd) -> proxy 42. */
export const supervisedTree = (): WindowsStopProcessEntry[] => [scheduleHost, launcher(), loop(), proxy()];

export interface VirtualClock {
  clock: WindowsStopClock;
  advance(ms: number): void;
  readonly now: number;
}

export function virtualClock(start = 0): VirtualClock {
  let now = start;
  return {
    clock: {
      now: () => now,
      sleep: (ms, signal) => new Promise<void>(resolve => {
        setTimeout(() => {
          if (!signal?.aborted) now += Math.max(0, ms);
          resolve();
        }, 0);
      }),
    },
    advance(ms) { now += ms; },
    get now() { return now; },
  };
}
