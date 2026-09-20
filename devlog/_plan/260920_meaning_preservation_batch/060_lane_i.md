# Lane I — per-key scope on the unrouted data planes

Status: OPEN. Branch `codex/260920-lane-i-key-scope-dataplane` against `dev`, one pull request,
ordered commits. Base is `origin/dev` at `043aa435ff`.

Scope is one thing: the part of #5049 that #5265 (`447ac22ca6`) could not reach. That change put
the model and provider scope on the resolved route, at the single capture point every Responses
destination passes through, and Chat and Messages inherit it by translating into that path. Four
authenticated endpoints spend provider quota without ever resolving a model through the router, so
the predicate never saw them.

## What each surface turned out to be

### Images

`handleImages` can settle on four different destinations, and only two of them use the model the
caller sent. The ChatGPT forward account and a keyed OpenAI provider relay the body verbatim; the
xAI Imagine bridge always runs `images.bridgeModel` on the configured xAI provider; the Antigravity
fallback always runs its own CCA image model. Judging the body would therefore have authorized one
thing and billed another on two of the four branches, which is the failure the landed design names.

Each branch is checked as it is entered — the bridge and the Antigravity fallback before they
resolve a credential, the two relays before the forward probe lease is consumed or the keyed picker
commits a rotation. A refused request spends nothing and mutates nothing.

### Audio and voice

Transcription, the dictation socket, external voice call-create and the external sideband join all
resolve through `resolveAudioUpstream`, which already receives both the admission and the model the
upstream will run. One check on each of its two return paths covers all four endpoints. The forward
path releases its probe lease on refusal, mirroring the adjacent unusable-account branch.

The native `/v1/live` and `/v1/realtime/calls` path does not share that resolver, so it needed its
own: `resolveLiveRelay` now takes the destination it is resolving for. The model is read where the
client states it — `session.model` in a JSON or multipart call-create, the `model` parameter of a
standalone socket query — and a join onto an existing call carries the default, because the call it
attaches to stated its model when it was created.

### Search

The brief expected the non-account-qualified branch to hand the caller's model to the sidecar. It
does not, and the distinction matters for where the check belongs. There are two unrouted branches,
not one:

- the forward relay copies the caller's model to whichever ChatGPT account the upstream resolved,
  and that account is billed for it;
- the sidecar fallback ignores the caller's model entirely and runs the backend and model the
  operator configured, spending that backend's own credential.

Both are destinations a scoped key must not reach, so both are checked — the first against the
resolved account and the caller's model, the second against the configured backend and the model
that backend runs. Exa has no provider entry, so its backend name is its destination. The
account-qualified branch keeps the single check #5265 gave it and is not judged twice.

## Rules that fell out of the review

A request that names no model has no destination a model list can allow: the relay would copy the
body and let the upstream pick. `UNNAMED_DESTINATION_MODEL` makes that explicit, so a key scoped by
model is refused rather than sent to a provider default. A key scoped only by provider is
unaffected, and a key with no scope at all reaches every surface exactly as before.

No new policy system was introduced. `admissionScopeDenial` is a three-line composition of the
landed `resolveAdmissionModelScope`, `routeAllowedByScope` and `admissionModelDeniedResponse`,
shaped for handlers that return a `Response` rather than throwing into a route resolver. Every
refusal is the same 403 naming the caller's own selector, with the resolved destination left to the
server log.

## Explicitly out of scope

Redis, multi-tenancy, budgets and RPM/TPM ceilings. Nothing here reads or writes a credential, and
no new field is logged: a refusal carries the selector the caller already knows and no account
identifier, provider credential or request body.

## Verification

Static review against the `dev` source plus exact-head hosted CI. Per the lane instruction the
local suite, focused test files, `typecheck`, `build`, `install` and any running `ocx` were NOT
RUN; the file-size ratchet and the union-exhaustiveness classes were checked by reading the
baseline and the changed files instead. No touched file carries a baseline cap, and the largest,
`src/server/index/serve-options.ts`, stays well under the 2000-line threshold. The four new test
files are registered in both `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`.

## Remaining scope on #5049

The issue stays open for the coordinator to judge. This lane closes the four endpoints named in the
#5265 adversarial review and nothing beyond them.

## What the first review round changed

Three findings on PR #5290, all of them about a destination the first pass was willing to assume.

The refusal marker was being used as a model id. A request that named no model was checked as the
literal `(unnamed)`, which the configuration schema accepts like any other string, so an operator
who copied it out of a refusal into `allowedModels` would have granted "whatever the upstream
picks". The absent model is now absent: the denial helper takes an undefined model id and refuses
any key carrying a model list, judging a provider-only scope on the provider alone. The marker is
message vocabulary and never reaches the comparison.

A Realtime standalone socket was judged as the default. The external audio path read the `model=`
query only for the Frameless style — the one that rewrites its own query — while a
`realtime-standalone` socket forwards that parameter untouched. Both standalone styles now report
the model they forward, through the helper the native path already used.

A join was authorized against an assumed model, and what to do about it depends on what each path
can know. The external path keeps a per-key call registry, so the model a call settles on is now
recorded in its `LiveCallBinding` and a rejoin is judged against it. The native compatibility path
records nothing about the calls it relays and does not gain a registry here — adding call ownership
to it is a different change from closing a scope hole — so a native join, and a native call-create
that sends no session model, name no destination and a key carrying a model list is refused. That
is a real restriction on model-scoped keys and it is written down beside the contract it
constrains, in `structure/data-planes/inbound-compat.md`, rather than left to be rediscovered.
