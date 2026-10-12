# Claude replay policy verification

Claude-specific routing/sidecar replay snapshots are preserved, while the original policy owner is passed separately as a read-only reference. Auth policy checks, materializers, retries/combo recursion, final guards and native helper eligibility consume that reference. No Proxy, prototype, whole-config replacement or generic transport change was introduced. Compact already retains the original config.

The new217line server regression uses the actual primary loopback Messages endpoint, pauses after replay creation, changes the original opt-in flag, then requires a429 without inference or dispatch-time permission renewal. The still-off control requires successful inference. Reference identity and Claude-specific sidecar overrides are asserted; secondary-listener404 is not used as proof.

Nash source/test re-review PASS, blocking_issues0. Root TypeScript and diff check passed. No local suites or test execution; the final commit must pass exact-head CI. Separate CI fixture corrections for the public @main sentinel and updated admission call expectation are in1e28a3a20.
