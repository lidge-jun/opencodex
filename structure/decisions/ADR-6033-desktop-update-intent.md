# ADR-6033 — failed desktop updates preserve runtime intent

- Contract owner: [Desktop shell](../desktop-shell.md)

## Decision record

- Purpose and intent: Recover from a failed in-app update without undoing a person's earlier tray Stop.
- Existing implementation and constraints: A coordinated restart clears `wanted` before draining so the supervisor cannot race the update. Its abort path then unconditionally restored `wanted=true`, and the updater treated every `Drained` result as a request for immediate recovery. When the runtime was already tray-stopped, no child still produced `Drained`, so installer failure restarted a runtime that had been intentionally left off.
- Alternatives considered: Never recover after installer failure; infer intent from whether a child PID existed; snapshot the pre-drain `wanted` value inside the exit coordinator.
- Chosen approach: Capture pre-drain intent under the coordinator mutex when a coordinated restart first claims the sequence. When that settled restart is aborted, combine and consume the snapshot with any newer Resume request received during the drain. Immediate updater recovery requires both a `Drained` phase and this effective `wanted=true` intent.
- Why this approach: Process presence does not express user intent: an already-stopped runtime and one drained by the update are both absent. The coordinator is the existing authority for sticky Stop/Resume intent. Combining the captured value with its current value preserves newer user intent without a second race-prone read.
- Benefits, costs and impact: Failed updates still recover a runtime they stopped, while tray-stopped sessions remain idle unless the person explicitly retries startup during the drain. Download failures, successful installer restarts, quit ownership, and in-flight drains are unchanged. The snapshot is process-local and intentionally does not persist across a successful application restart.
