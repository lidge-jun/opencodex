# wp5 — what counts as proof

The goalplan's five criteria, and the evidence each one accepts.

1. **The page shows it.** Not "the list contains omo" — a dashboard rendering an
   omo row in the overview grid and an omo tab that opens `integrations/omo`,
   captured from **this worktree's** built GUI rather than whatever build the
   long-running proxy on `:10100` happens to be serving. The silent hazard in
   `020` is precisely the failure that passes every other check, so a
   source-level assertion cannot discharge this one.
2. **The bytes are right.** `ocx export --client omo` emitting a document whose
   provider block matches what senpi parses, naming the path
   `omoConfigPath` resolves. Evidence is the emitted text plus the senpi parser
   citation in `001`.
3. **`bun run typecheck`** clean.
4. **Focused tests.** The new omo test plus every exact-list test named in
   `010` and `020`, run by path — including `tests/cli/cli-help.test.ts`, which
   is the only thing that catches a stale `(13 clients)` literal. The full suite
   is the PR gate, not this one.
5. **Round trip.** Enable then disable omo through the integrations API against
   a temporary home, and show the config file returns to its prior bytes — the
   ownership claim, not just the write.

Anything short of these is reported as it is. A rendered page is not inferred
from a green test, and a green test is not inferred from a compiling record.
