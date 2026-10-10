# Round 2 closeout

Status: CLOSED. Every R lane landed on `dev` and the branch is green again. This file records
what landed, the two incidents the round produced, and the rule the maintainer approved because
of them.

## What landed

| Lane | Pull request | Subject |
| --- | --- | --- |
| R1 | #5331 | Complete the provider-table transition on a paginated OpenAI home |
| R2 | #5338, #5351 | Keep the verification build out of updater signing, then assert the executable the bundle declares |
| R3 | #5332 | Make a failed browser launch and a failed account refresh visible (#5261) |
| R4 | #5342 | Rework #4942 and #4989 into one ambiguous-resend gate with one grant per request |
| R5 | #5347 | Derive the four telemetry pull requests from the landed recorder |
| R6 | #5333, #5345, #5353 | Usage table readability, WidgetKit Developer ID signing, keychain step location |

#5342 is the one to notice. An earlier lane had ruled that #4942 and #4989 must not each buy an
independent replacement send for one logical request, and that they therefore belonged in a
single reworked change rather than two. That disposition closed as an implementation rather than
as a note.

## Incident one: a default flip that no test could see

#5271 removed a hostname test that decided the `developer` wire role. Deleting the inference was
right — a gateway proxying OpenAI accepts the role and the hostname cannot say so. The
replacement default was wrong in the other direction: forwarding to every destination assumed
each one accepts a standard role until an operator marks it.

Three lane dispatches died on `400 role 'developer' is not allowed` within four seconds of
starting. Nothing in this repository saw it first, because every test in the tree was written
against the new default and passed. What broke was outside the tree.

#5334 made the key tri-state with the unset state on the safe side, and then three more landings
were needed because three suites still asserted the forwarded role and the first sweep missed
them: the Lab conformance vector in `src/lab/` (#5341), a suite whose messages come from a
helper rather than a literal (#5344), and a suite about documents that reads the role only to
locate the turn (#5346). Searching for a string is not how you find what asserts a default; the
reliable question is which tests call the adapter at all.

## Incident two: a verification step that had never run

The `macos widget + bundle` job failed on `tauri build` because the updater public key is
committed and the private key is not in CI. #5338 scoped the opt-out to the verification build.
With that green, the Verify step ran for the first time and failed on its first line, silently,
because `test` prints nothing: it asserted `Contents/MacOS/OpenCodex` while Tauri keeps the Cargo
bin name unless `mainBinaryName` is set. #5351 reads `CFBundleExecutable` from the bundle instead.

The same shape appeared once more at the end. #5345's test located a workflow step by name, #5339
renamed that step while the branch was open, and the rename survived the merge while the assertion
did not. #5353 locates the steps by what they run.

## The rule the maintainer approved

A change that flips an existing default is a separate approval item before merge. Tests in the
tree are written against the new default and pass; what breaks is the set of real destinations
outside it, which exact-head CI cannot reach. Two instances landed on the same day — the 1 MiB
queue budget in #5182 and the role default in #5271 — and only the second was caught by a human
noticing that dispatch had stopped working.

## Still open

#5261 keeps two remainders: generic OAuth and key login still discard the launch result, and the
dashboard roster keeps last-good rows after a failed refresh. #4191 wants the SSE fallback and
#5180 the shared cooldown, both transport and routing changes. #5292 records the Logs page union
restatement. #2366, #3748, #3983 and #5063 remain deferred with reasons recorded on each.
