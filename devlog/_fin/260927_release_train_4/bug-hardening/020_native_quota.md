# B2 — NativeTray percentage conversion

Depends on B1 integration into `dev` so this PR starts at the fresh tip. Carry #6082 as a minimal Swift change with original author credit. It touches the native tray, not a GUI PR or dashboard component.

## Exact file map

| Path | Change from current behavior |
| --- | --- |
| `app/Sources/NativeTray/Models.swift` | MODIFY `percentText` and `percentDescription`: after `number` accepts a finite nonnegative `Double`, reject values at or above the representable `Int` upper bound before `Int(percent.rounded(.down))`. Preserve ordinary flooring and visible/spoken fallback strings. Keep `number` itself unchanged because other percentage consumers need their own policy. |
| `app/Sources/NativeTrayTests/main.swift` | MODIFY: assert a finite `1e20` produces “—” and “Unavailable” rather than trapping; retain 89.9 flooring and nil checks. |
| `structure/companion.md` | REVIEW the native tray formatting contract; MODIFY only if it describes which raw values render. `structure/overview.md` is also reviewed as a mapped app owner. |

## Audit and activation

The failure trigger is a finite percentage larger than `Int.max`, which `NativeTrayFormat.number` currently permits. Verify both visible and VoiceOver calls actually execute their `Int` conversion; the regression test executable must cover each. Check the boundary around `Double(Int.max)` without assuming the floating representation equals the integer exactly. No account selection or quota threshold behavior changes.

## Verification and delivery

`swift run --package-path app NativeTrayTests` is the direct verifier (same executable as the widget CI job); baseline at `24b2f39b77` passed 53 assertions, and the patched result belongs in the phase outcome. Run applicable file-size/format checks and inspect native macOS CI on the exact PR head. The test suite for TS imports does not observe the Swift conversion and is not used as proof of this fix. Merge through a lane-owned PR, then link and close #6082 with thanks.
