// Binding rule of the checked Windows stop (#7771, 030 "Binding rule").
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  bindWindowsStopWrappers,
  windowsHomeWrapperPids,
  windowsWrapperImage,
  type WindowsStopBindingContext,
} from "../../src/service/windows-stop-binding";
import {
  CMD, OTHER_HOME_VBS, PATHS, SCHEDULE_PID, VBS,
  entry, launcher, loop, proxy, scheduleHost, supervisedTree,
} from "../helpers/windows-checked-stop-fixtures";

const context = (overrides: Partial<WindowsStopBindingContext> = {}): WindowsStopBindingContext => ({
  processes: supervisedTree(),
  canonicalPaths: PATHS,
  childPid: 42,
  taskRegistered: true,
  managerRegistered: true,
  scheduleServicePid: SCHEDULE_PID,
  selfPid: 1,
  ...overrides,
});

describe("checked Windows stop binding", () => {
  test("binds the launcher and the looping cmd.exe above the child, deepest first", () => {
    const binding = bindWindowsStopWrappers(context());
    expect(binding.bound.map(wrapper => [wrapper.pid, wrapper.image, wrapper.startTime])).toEqual([
      [30, "cmd.exe", 5_100],
      [20, "wscript.exe", 5_000],
    ]);
    expect(binding.unbound).toEqual([]);
    expect(binding.unreadable).toEqual([]);
    expect(binding.child).toEqual({ pid: 42, startTime: 5_200 });
    // The receipt keeps a digest; the command line itself never leaves the snapshot.
    expect(binding.bound[0]!.commandLineDigest)
      .toBe(createHash("sha256").update(loop().commandLine!, "utf8").digest("hex"));
    expect(JSON.stringify(binding)).not.toContain("opencodex-service");
  });

  test("the proxy child is never a candidate, whatever its image or command line", () => {
    const child = entry(42, 30, "cmd.exe", 'cmd.exe /c "' + CMD + '"', 5_200);
    const binding = bindWindowsStopWrappers(context({ processes: [scheduleHost, launcher(), loop(), child] }));
    expect(binding.bound.map(wrapper => wrapper.pid)).toEqual([30, 20]);
  });

  test("the path token under a non-wrapper image is neither bound nor reported", () => {
    const editor = entry(70, 500, "notepad.exe", 'notepad.exe "' + VBS + '"', 6_000);
    const binding = bindWindowsStopWrappers(context({ processes: [...supervisedTree(), editor] }));
    expect(binding.bound.map(wrapper => wrapper.pid)).toEqual([30, 20]);
    expect(binding.unbound).toEqual([]);
  });

  test("another home's wrapper and a substring-only match are not this home's wrappers", () => {
    const other = entry(80, SCHEDULE_PID, "wscript.exe", 'wscript.exe //B "' + OTHER_HOME_VBS + '"', 6_000);
    const suffixed = entry(81, SCHEDULE_PID, "cmd.exe", 'cmd.exe /c "' + CMD + '.bak"', 6_000);
    const prefixed = entry(82, SCHEDULE_PID, "cmd.exe", "cmd.exe /c X" + CMD, 6_000);
    const binding = bindWindowsStopWrappers(context({ processes: [...supervisedTree(), other, suffixed, prefixed] }));
    expect(binding.bound.map(wrapper => wrapper.pid)).toEqual([30, 20]);
    expect(binding.unbound).toEqual([]);
  });

  test("a stray launcher of a stopped task binds through the Schedule host, with its loop", () => {
    // The task is no longer running and the proxy is gone, but the wrapper relaunches it.
    const binding = bindWindowsStopWrappers(context({
      processes: [scheduleHost, launcher(), loop()], childPid: null,
    }));
    expect(binding.bound.map(wrapper => wrapper.pid)).toEqual([30, 20]);
  });

  test("an unreadable Schedule host PID disables that clause", () => {
    const binding = bindWindowsStopWrappers(context({
      processes: [scheduleHost, launcher(), loop()], childPid: null, scheduleServicePid: null,
    }));
    expect(binding.bound).toEqual([]);
    expect(binding.unbound.map(wrapper => wrapper.pid).sort()).toEqual([20, 30]);
  });

  test("an ancestor of the identity-checked child binds on that clause alone", () => {
    // The launcher's parent is a live, older shell, so neither the Schedule host clause nor
    // "parent gone" applies; only 030's first lineage clause can bind it.
    const shell = entry(500, 4, "explorer.exe", "explorer.exe", 2_000);
    const binding = bindWindowsStopWrappers(context({
      processes: [scheduleHost, shell, launcher(20, 500), loop(), proxy()],
      taskRegistered: false,
    }));
    expect(binding.bound.map(wrapper => wrapper.pid)).toEqual([30, 20]);
    expect(binding.unbound).toEqual([]);
  });

  test("a wrapper whose parent PID is unreadable never binds, registered or not", () => {
    const tree = [scheduleHost, { ...launcher(), parentPid: null }, loop()];
    expect(bindWindowsStopWrappers(context({ processes: tree, childPid: null })).bound).toEqual([]);
    const unregistered = bindWindowsStopWrappers(context({
      processes: tree, childPid: null, taskRegistered: false, managerRegistered: false,
    }));
    expect(unregistered.bound).toEqual([]);
    expect(unregistered.unbound.map(wrapper => wrapper.pid).sort()).toEqual([20, 30]);
  });

  test("with the task registered, a wrapper whose parent PID is unreadable is unreadable, not unbound", () => {
    const binding = bindWindowsStopWrappers(context({
      processes: [scheduleHost, { ...launcher(), parentPid: null }, loop()], childPid: null,
    }));
    expect(binding.unreadable).toEqual([20]);
    expect(binding.unbound.map(wrapper => wrapper.pid)).not.toContain(20);
  });

  test("an orphan binds only while this home's task is registered", () => {
    const orphanTree = [launcher(20, 777), loop()];
    const registered = bindWindowsStopWrappers(context({ processes: orphanTree, childPid: null }));
    expect(registered.bound.map(wrapper => wrapper.pid)).toEqual([30, 20]);
    const unregistered = bindWindowsStopWrappers(context({
      processes: orphanTree, childPid: null, taskRegistered: false, managerRegistered: false,
    }));
    expect(unregistered.bound).toEqual([]);
    expect(unregistered.unbound.map(wrapper => wrapper.pid).sort()).toEqual([20, 30]);
  });

  test("a parent PID created after the wrapper is a reused PID, so the parent is gone", () => {
    const reusedParent = entry(777, 4, "explorer.exe", "explorer.exe", 9_000);
    const binding = bindWindowsStopWrappers(context({
      processes: [reusedParent, launcher(20, 777), loop()], childPid: null,
    }));
    expect(binding.bound.map(wrapper => wrapper.pid)).toEqual([30, 20]);
  });

  test("a launcher started by hand from a live shell fails lineage, and so does its loop", () => {
    const shell = entry(500, 4, "explorer.exe", "explorer.exe", 2_000);
    const binding = bindWindowsStopWrappers(context({
      processes: [scheduleHost, shell, launcher(20, 500), loop()], childPid: null,
    }));
    expect(binding.bound).toEqual([]);
    expect(binding.unbound.map(wrapper => wrapper.pid).sort()).toEqual([20, 30]);
  });

  test("a matching wrapper without a creation time is unreadable, never bound", () => {
    const binding = bindWindowsStopWrappers(context({
      processes: [scheduleHost, launcher(), loop(30, 20, null), proxy()],
    }));
    expect(binding.unreadable).toEqual([30]);
    expect(binding.bound.map(wrapper => wrapper.pid)).toEqual([20]);
  });

  test("a matching process whose image name is unreadable is unreadable", () => {
    const unnamed = entry(31, 20, null, 'cmd.exe /c "' + CMD + '"', 5_150);
    const binding = bindWindowsStopWrappers(context({ processes: [...supervisedTree(), unnamed] }));
    expect(binding.unreadable).toEqual([31]);
  });

  test("an unreadable wrapper image under a bound wrapper is unreadable", () => {
    const hidden = entry(35, 20, "cmd.exe", null, 5_300);
    const binding = bindWindowsStopWrappers(context({ processes: [...supervisedTree(), hidden] }));
    expect(binding.unreadable).toEqual([35]);
  });

  test("an unreadable ancestor of the child counts only while a manager is registered", () => {
    const tree = [entry(10, 4, "cmd.exe", null, 1_500), proxy(42, 10)];
    expect(bindWindowsStopWrappers(context({ processes: tree })).unreadable).toEqual([10]);
    expect(bindWindowsStopWrappers(context({
      processes: tree, taskRegistered: false, managerRegistered: false,
    })).unreadable).toEqual([]);
  });

  test("an unrelated unreadable shell is not evidence", () => {
    const unrelated = entry(60, 4, "cmd.exe", null, 1_500);
    expect(bindWindowsStopWrappers(context({ processes: [...supervisedTree(), unrelated] })).unreadable).toEqual([]);
  });

  test("the stopping process is never a candidate", () => {
    const binding = bindWindowsStopWrappers(context({ selfPid: 30 }));
    expect(binding.bound.map(wrapper => wrapper.pid)).toEqual([20]);
  });

  test("wrapper images and the final-enumeration filter", () => {
    expect(windowsWrapperImage("WScript.EXE")).toBe("wscript.exe");
    expect(windowsWrapperImage("C:\\Windows\\System32\\cscript.exe")).toBe("cscript.exe");
    expect(windowsWrapperImage("bun.exe")).toBeNull();
    expect(windowsWrapperImage(null)).toBeNull();
    const editor = entry(70, 500, "notepad.exe", 'notepad.exe "' + VBS + '"', 6_000);
    expect(windowsHomeWrapperPids([...supervisedTree(), editor], PATHS, 1)).toEqual([20, 30]);
  });
});
