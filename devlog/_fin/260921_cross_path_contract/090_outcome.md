# Outcome

All eight lanes are on `dev`. The unit closes here; what each lane actually
changed is below, with the parts that were narrowed or left open named rather
than implied.

| Lane | Landed as | What it changed |
|---|---|---|
| L1 | `556b670251` | The ambiguous-resend refusal now carries the same code and the same retry policy on the translated Chat wrapper, the native Chat route and Responses, from one shared verdict instead of three re-derivations from a status code |
| L2 | `0ab648b4e3` | A mid-conversation instruction keeps its slot through the Chat translation inbound instead of being folded into `instructions`; a leading system block is unchanged |
| L3 | `6e0e912ebd` | A recorded `foldDeveloperRoleToSystem` decides the role on the native Chat route as well; the unset default and the caller-message preservation test are untouched |
| L4 | `a6e8df4ec1` | The paginated-history transition is judged by conversation destination — enable, new conversation, resume, restore — rather than by a successful sync, and an admission-token home is still refused |
| L5 | `b20acc79d2` | The request's tool selection is enforced after a sparse-terminal repair, so a forbidden call cannot re-enter the terminal output, and ordinary text beside it survives |
| L6 | `5d3f5db84a` | The integration writes the provider store the client actually reads, with enable, refresh and disable symmetric, and reports an ineffective write instead of success when the store's schema is not one it knows |
| L7 | `34332bb785` | One developer-role policy across the contract document, the configuration reference and its translations, derived from the adapter so a changed default fails a check |
| L8 | `3a0718c81c` | One resend allowance per logical request across the composed recovery legs, with the physical send count and the possibly-executed send count observed separately |

## What this unit did not close

`#5348` is closed because its acceptance is on `dev`. The neighbouring retry
issues about a WebSocket failure stage and single-key 429 handling are not
resolved by L8 and stay open with their remaining scope recorded on the issues
themselves.

## What the audit round changed

The first reviewer pass returned blocking findings and two mistaken ones. The
mistaken pair read a stale checkout and reported L4's refusal and L8's gate as
still absent; both had landed the day before, so those lanes narrowed to the
part that was missing instead of reimplementing what was there. The real
findings — no owned-file set, L1 and L8 overlapping on the send path, L7
depending on L2 and L3 without an order, and two acceptance sentences no job
could observe — are answered in `010_lane_boundaries.md` and were followed.

## Friction worth remembering

Two lanes conflicted on `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json` because each appended its own
registration line. The resolution is always the union; the file is a registry,
not a narrative. One lane's own tests failed for the two familiar reasons: a
test asserting a field name the type does not carry, and a fixture that set an
unbound fingerprint beside `canApply`, which the parser refuses by contract.
Both were fixed by deriving from the source rather than restating it.
