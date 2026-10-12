# wp1 — Publish the CLI restart replacement

One implementation cycle produces an ordinary draft PR against dev. Preserve the newer-CLI upgrade intent and proxy-newer/incomparable refusal from #6548. Add focused lifecycle regression coverage, keep index composition minimal, and synchronize runtime and user lifecycle documentation.

The scoped implementation and security audit remain in ignored scratch until the patch is public, per repository policy. Public delivery records source coverage, attribution, verification commands and native/live limits. No source PR is closed by this lane.

Expected changed areas: src/cli restart siblings and index wiring; tests/cli lifecycle regressions; both test-layout registries; structure/runtime.md; docs-site lifecycle reference. No integration branch or version file changes.

## Delivery outcome

#6556 merged into dev as `7cf1b7624a` from final PR head `87d8123137`, after leaving draft. That head already incorporated #6569 (`accd69444c`), which landed first and added the same runtime-readiness wait to the package-tree restart.

- **Unmocked POSIX acceptance (macOS arm64, Bun 1.4.0) passed on the final PR head `87d8123137`.** Two standalone builds of that tree (`2.78.0-acceptance.1` and `.2`) ran inside one temporary root holding every state directory, on a random loopback port, after a preflight confirmed each resolved state path stayed inside it. The newer CLI's `ocx restart` stopped the detached old proxy and launched exactly one replacement: parent PID 1, same port, version `.2`. The older CLI's restart against the newer proxy was refused. Teardown confirmed both processes gone and the port closed. Not exercised end to end: Linux with a real user systemd manager, npm-global installs (the runtime gate has unit coverage only), and Windows or supervised runtimes, which refuse this path by design.
- **Added while carrying #6548:** the launched executable must pass the shared `REAL_BUN_MIN_BYTES` gate. While it is still the npm `bun` placeholder, restart refuses before sending any stop byte. After a confirmed stop it waits within the deadline, then rechecks deadline and home before the single launch. #6548's progress line and per-step failure explanations were carried with a `Co-authored-by` trailer for agentHits.
- **Test isolation:** the transport test's HTTP-proxy case now runs in a child process. Bun cannot unset an exported variable, so the in-process version leaked the proxy into the next file of a `BUN_TEST_PARALLEL=1` batch and failed the macOS shard.
- **#6548:** superseded by #6556 for the newer-CLI update. Its attempt to restart foreground and service-managed proxies was deliberately not carried, because that path cannot verify the replacement it launches. It was closed without merging on 2026-10-04 (UTC).
