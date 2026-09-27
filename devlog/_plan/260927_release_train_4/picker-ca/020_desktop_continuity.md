# 020 — Applied Desktop egress continuity

Depends on: `010_ca_publication.md`. Work phase `wp2`, class C4. Only the picker lifecycle and its tests change; the existing profile writer remains the row owner.

## File changes (diff-level)

| Path | Change | Before → after |
| --- | --- | --- |
| `src/claude/intercept/runtime.ts` | MODIFY | Read only a boolean `pickerProfileApplied`, rotate, and skip the entire picker proxy bind on failed untrust → retain the inspected applied profile's validated URL/port, clear any prior pending item **before** a fresh rotation, call `ensurePickerCa(configDir, { rotation: "startup" })`, then clear the newly queued outgoing item. Before either removal, ask phase 010's locked owner check whether this pending PEM is still published by a live process; if so, defer without invoking `security` or acknowledging. A failed/deferred untrust, corrupt journal, or deferred publication blocks picker creation. Each safe removal uses a private temporary **public** PEM copy and calls `untrustPickerCa`; only a confirmed result permits exact-entry acknowledgement. Both cleanup passes and acknowledgements must finish before picker construction. |
| `src/claude/intercept/runtime.ts` | MODIFY | `pickerBlocked` leaves the applied profile's egress URL without a listener → bind `startConnectProxy` at the URL's actual loopback port with `interceptHosts: []` and a per-CONNECT decision that is always `{ kind: "blind" }`. This branch creates no picker runtime/controller/TLS leaf, performs no trust add, does not rewrite or remove the profile, and closes the relay in `stop`/error teardown. The live state reports the bound proxy port while the picker runtime remains null. Existing `offlinePickerStatus` may still say `proxy_unavailable`: that reason describes the picker feature/controller, not egress liveness; the runtime state and actual CONNECT prove degraded relay availability. If the port belongs to another process, do not take it over; preserve the row and report a degraded bind failure. |
| `tests/claude-integration/claude-picker-runtime.test.ts` | MODIFY | The failed-untrust test checks only the main intercept port → apply an owned Desktop profile first, read its `egressProxyUrl`, inject failed removal, CONNECT through that exact URL to a fake upstream, assert a 200 blind tunnel and no picker creation/trust addition, and confirm row ID plus previous selection and retry intent stay intact. Check normal startup still arms only after cleanup. |
| `tests/claude-integration/claude-picker-recovery.test.ts` | NEW | Start separate Bun processes with one isolated fixture home, fake `SecurityRunner`, and no actual `/usr/bin/security`. First startup fails removal; a new process retries the recorded old PEM before rotating again; success clears the record and permits picker creation. Also test controller enable with pending cleanup refuses a trust add. Register this `.test.ts` in both `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`. |

## Conditional activation

- Failed old-CA removal with applied profile: inject a listed old fingerprint and removal failure; prove the profile's own URL answers CONNECT and that `claude.ai` is blind, not terminated.
- Same failure without applied profile: no extra open relay is needed; picker remains disarmed and the default intercept pair remains live.
- Process replacement: use a new OS process, not an in-process stop/start that reuses `processAuthorities`; show the old fingerprint is retried from the public journal.
- Partly published rotation: pending PEM still equals `ca.pem` and its matching owner PID is live; a second process must not remove trust for that incumbent or arm its own picker. When that owner exits, retry proceeds.
- Ack lock contention: simulated failed acknowledgement retains the record and keeps picker disarmed, even if keychain removal itself succeeded.
- Later explicit controller enable: while pending remains, the default `ensurePickerCa` refuses and the controller does not call `trustPickerCa` or `rearm`; this prevents a bypass of startup's cleanup order.
- Busy egress port: observe bind refusal, no other process disturbance, row still present for a later retry.

The chosen blind relay leaves Claude Code traffic from Desktop on its normal upstream route during recovery; it never selects the main intercept listener on this egress port. The separate main intercept port retains its existing policy. This is deliberately narrower than enabling picker MITM while a predecessor may remain trusted.

## Results

Startup now drains the public pending-untrust journal before rotation and again after rotation. Each removal uses a private temporary copy of the recorded public PEM; a failed removal, live published owner, corrupt record, or failed acknowledgement keeps the picker disarmed. An applied profile then receives a blind-only CONNECT relay on its validated, recorded egress port. Bind refusal leaves the row and retry record intact. Normal startup constructs the picker only after both cleanup passes finish. The wp1 follow-up repairs a missing owner record under the CA lock on a cached ensure, and acknowledgement now requires a successful untrust result.

**R1 design choice.** Keep the applied row and bind a blind relay at its actual port. Restoring the original profile after an ownership check would change Desktop's selected row and its previous-selection history during a temporary CA cleanup failure. The relay preserves that durable choice and gives Desktop an opaque upstream path until a later startup can safely arm the picker.

Verification: isolated `bun test tests/claude-integration/*picker*.test.ts tests/test-layout*.test.ts tests/ci-workflows/file-size-ratchet.test.ts` passed 129/129; isolated `bun run typecheck` and `bun run privacy:scan` passed. The recovery test uses separate Bun processes and fake keychain runners; the runtime test sends a real CONNECT through the profile URL and verifies bytes through a fake upstream. No live keychain or Desktop installation was touched.

## Proof before closing this phase

Run the affected picker runtime/recovery files under isolated `HOME`, `OPENCODEX_HOME`, `TMPDIR`, plus typecheck. Read the actual CONNECT response and journal state, not merely a mocked `startProxy` call. Do not invoke the user's keychain or installed Desktop.
