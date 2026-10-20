# Test Sandbox Cleanup

## Windows runtime namespace

`src/codex/user-identity.ts` keys runtime namespaces on the effective SID and environment-independent
LocalAppData. `src/codex/windows-local-appdata.ts` calls `SHGetKnownFolderPath` in-process on Windows
x64, loading Shell32/Ole32 from the OS-resolved system directory. It uses `KF_FLAG_DEFAULT_PATH`
and a null token, bounds UTF-16 decoding, and frees the allocation even when the API fails.
Unsupported FFI retains the bounded trusted PowerShell helper; native API failures refuse.
`USERPROFILE` and `LOCALAPPDATA` never choose this root. Runtime canonicalization/reparse checks
and the Bun test lock's required ACL hardening remain separate admission checks.

## Sandbox lifecycle

The batch runner's per-process home isolation and live-home/service-manager guards remain active
because the preload installs them before the lock boundary. `tests/preload.ts` resolves cleanup
dependencies after home/lock admission and before test cases. Teardown awaits native-main startup
releases and config hardening, followed by the sandbox's registered ACL child reaps before removing
that root. Its synchronous exit fallback leaves an undrained root for ownership-checked stale
recovery instead of blocking child cleanup with removal retries.
`tests/ci-workflows/test-sandbox-cleanup.test.ts` pins that ordering with a delayed reap.

`scripts/test.ts` pins `OCX_OWNER_REGISTRY_DIR` beneath each sandbox's OpenCodex home,
including the sandbox created by the preload. It never inherits a host registry override.
Under the armed guard, `src/config/owner-registry.ts` also resolves an absent override
under the selected `OPENCODEX_HOME`, rather than Bun's cached startup home. Its resolver
rejects protected-home ancestors before reads, registration or retirement, including explicit
overrides and symlink aliases. Production keeps the shared default-home registry.
`tests/config/owner-registry-isolation.test.ts` verifies guarded child reads, writes,
retirement and fixture switches against a foreign startup-home record, plus production behavior.

Under the armed test-home guard, `src/service/state.ts` resolves service-state reads and
writes only within the selected `OPENCODEX_HOME`, including captured-home lookups. Bun
caches the startup home, so a legacy mirror resolved through `os.homedir()` would otherwise
be shared by parallel workers and serial fixture homes. Production retains the legacy
default-home mirror and migration lookup. `tests/service/service-state-isolation.test.ts`
plants a foreign startup-home record and verifies isolated reads, writes and fixture switches,
alongside the unchanged production mirror behavior.

The sandbox also pins the client homes that otherwise default to `os.homedir()`:
`CLAUDE_CONFIG_DIR` and `GROK_HOME` point inside its root and are never inherited, because
Bun's `os.homedir()` keeps the home it read at startup and a preload that only rewrites HOME
leaves them at the developer's directories. `scripts/test.ts` hands the developer's own Claude
directory to the guard as `OCX_REAL_CLAUDE_CONFIG_DIR`. `claudeConfigDir()` in
`src/claude/gateway-cache.ts` reads the current platform home variable (HOME, or USERPROFILE on
Windows), as Claude Code's Node runtime does. Under an armed process,
`assertNotRealClaudeConfigUnderTest` in `src/lib/test-home-guard.ts` refuses Claude agent sync,
gateway-cache writes, served-catalog invalidation and intercept `settings.json` writes into the
real Claude config directory, its default and the developer's override alike. Writers pass every
directory they touch, so a sandbox child linked into the real directory is judged by its target;
protected roots resolve at check time and compare case-insensitively on macOS and Windows. That
directory is also a protected removal tree.
`tests/claude-integration/claude-config-home-isolation.test.ts` pins each layer.

`tests/helpers/test-sandbox-cleanup.ts` exposes case-scoped lifecycle ownership: cancellation
starts listener stops while owned asynchronous work settles, and repeated close/stop calls share
one promise. After teardown starts only the lifecycle's own abort reason is absorbed; any other
error, including a foreign AbortError, still fails its case. Callers settle that lifecycle before
draining producers/reaps and restoring or removing a home. The helper does not replace
fixture-specific cleanup or claim OS ACL coverage for synthetic tests.

`tests/helpers/fixture-teardown.ts` owns management-auth, OAuth live-update, Codex quota-auto-refresh
case roots (`tests/codex-integration/codex-quota-auto-refresh.test.ts`), and Anthropic instance
root removal (`tests/helpers/anthropic-instance-fixture.ts`).
It settles producers, then each root's config flights, closes the request-history SQLite index,
drains each root's ACL work, and only then removes drained roots. A producer or history failure
blocks every removal; a root-specific drain failure preserves that root while other drained roots
can be removed. Removal failures do not stop later roots. Environment restoration runs in finally,
and the first failure is rethrown. Undrained roots remain for run-level sandbox cleanup.
`tests/ci-workflows/fixture-teardown-helper.test.ts` verifies ordering and failure gating with injected owners.

`tests/helpers/spawn-test-child.ts` owns behavior and warm-up children on the parent's live
event loop. It captures output continuously, kills at the child deadline, and bounds exit/pipe
observation with a separate five-second grace. Results distinguish deadline expiry, observed
exit (`reaped`) and pipe closure; an unobserved exit does not prove fixture handles were released.
The affected catalog/status/routing fixtures retain roots after timeout or unproven exit/EOF
for sandbox recovery rather than deleting against uncertain child handles. Explicit environments
are complete allowlists. Catalog tick children drain their config ACL
flights/reaps before normal exit. Child work deadlines remain separate from outer test budgets,
which reserve time for termination and teardown. The shared warm-up regressions exercise a live
interval after work completes and a descendant retaining stdout after its parent exits.
