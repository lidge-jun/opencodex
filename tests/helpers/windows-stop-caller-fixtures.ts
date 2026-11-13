/**
 * Result builders for the caller-level tests of the checked Windows stop (#7771): what Part A
 * and Part B return, so a caller can be driven through every outcome without the machine.
 */
import type { WindowsCheckedStopResult } from "../../src/service/windows-checked-stop";
import type { WindowsStopConfirmResult } from "../../src/service/windows-stop-confirm";

export function partAResult(
  outcome: WindowsCheckedStopResult["outcome"],
  extra: Partial<WindowsCheckedStopResult> = {},
): WindowsCheckedStopResult {
  const reason: WindowsCheckedStopResult["reason"] = outcome === "denied" ? "access-denied"
    : outcome === "unknown" ? "evidence-unreadable"
      : outcome === "unverified-budget" ? "unverified-budget" : null;
  return {
    outcome, reason, detail: "fixture " + outcome,
    registration: { scheduler: outcome === "absent" ? "absent" : "present", winsw: "nonexistent" },
    bound: outcome === "stopped" ? [{ pid: 30, startTime: 5_100, image: "cmd.exe", parentPid: 20, commandLineDigest: "d" }] : [],
    unbound: [], terminated: outcome === "stopped" ? [30] : [], changed: outcome !== "absent" && outcome !== "unverified-budget",
    ...extra,
  };
}

export function partBResult(
  outcome: WindowsStopConfirmResult["outcome"],
  extra: Partial<WindowsStopConfirmResult> = {},
): WindowsStopConfirmResult {
  return {
    outcome,
    portHeldByForeign: outcome === "port-held-by-foreign",
    reason: outcome === "unknown" ? "evidence-unreadable" : null,
    detail: "fixture " + outcome,
    port: 10100,
    windowMs: 6_000,
    listener: outcome === "port-held-by-foreign" ? { ownerPid: 777, identity: "foreign" }
      : outcome === "survived" ? { ownerPid: 43, identity: "ours" } : null,
    lateWrappers: [],
    ...extra,
  };
}

export const ALL_PART_A_FAILURES = ["survived", "denied", "unknown", "unverified-budget"] as const;
