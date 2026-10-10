# L3 — retry, admission and combo-recovery integration

## Why this unit exists

Four open pull requests all widen what this proxy is willing to send again. Read one at a time
each looks reasonable; read together they are the same question asked four ways, and the question
is not "does the retry work". It is whether a retry that works still has a bound on what it costs.

The integrating principle for this unit is therefore **not** "retry better". It is: a retry must
leave cost, waiting and duplicate execution bounded. Concretely, three properties have to survive
every change here.

1. **One physical upstream send is charged exactly once.** Not one adapter entry, not one logical
   attempt. The nested ladder that #4546 measured stayed invisible precisely because an adapter
   that sent three times reported one.
2. **Waiting is finite and cancellable.** A recovery path that sleeps must have a ceiling that
   does not depend on what upstream chooses to report, and it must observe the client's abort.
3. **Nothing is replayed after it became observable.** Once a tool call has executed upstream or a
   response has been committed to the client, no path may quietly send the same turn somewhere
   else. A path that can do that is a blocker for this unit regardless of its other merits.

## The four pull requests

| PR | Head at survey | Area | What it widens |
| --- | --- | --- | --- |
| #4865 | `22130fbed5` | `src/adapters/` | Adapter-owned retry ladders admit through the request send budget |
| #4800 | `af985d3d13` | `src/providers/key-failover.ts` | Opt-in transient-5xx replay reaches `openai-responses` key-auth providers |
| #4817 | `7b0d51bafe` | `src/server/responses/combo-stream-preflight.ts` | A zero-output bare SSE `error` may advance a combo |
| #4824 | `2744efb6be` | `src/server/responses/core-combo.ts` | A single-target combo may retry its one target after its cooldown |

### They are not a stack

The obvious reading is that #4817 and #4824 collide, because both are described as "combo
failover". They do not. #4817 edits `combo-stream-preflight.ts` — how a streamed attempt is
*classified* before any output is committed. #4824 edits `core-combo.ts` — what the target loop
*does* once a failure has already been classified. The two files are disjoint, and the merge bases
confirm it: the change sets share no path.

So this unit verifies each PR independently and does not serialise them into one chain. A stack
would buy nothing and would make three PRs wait on the slowest one.

## Order of work

**wp1 — #4865 to completion.** It is first because it is the one that installs the bound the other
three spend. It is also the narrowest: it is not a resubmission of the closed #4621, whose budget
core (`adapterDispatchBudget`, `pendingHopPermit`, `permit.assumeCharge()`) is already on `dev`.
What is left is the three ladders that still issued bare fetches — mimo-free's 401 JWT replay,
command-code's reasoning-effort repair, and the shared google-http transient loop.

**wp2 — #4800, #4817, #4824 in parallel.** Independent verification, each against its own question:

- #4800: does the widened replay stay inside key-auth `openai-responses`, or can it reach another
  auth mode or another transport?
- #4817: is the first-committed-output / error / terminal verdict stable across SSE chunk
  boundaries, or can a split frame change the decision?
- #4824: do wait time, cancellation and retry count all terminate?

**wp3 — evidence.** Each PR ends open, rebased on the current `dev`, with Cross-platform CI
evidence at its exact head. This lane does not merge, does not push to `dev`, and does not rebase
anything outside these four heads.

## Constraints this lane accepted

Verification is static plus hosted CI only. No local suite, typecheck, build, install or `ocx`
invocation is used to reach a conclusion here, so every claim below has to be either a source
reading with a cited path or a hosted run at a named SHA.

All four heads live in forks with maintainer-edit enabled, and Cross-platform CI on a fork pull
request lands in `action_required` until a maintainer approves the run. That approval is the
mechanism by which exact-head evidence exists at all; without it these PRs carry hygiene and
labeller checks and no test evidence.

Flakiness is not a lever. No timeout widening, no added retry, no platform skip, no masking is
used to turn a red run green. The Windows leg is dispatch-only, so a change that reaches Windows
is reported rather than dispatched from inside this lane.
