# 030 — Phase 3: write actions on existing endpoints

**Depends on:** `020` (the UI must exist to report a result into).
**Independently verifiable by:** a live provider toggle against the running proxy, plus
the stubbed transport suite for stop. Stopping the developer's own proxy is out of
bounds, and the branches that matter cannot be produced on demand from a healthy one —
see the amended acceptance criterion 1.

Constraint from the user's scope: **no new proxy endpoints.** Everything here calls
routes inventoried in `002` §4.

## Stale check at P (what Phase 2 already landed)

Re-verifying this document against the tree found three items already done, because the
UI phase could not ship a `Stop proxy` button without them:

- `ProxyClient.stop()` and `setProviderDisabled(_:disabled:)` exist (`010`/`020`).
- The confirmation sheet exists as an `NSAlert` in `AppDelegate.stopProxy()`, including
  the `isPresentingModal` guard that keeps the panel alive behind it.
- `ConfirmSheet.swift` is therefore not needed as a separate file.

What remained, and is what this phase delivers: an `ActionCoordinator` that reports what
actually happened, the provider toggle UI, and result feedback in the popover.

## File change map

| Path | Action |
| --- | --- |
| `app/Sources/MenuBarCore/ProxyClient.swift` | MODIFY — three-state liveness, decode the stop `success` flag |
| `app/Sources/MenuBarCore/ActionCoordinator.swift` | NEW |
| `app/Sources/MenuBarUI/ProviderListView.swift` | NEW — disclosure + toggles |
| `app/Sources/MenuBarUI/PopoverViewController.swift` | MODIFY — result banner, provider section |
| `app/Sources/MenuBarUI/AppDelegate.swift` | MODIFY — wire both actions to the coordinator |
| `app/Sources/MenuBarCoreTests/ActionSuite.swift` | NEW |

## `ProxyClient` additions

```swift
/// Returns whether the proxy also restored native Codex on the way out. The response
/// carries `success: false` when `restoreNativeCodex()` failed; only the boolean is
/// decoded, never the server-formatted message.
@discardableResult
public func stop() async throws -> Bool {
    let data = try await send(method: "POST", path: "api/stop", body: nil as EmptyBody?)
    guard let result = try? JSONDecoder().decode(StopResult.self, from: data) else { return true }
    return result.success ?? true
}

public func setProviderDisabled(_ name: String, disabled: Bool) async throws {
    var components = URLComponents(url: endpoint.baseURL.appendingPathComponent("api/providers"),
                                   resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "name", value: name)]
    var request = URLRequest(url: components.url!)
    request.httpMethod = "PATCH"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONEncoder().encode(["disabled": disabled])
    ...
}
```

The PATCH body is exactly `{"disabled": <bool>}` and nothing else. `002` §4 records
`provider-routes.ts:239`: a `disabled`-only patch skips the heavy merged-shape
validators. Adding any second field would silently change the request class.

## `ActionCoordinator.swift`

### There is no restart. There is only stop.

This was the single biggest correction from the Phase-0 audit, and it is worth stating
plainly because an earlier draft of this document got it wrong.

`src/server/management-api.ts:136-147` — `/api/stop` calls `stopServiceIfInstalled()`
**before** responding. That call exists precisely so launchd cannot respawn the proxy.
So a service-managed proxy does not come back on its own, and there is no start endpoint
to call. A control labelled "Restart" would therefore be a lie in every configuration.

**Decision: the app ships `Stop proxy`, never `Restart`.** After a successful stop, the
UI enters the `unreachable` state (`020`) whose next action shows the exact command to
start it again (`ocx start`, or `ocx service start` when a service is installed) as
selectable text. The app does not spawn processes the user did not ask for, and it does
not claim a capability the API does not have.

This removes the `serviceManaged` computed branch an earlier draft assumed. The
`StartupHealth.serviceInstalled` / `serviceEnabled` fields are still decoded in `010` —
they render the status qualifier line in `020`, they just no longer gate an action.

### The drain problem

`002` §4 also records that `/api/stop` answers `200` **before** draining. Treating `200`
as "stopped" would make the UI lie for several seconds.

```swift
public enum ActionOutcome: Equatable, Sendable {
    case succeeded
    /// Stop confirmed; the app cannot relaunch it, so it carries the start command.
    case requiresManualStart(String)
    /// Stopped, but `restoreNativeCodex()` failed — native Codex still points at the
    /// closing port, so the user must run `ocx restore` too.
    case stoppedWithRestoreFailure(String)
    /// User-facing text, never a raw response body.
    case failed(String)
}

public func stop(startCommand: String) async -> ActionOutcome {
    let restored: Bool
    do { restored = try await client.stop() }
    catch let error as ProxyError { return .failed(error.userMessage) }
    catch { return .failed("Could not reach the proxy to stop it.") }

    // Poll until the connection is REFUSED. Any HTTP answer — including 500 or an
    // undecodable body — proves a server is still listening, and a timeout proves
    // nothing at all.
    let deadline = now().addingTimeInterval(Self.stopTimeout)
    var sawIndeterminate = false
    while now() < deadline {
        await sleeper(Self.pollInterval)
        // Cap each probe to the time left, so the last one cannot overrun the deadline
        // by its own timeout.
        let remaining = deadline.timeIntervalSince(now())
        guard remaining > 0 else { break }
        switch await client.liveness(timeout: min(1.5, remaining)) {
        case .refused:
            return restored ? .requiresManualStart(startCommand)
                            : .stoppedWithRestoreFailure(startCommand)
        case .reachable:   sawIndeterminate = false
        case .indeterminate: sawIndeterminate = true
        }
    }
    return .failed(sawIndeterminate
        ? "The proxy accepted the stop, but its state could not be confirmed. Check with `ocx status`."
        : "The proxy accepted the stop but was still responding after 10 seconds.")
}
```

`requiresManualStart` is the honest success case: the stop is confirmed, and the app
says so while telling the user how to bring it back.

### Provider toggle — the default-provider trap

`002` §4 records `provider-routes.ts:178`: disabling `config.defaultProvider` returns
`400` with `"cannot disable the default provider; set another default first"`.

Per `dev-uiux-design` UX-LAZY-01, firing a request guaranteed to fail is not acceptable.
The toggle is disabled up front with an explanatory tooltip:

```swift
// The proxy guard is `rawBody.disabled && name === defaultProvider`, so only DISABLING
// the default is refused. A default provider that is already off must stay toggleable.
let wouldDisableDefault = isDefault && provider.isEnabled
toggle.isEnabled = !wouldDisableDefault
toggle.toolTip = wouldDisableDefault
    ? "This is the default provider. Choose another default in the dashboard first."
    : nil
```

**`defaultProvider` comes from `GET /api/config`, not `/api/settings`.** The audit
verified the live `/api/settings` key set is exactly `codexAutoStart`, `port`,
`hostname`, `streamMode`, `startupHealth`, `codexRuntime` — no `defaultProvider`.
`/api/config` returns it (`"defaultProvider": "openai"` live). `010` adds a
`ProxyConfigSummary` model and `config()` client method for this.

Optimistic update with rollback: flip the switch immediately, send the PATCH, and revert
with an inline error on failure. Reverting is the required behaviour — leaving a switch
in a state the server rejected is the "fake state" tell.

## Confirmation policy

| Action | Confirmation | Why |
| --- | --- | --- |
| Stop proxy | **Yes** — sheet | Disruptive: kills in-flight requests, and nothing restarts it |
| Provider disable | No — optimistic + undo | Cheap and reversible |
| Provider enable | No | Strictly additive |

`dev-uiux-design` UX-LAZY-01 exempts destructive actions from magic defaults, and stopping
a proxy mid-request is destructive. Everything else stays frictionless.

`ConfirmSheet` states the concrete consequence — "In-flight requests will be interrupted,
and OpenCodex will not restart on its own." — not a generic "Are you sure?".

## Security rules

- Write requests carry the key in `x-opencodex-api-key`, read from the Keychain lazily
  (`010`), and never in a URL query.
- No response body ever reaches a log, an error string, or the UI verbatim. Failures map
  to a fixed set of human sentences.
- **No shell execution at all.** The app never spawns `ocx` or any other process; it only
  displays the command for the user to run. This is stricter than PR #387, which shelled
  out to the CLI, and it removes an entire class of injection and privilege concerns.
- The app never writes to `~/.opencodex/config.json` directly; all mutation goes through
  the management API so the proxy's own validation runs.

## Tests (`ActionTests`)

Stubbed `URLProtocol`:

- `stop()` on `200` → `.requiresManualStart` only after reachability actually drops.
- `stop()` where the port keeps answering → `.failed`, never a false success.
- `setProviderDisabled` sends `PATCH /api/providers?name=x` with body exactly
  `{"disabled":true}`.
- A `400` response reverts the optimistic toggle.
- The default provider (from `/api/config`) has its toggle disabled before any request is
  attempted.
- No code path constructs a `Process` / `NSTask`.
- No error path leaks a response body into `ActionOutcome`.

## Code-review corrections (folded before B closed)

### Round 6

| Finding | Correction |
| --- | --- |
| The continuation tests could still pass without entering the continuation: `gateEntered` proved cycle 1 reached the gate, but nothing proved the *waiter* had registered before the gate was released. Under starvation the waiter could start afterwards, take the ordinary path, and satisfy every assertion | `PollingCoordinator.waiterCount` is exposed and the tests poll it until registration is observed, then assert it returns to zero. No `Thread.sleep` remains as synchronisation |
| No test drove `MenuBarUI` at all, so the Phase 3 rollback, pending-versus-poll, and default-direction behaviours — every one of them a defect found in an earlier round — had zero regression cover | New `MenuBarUITests` target (7 cases) with read-only inspection hooks on `ProviderListView` |

**Sabotage-verified.** Both previously-fixed defects were reintroduced and the suite
caught exactly the right two cases: making the default guard direction-insensitive failed
"a disabled default provider can still be switched back on", and dropping the intended
value in `rebuildRows` failed "a stale poll cannot undo an in-flight optimistic change".
The other five stayed green.

### Round 5

| Finding | Correction |
| --- | --- |
| The "queued cycle fails" test never consumed a failure: with the popover closed a cycle takes exactly one health response, and the queue led with three 200s, so it re-tested the success path | The popover is opened first (consuming its own five-response cycle), then one gated 200 followed by refusals. A new `snapshot.state == .unreachable` assertion proves the failure was actually consumed — and it is what caught this |
| The gate was read and written without the stub's lock, and the test inferred "the request reached the gate" from a 200ms sleep | `setGate`/`currentGate` go through the same lock, a `gateEntered` semaphore lets the test wait for the request to actually arrive, and `defer` releases the gate so a mid-test failure cannot wedge the suite |

### Round 4

| Finding | Correction |
| --- | --- |
| Both `refreshAndWait` tests ran with `refreshInFlight == false`, so neither entered `waitForCompletion()`. They would have stayed green if the continuation never resumed — no regression proof for the concurrency fix that closed the round-3 blocker | `StubProtocol` gained a request gate. Two new tests hold a cycle suspended, assert the waiter has NOT returned, then release and assert it does — one for a succeeding queued cycle, one for a failing one |

**Sabotage-verified, and the sabotage itself needed a second pass.** A test that passes
proves nothing about a path it never takes:

- Removing `waiter.resume()` entirely makes the suite hang until timeout instead of
  passing, so both gate tests genuinely depend on the continuation.
- Removing the signal from only the `ProxyError` exit does NOT fail the suite. A signal
  trace (`RELEASE site=…`) showed why: the failing cycle releases at that site, but when
  it is muted another exit path still reaches an idle state and releases the waiter. The
  waiter is therefore protected by several exits rather than by exactly one, which is
  the safer arrangement but means single-site sabotage is not a valid probe here.

Recording both results because the second one is the kind of thing that quietly
invalidates a "verified" claim.

### Round 3

| Finding | Correction |
| --- | --- |
| `liveness()` went through the generic `send()`, so a 401 with a stored key triggered a credential retry — spending a second full timeout re-asking a question the 401 had already answered, and downgrading a known-reachable result to indeterminate if that retry failed | Liveness now calls `perform()` directly: one attempt, no retry |
| The stop loop always requested a 1.5s probe, so the final one could overrun the 10s deadline | Each probe is capped to `min(1.5, remaining)`, and the loop breaks when no time is left |
| `refreshAndWait()` spun on shared booleans with a 5s bound, which a legitimately slow cycle can exceed — re-enabling the switch against pre-write data, the exact window it was added to close | Waits on a continuation released when no cycle is running or queued |

### Round 2

| Finding | Correction |
| --- | --- |
| `.timedOut` and `.networkConnectionLost` were still mapped to `.unreachable`, so the three-state contract was two states in practice and a timeout could confirm a false stop | New `ProxyError.inconclusive`; only `.cannotConnectToHost` becomes `.refused`. Liveness probes also take a 1.5s timeout so one probe cannot overrun the stop deadline |
| `rebuildRows()` initialised switches from the snapshot, so a poll landing mid-write visibly snapped the switch back despite the row being busy | `pending` now stores the intended value, applied before the row is marked busy |
| The post-write refresh coalesced and returned immediately, so the switch became interactive against pre-write data | `refreshAndWait()` waits for a cycle to actually complete |
| The document still required a live stop at the top and carried pre-review snippets | Verification line and all three snippets updated to what shipped |

### Round 1

| Finding | Correction |
| --- | --- |
| `isReachable()` treated every non-401 error as "gone", so a 500 or a decode failure during polling reported a stop as confirmed while an HTTP server was still listening | Three-state `liveness()`: `reachable` (any HTTP answer, including 401/403/500 and undecodable bodies), `refused` (the only proof), `indeterminate` (timeouts prove nothing) |
| `/api/stop` returns `success: false` when `restoreNativeCodex()` fails — the proxy still exits, but native Codex is left pointing at a closing port. The body was discarded and the app said "Proxy stopped" | Decode only the boolean, never the server's message. New `stoppedWithRestoreFailure` outcome tells the user to run `ocx restore` |
| Two rapid toggles could reach the server out of order, leaving it opposite to the user's last click | One in-flight write per provider in the coordinator, and the row goes inert until its authoritative refresh lands. Pending state survives `rebuildRows`, so a poll cannot resurrect the pre-toggle switch |
| A default provider that was already disabled could never be re-enabled: the switch was inert whenever `isDefault`. The proxy guard is `rawBody.disabled && name === defaultProvider` — only *disabling* is refused | The switch is inert only when it would disable an enabled default |
| The "exact body" test encoded its own dictionary and compared that, so it would pass with no request body at all | `StubProtocol` now drains `httpBodyStream` and the test asserts on the decoded actual body |
| An outcome test built non-empty literals and asserted they were non-empty | Replaced with one that drives three real failure paths and checks the user-visible message, including that no response body leaks |
| Acceptance criterion 1 demanded a live stop while the notes said stop was deliberately not run live | Criterion amended with its reasoning; see below |

## Implementation notes

**The stop timeout needed an injectable clock, not just a no-op sleeper.** The first test
for "a proxy that keeps answering is a failure" passed a sleeper that did nothing — and
the test failed, reporting success. The loop is bounded by a wall-clock deadline, so
skipping the sleep without advancing the clock means the deadline never arrives. Both the
sleeper and `now` are injected.

The same test also exposed a harness trap worth recording: `StubProtocol` falls back to
"connection refused" once its response queue drains, which reads as a successful stop. A
test that queues too few responses will pass for the wrong reason.

**Live verification** against the running proxy (`ActionProbe`, removed after use):

```text
default provider: openai
target: anthropic enabled: true
disable    -> succeeded    proxy now reports enabled: false
re-enable  -> succeeded    proxy now reports enabled: true
default-provider guard -> failed("openai is the default provider. Choose another default…")
```

Proxy state was confirmed restored afterwards: 10 providers, 10 enabled.

`stop` is covered by the stubbed suite rather than live, per the amended criterion 1
above. The branches proven there are the ones a healthy proxy cannot demonstrate:
`success: false` from a failed native-Codex restore, a 500 mid-poll, an undecodable 200,
and a proxy that accepts the stop but keeps answering.

## Accept criteria

1. Stop behaviour proven deterministically rather than by stopping the user's proxy.
   **Amended criterion:** stopping the developer's own running proxy is out of bounds —
   it would interrupt their work, and the failure modes that matter (a 200 that never
   drains, a 500 during polling, `success: false`, an undecodable body) cannot be
   produced on demand from a healthy proxy anyway. The gate is therefore the stubbed
   transport suite, which covers every branch, plus a live read confirming the proxy is
   still healthy afterwards.
2. Provider disable + re-enable executed live and reflected in `/api/providers`.
3. The default provider's toggle is inert and explains why, using `/api/config`.
4. Failure paths surface a human sentence, never a raw body.
5. No `Process` / `NSTask` usage anywhere in `app/`.
6. `swift run --package-path app MenuBarCoreTests` and
   `swift run --package-path app MenuBarUITests` both green.
