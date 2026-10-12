# Check-phase port allocation repair

CI34011124632 passed the corrected task-input cases and Linux shards, but two
unchanged macOS management-auth tests failed at the public Bun.serve bind with
EADDRINUSE. Both tests used findAvailablePort, whose Node probe closes its socket
before returning a number. The probes bind 127.0.0.1 while remoteConfig makes the public listener bind 0.0.0.0, so a loopback-only availability check also has the wrong address scope. reservedPort prevents the two selected numbers from
being equal; it does not keep either port reserved until Bun binds. The identity
of the intervening occupier is not established by the CI log.

This is a prerequisite repair to the failing verification instrument, not a
change to authentication or production port policy. Modify only
tests/server/server-management-auth.test.ts: replace those two probe-close
setups with a small test helper that wraps Bun.serve synchronously, changes only
port to zero, calls the real Bun.serve and captures the real public/management
listeners while preserving each original hostname and fetch handler. Restore the spy before requests or any awaited cleanup. Derive the
management URL from its actual listener port and assert distinct live listeners.
Keep a valid positive configured ingress port so production config validation
remains unchanged; the fixture explicitly owns ephemeral bind allocation.

The helper joins captured-listener cleanup if startup/fixture validation fails;
the existing finally blocks continue using the real composite server.stop.
Retain every trust, origin, credential, health, consent and pairing assertion.
No retry, sleep, skip, wider auth rule, or production test seam is added.

Verification: independent fixture review followed by fresh exact-head hosted
CI. The same two real HTTP tests must pass, along with the new task-input cases
and full Linux/macOS checks. No local test suite is run.
