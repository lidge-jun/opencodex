/**
 * A pid that is genuinely free, probed rather than assumed.
 *
 * Several suites need a pid that stands in for a process that has exited: stale
 * `ocx.pid` records, abandoned response-state temps, doctor's reclaim paths. The
 * code under test asks the kernel whether that owner is still alive, so a
 * hardcoded "dead" pid is only dead until some unrelated process happens to hold
 * it — and then the production code answers correctly, the test reads that as a
 * miss, and the failure looks like a defect in the feature.
 *
 * That is not hypothetical. On the macOS host where this helper was written, pid
 * 4242 was `liveactivitiesd`, and every suite that assumed it dead failed at once:
 * `periodic reclaim frees abandoned temps`, both `doctor reclaim wiring` cases and
 * both `status reports stale process records` cases. `tests/responses-state.test.ts`
 * already probed for a free pid inline, with a comment naming this exact hazard;
 * this helper is that probe, shared instead of copied.
 *
 * ESRCH is the only answer that proves absence. A successful `kill(pid, 0)` means
 * the process is alive, and EPERM means it is alive but owned by somebody else —
 * both disqualify the candidate.
 */
export function findDeadPid(): number {
  for (let candidate = 4242; candidate < 5242; candidate += 1) {
    if (candidate === process.pid) continue;
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no free pid in [4242, 5242) to stand in for a dead owner");
}
