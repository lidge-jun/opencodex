# Account quota API build record

Layer: `codex/provider-account-quota-api`, parent `9a9ad98b8` / PR #3582.
Main owns existing management route projection, route-level regression file and test-layout
registration. Euclid owns credential-scoped quota readers, key cache, shared fields and provider
regressions. No local test, typecheck, build, lint or scan commands run in this layer.

Route projection now advertises capability on cheap lists, enriches only opt-in supported
credentials, preserves active selection, clears prior failure flags on success, and checks
private identity guards immediately before serializing safe quota fields. Passive reads remain
cache-only. Internal callbacks and credential identities are never spread into response DTOs.

Kant's scoped route review found one missing activation test: replacing an environment key
inside fetch proves worker rejection but not the final route guard. Accepted and added a
completed non-null quota fixture with `isCurrent() === false`, one callback invocation and
null/unavailable JSON expectation. Same final-projection scenario added for OAuth rows.
Re-review of the key guard delta: PASS, static only. Full independent review and remote CI pending.

C inspection at `979249852` found a new-cache age gap: a failed read refreshes attempt TTL
but preserves the measurement timestamp; a cache hit checked only attempt TTL and could keep
the measurement past the stated last-good age. Accepted root cause; repair only the new key
and explicit-OAuth cache hit paths, with deterministic clock boundary regressions. Existing
three OAuth reader cache behavior stays outside this repair. No local execution authorized.

Remote CI run33939675289 at979249852 failed typecheck (`TS2322`, quota.ts1808): inferred
object return widened unique sentinel symbols to `symbol`. The valid translator-budget type
fixture failed downstream of that source compile error. Repair is an explicit return contract
for `readExplicitAccountQuota`, not changing or weakening the translator-budget regression.

Independent Wegener review confirmed those two blockers and refined the age case: a failure
which settles after the last-good deadline must recheck measurement age after its await,
not just on the next cache hit. Accepted; both new cache paths gain post-await age checks and
an independently reachable delayed-failure clock fixture before this repair is republished.

The same baseline run's test4/4 also exposed `Kimi quota skips usages when OAuth refresh fails`:
the new current-account dispatch returned an asynchronous reader without awaiting it inside its
catch boundary. Add the missing await so credential renewal rejection degrades to unavailable
as before; retain the existing regression unchanged. This is a separate runtime cause from
the type inference failure, not an assumed CI flake.

Codex GitHub review3939190788 identified the inherited explicit-key-only Kimi guard as
inconsistent with omitted authMode's documented key default. Accepted for this feature:
the shared key selector's initial normalized auth guard already rejects OAuth/forward/local,
so Kimi now uses that same default and its canonical URL check. Added an omitted-mode
per-key regression plus forward-mode negative. This supersedes 020's preserve-stricter-Kimi
note, without adding destinations or sending OAuth credentials down the key path.
