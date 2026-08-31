import { describe, expect, test } from "bun:test";
import { classifyStopForUpdate } from "../src/update/index";

/**
 * #3008: a dashboard update aborted after `ocx stop` had already stopped the
 * proxy, because resume-history restoration exited non-zero and the update read
 * the stop command's status as its gate. The port was left with no listener and
 * the old package still installed.
 */
describe("classifyStopForUpdate", () => {
  test("proceeds when the proxy is down, even if stop reported failure", () => {
    expect(classifyStopForUpdate({ status: 1, proxyStillUp: false })).toEqual({
      proceed: true,
      stopStatus: 1,
    });
  });

  test("reports no status to warn about when stop succeeded", () => {
    expect(classifyStopForUpdate({ status: 0, proxyStillUp: false })).toEqual({
      proceed: true,
      stopStatus: null,
    });
  });

  test("refuses while a proxy is still up, whatever stop reported", () => {
    // Replacing package files under a live proxy leaves it executing mixed
    // old/new code, so this is the one condition that must still abort.
    expect(classifyStopForUpdate({ status: 0, proxyStillUp: true })).toEqual({ proceed: false });
    expect(classifyStopForUpdate({ status: 1, proxyStillUp: true })).toEqual({ proceed: false });
  });

  test("treats a signal-killed stop as non-fatal once the proxy is down", () => {
    // spawnSync reports status null when the child died from a signal.
    expect(classifyStopForUpdate({ status: null, proxyStillUp: false })).toEqual({
      proceed: true,
      stopStatus: null,
    });
  });
});
