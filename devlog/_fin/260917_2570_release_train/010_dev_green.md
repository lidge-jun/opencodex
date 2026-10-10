# wp2 — turn `dev` green

## The question

Five consecutive Cross-platform CI runs on `dev` failed between `2203277ad4` (run `35091966777`,
the last recorded success) and the tip `2b19983bfd`. A release cannot be cut from a tree whose tip
has no green run, and a repeated red usually means a regression. The question this phase answers is
whether it is one.

## It is not. Every failure is a harness or runtime flake.

| Run / SHA | Job | Failing test | Class | Evidence |
| --- | --- | --- | --- | --- |
| `35118018849` / `2b19983bfd` | windows 1/6 (`104868879572`) | codex app-server restart routes ride the management gate | filesystem teardown | No auth assertion failed. The failure is an `EPERM` in teardown at `tests/server/server-management-auth.test.ts:223`, after the 15-second removal retry in `scripts/test-temp.ts:195`. |
| `35106190898` / `d2808c0619` | test 1/4 (`104827965367`) | MiniMax CLI wrapper returns 502 when the proxy address is unavailable | port reuse | Expected 502, got 404 at `tests/providers/minimax-clients.test.ts:455`. The fixture releases `deadPort` before opening another port-0 listener (lines 441-448); when the port is reused the bridge calls itself and `src/cli/minimax.ts:158` answers 404. |
| `35098735960` / `d210c46dab` | windows 6/6 (`104804049418`) | client commit guard (deny) | first-touch timeout | The child hit the fixed 30-second deadline at `tests/codex-integration/client-injection-guard.test.ts:133` while sibling modes passed in 1.3-17s. The same file already warms that cost outside the assertion budget at line 200. |
| `35098735960` / `d210c46dab` | windows 5/6 (`104804049465`) | none — Bun crashed entering the file | runtime | Bun 1.4.2 segfaulted at `0x10` before naming a test in `tests/codex-integration/codex-prompt-layers.test.ts`. |
| `35093667426` / `89bdf5fa4a` | windows 4/6 (`104785869855`) | WP13 A-reduced preserves an OFF Codex config/home | timing | `timed out waiting for runtime-port record; child exit=null`, the condition recorded at `tests/codex-integration/codex-composed-acceptance.test.ts:302`. |
| `35093667426` / `89bdf5fa4a` | windows 5/6 (`104785869870`) | none — Bun crashed entering the file | runtime | Same Bun 1.4.2 segfault. |
| `35093667426` / `89bdf5fa4a` | windows 6/6 (`104785869885`) | an exact search 429 never switches | global state | Expected 429, got a local 401 from process-wide `OPENCODEX_HOME` changing between the credential write and read; `tests/server/server-search.test.ts:323` now calls the handler directly. |
| `35087572377` / `dc9d1fabc8` | windows 5/6 (`104765972689`) | none — Bun crashed entering the file | runtime | Same segfault, repeated after the job's one retry. |

The aggregate `ci` jobs (`104880106091`, `104832004698`, `104813414543`, `104793718177`,
`104774684969`) only propagated these leaves.

## Two conclusions worth keeping

The Windows 5/6 rows are a single class: a Bun 1.4.2 runtime crash entering
`codex-prompt-layers.test.ts`. It entered `dev` at `02bc10e8af` and the tip `2b19983bfd` is the
commit that removes it by pinning Bun back to 1.4.0 (`package.json:79`, PR #4821). So the tip is
the fix for the largest failure class, not another instance of it.

Run `35091966777` is not Windows counterevidence for the earlier reds: its Windows matrix job
`104780185496` was skipped.

## Candidate

`2b19983bfd` is the release candidate, proven by a green Cross-platform CI rerun at that exact SHA
(recorded in `040_release.md`). No product-code change was needed to get there.

## Deferred harness debt

Two fixes would lower the flake rate and are not release blockers, because neither touches product
code and neither is what made the tip red:

- `tests/providers/minimax-clients.test.ts` should start the bridge while the reservation still
  owns `deadPort` and stop the reservation afterwards, instead of releasing the port first.
- `tests/server/server-management-auth.test.ts` should track the `icacls` child that hardens the
  config directory and await it through teardown, so the removal at line 223 is not racing an open
  handle.
