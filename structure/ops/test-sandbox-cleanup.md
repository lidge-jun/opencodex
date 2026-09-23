# Test Sandbox Cleanup

The batch runner's per-process home isolation and live-home/service-manager guards remain active
because the preload installs them before the lock boundary. `tests/preload.ts` resolves cleanup
dependencies after home/lock admission and before test cases. Teardown awaits native-main startup
releases and config hardening, followed by the sandbox's registered ACL child reaps before removing
that root. Its synchronous exit fallback leaves an undrained root for ownership-checked stale
recovery instead of blocking child cleanup with removal retries.
`tests/ci-workflows/test-sandbox-cleanup.test.ts` pins that ordering with a delayed reap.

`tests/helpers/test-sandbox-cleanup.ts` exposes case-scoped lifecycle ownership: cancellation
starts listener stops while owned asynchronous work settles, and repeated close/stop calls share
one promise. After teardown starts only the lifecycle's own abort reason is absorbed; any other
error, including a foreign AbortError, still fails its case. Callers settle that lifecycle before
draining producers/reaps and restoring or removing a home. The helper does not replace
fixture-specific cleanup or claim OS ACL coverage for synthetic tests.
