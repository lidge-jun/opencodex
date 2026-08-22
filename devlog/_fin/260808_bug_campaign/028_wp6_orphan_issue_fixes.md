# WP6 — bug issues with no fix PR

The live resweep leaves two newly reported defects with no open PR, plus a set
of long-standing tracking items. Both new ones came from reporters who did the
diagnosis themselves, and both are confirmed in source.

| Issue | State | Plan |
|-------|-------|------|
| #1296 | a local Windows ACL failure surfaces as `401 authentication_error` | fix the classification |
| #1297 | antigravity wire session id derives from first-user text | prefer a real conversation identity |

## #1296 — a filesystem failure wearing a credential error's clothes

Confirmed. `src/server/responses/core.ts` passes the raw exception message into
an auth error in three branches (`:875`, `:878`, `:881`):

```ts
return { ok: false, response: formatErrorResponse(401, "authentication_error", err.message) };
```

When the underlying failure is Windows ACL hardening, that message can be the
literal `ACL hardening skipped — previous attempt timed out`
(`src/lib/windows-secret-acl.ts:604`), delivered as a 401. The user is told
their credential was rejected while the actual cause is a directory tree under
`~/.opencodex`.

**The repository already knows how to do this correctly on the other surface.**
`src/server/management-auth.ts:76` and `:95` classify the same failure as
`management token directory ACL hardening did not complete` with actionable
guidance. The data plane has no equivalent, which is the whole defect: same
cause, two surfaces, one of them honest.

What makes the fix tractable is that the ACL errors are already tagged. They
carry `code` values — `ETIMEDOUT` for a real timeout
(`windows-secret-acl.ts:423`), `EACLRETRYEXHAUSTED` when the single recovery
attempt is spent (`:600`), `EICACLS` otherwise — so classification does not
require string matching.

### Diff-level plan

1. A predicate that recognises an ACL-origin error by `code`, not by message
   text. String matching on an error message is how the next rename silently
   turns the classification back off.
2. In each of the three `core.ts` branches, check it before the 401 and return
   a **503** with a type that is not `authentication_error`, naming the local
   cause and pointing at the remediation.
3. Do not include the raw path. The message may name the *kind* of failure; it
   should not print a filesystem path into a client-visible error.

The reporter's own expectation is the right acceptance bar: whatever the status,
it must not be indistinguishable from "your token is bad", because the two have
opposite remediations.

### Reproduction, and what it is honestly worth

The reporter states plainly that they no longer have a live reproduction —
they fixed their local trigger — and that the mechanism is unchanged in 2.11.0.
That is an honest report of a structural defect rather than a captured one, and
it is checkable in source without Windows: the three branches pass `err.message`
through unconditionally.

I have no Windows host either, so the regression will exercise the
classification directly with a synthetic ACL-coded error rather than pretending
to reproduce the icacls stall.

## #1297 — an id that must be stable, derived from something that is not

Confirmed by reading. `antigravitySessionId`
(`src/adapters/google-antigravity-wire.ts:53`) hashes the first user message
text. Its own comment states the invariant it must satisfy:

> the id must stay stable across every turn, because the replay cache observes
> signatures on turn N's response and re-injects them on turn N+1's request

First-user text satisfies that only while the first user message survives
verbatim in what the adapter sees. Codex compacts, summarises, and trims long
histories; when it does, the anchor changes, the id changes mid-conversation,
and cached thought signatures stop being found. The textless fallback is worse
by construction — `-${Math.random()}` is a fresh id every turn.

The reporter is careful to separate two failure modes, and the distinction is
the important part of the report: the existing comment defends *collisions*
(two conversations opening with identical text) by noting the replay cache keys
on `functionCall` identity. That argument is sound for collisions and says
nothing about *instability*. A shared id still finds the association; a changed
id loses it.

### Diff-level plan

`OcxParsedRequest` already carries `promptCacheKey` (`src/types.ts:239`), which
is the Responses prompt-cache affinity key — purpose-built to be stable across
the turns of one conversation. Preference order:

1. `promptCacheKey` when present, hashed the same way so the wire format is
   unchanged;
2. first-user text as today, for clients that send no conversation metadata;
3. the random fallback, unchanged, when there is neither.

The hash and mask stay identical so the id shape (`-<uint63>`) does not move.
Only the input changes, and only when a better input exists.

### Evidence level, stated rather than implied

The reporter says explicitly this is a mechanism-level report, not a captured
failure — they found it reviewing the adapter and cannot produce a deterministic
capture. That is worth honouring rather than overselling: the regression will
prove that consecutive turns whose first-user text differs still derive the same
id when a `promptCacheKey` is present, which is the invariant the code claims
for itself. It will not claim to reproduce a Gemini-side signature failure.

## Acceptance

1. #1296: an ACL-origin failure no longer returns `authentication_error`, with
   a regression driving a synthetically coded error through the classification.
2. #1297: a `promptCacheKey`-bearing request derives a stable id across turns
   with differing first-user text, and the text and random paths are unchanged
   when no key is present.
3. Each fix has an ablation that fails without it.
4. Full suite, typecheck, privacy scan green.
5. Neither PR overstates the reporter's evidence level.

---

# Audit fold — both plans were wrong about their central mechanism

The review rejected each plan's load-bearing assumption. Not details: in both
cases the thing I proposed to build on does not do what I said it does.

## B1 — `promptCacheKey` is the wrong anchor, and the repo already says so

I picked it because the name sounded like conversation affinity. It is
**unvalidated client input**: `src/responses/schema.ts:148` accepts any string
and `src/responses/parser.ts:661` copies it through. Worse, this repository has
already decided this question in the opposite direction —
`src/adapters/cursor/request-builder.ts:227` warns explicitly against using a
shared `prompt_cache_key` as a conversation id, and Claude Desktop cache
cohorts are marked as **shared across conversations**
(`src/server/responses/core.ts:620`, `src/server/claude-messages.ts:701`).

So my fix would have traded an unstable anchor for a shared and
attacker-choosable one. Hashing does not repair either property.

### The right anchor was already in front of me

`_clientThreadId` (`src/types.ts:21`) is documented as "stable upstream client
thread identity, used only to derive provider-scoped continuation ids", and is
populated from the `x-codex-parent-thread-id` header
(`src/server/responses/core.ts:1413`).

The decisive detail is what already consumes it: **`replayCacheScope`**
(`core.ts:2745`, `:2792`). That is the very cache #1297 is about. The system
already scopes signature replay by thread id, and the Antigravity adapter
derives its own id from message text instead — so the two disagree by
construction.

Revised preference order:

1. `parsed._clientThreadId` when present, hashed identically so the
   `-<uint63>` wire shape does not move;
2. first-user text, unchanged, for clients that send no thread header;
3. the random fallback, unchanged.

Still to prove before writing it: that `_clientThreadId` actually reaches the
Antigravity adapter on that path, rather than being set on a `parsed` the
adapter never sees. That is a check, not an assumption — the last two anchors
were chosen on plausibility.

## B2/B3 — the #1296 path I planned to fix does not exist on `dev`

This is the more serious finding, because I confirmed the defect by reading
three lines and never traced whether anything can reach them with an ACL error.

- `CodexDirectAuthenticationError` takes **no message** — it is a fixed
  missing-bearer string (`auth-context.ts:132`).
- `ForwardAdmissionCredentialError` is a fixed proxy-bearer message
  (`auth-cors.ts:359`).
- `CodexPoolAuthenticationError` accepts only a message and preserves neither
  `code` nor `cause` (`auth-context.ts:108`).

And upstream of all three: the read-path hardening is `required: false`
(`src/config.ts:1426`, `src/codex/account-store.ts:88`), which returns
`{ ok: false }` instead of throwing, and those callers discard the result.
`grep -rn 'required: true'` shows it only on write paths — lock files, the
profile manager, the catalog writer, the prompt journal, the spill store, and
management-auth. The OAuth store does not harden with `required: true` at all.

So the reporter's chain — poisoned `auth.json` → refresh cannot persist → 401
carrying the ACL text — cannot occur through the branches I named. A synthetic
coded error pushed through one of them would have tested a state production
never produces, and the regression would have looked green while proving
nothing.

Where a real local-storage failure *would* surface, per the audit, is
`CodexAuthContextError`, which does carry the original in `cause`
(`auth-context.ts:424`) and is already mapped to a fixed 401 at
`core.ts:868` — plus equivalent wrappers at `responses/compact.ts:385`,
`server/search.ts:129`, and `server/images.ts:394`. My three-branch inventory
was both overinclusive and incomplete.

### Revised approach for #1296

**Do not patch on the strength of a reported chain that current source does not
support.** The next step is to trace one genuine producer-to-surface path on
`dev`: find a `required: true` harden whose throw can reach a client-visible
auth error, and follow it. If one exists, the fix is to preserve a typed
local-storage cause through the wrapper and classify it at *every* surface that
maps that wrapper, not just in `core.ts`.

If no such path exists on `dev`, the honest disposition is to say so on the
issue: the misclassification shape is real and worth guarding, the specific
2.10.x chain appears to have been closed by the move to `required: false`, and
the reporter deserves that stated plainly rather than a fix that performs
diligence against a synthetic error.

### B4 — the code set was incomplete anyway

`sanitizedAclError` preserves `EACCES`, `EPERM`, and `EACLIDENTITY` in addition
to `ETIMEDOUT` and `EICACLS` (`windows-secret-acl.ts:573`). A predicate limited
to my three values would have left related failures misclassified — a smaller
error than B2, but the same species: I enumerated from the two constants I had
read rather than from the function that produces them.

## Revised acceptance

1. #1297: `_clientThreadId` **proved** to reach the Antigravity adapter, then
   preferred over first-user text, with a regression showing two turns whose
   first-user text differs derive the same id.
2. #1296: one real producer-to-surface path traced on `dev` before any patch;
   if none exists, a documented disposition on the issue instead of a fix.
3. Ablations that fail without each change.
4. Full suite, typecheck, privacy scan green.
5. Neither PR overstates the reporter's evidence level — or mine.

---

# Second audit fold — the precedent I found was a second instance of the bug

## The Vertex path is not a precedent, it is another defect

Having been told `promptCacheKey` was the wrong anchor, I went looking for how
the codebase does it correctly and found `vertexReplaySessionId`
(`src/adapters/google.ts:56`), whose comment reads "Prefer Codex's stable
opaque thread key". I read that as vindication for the shape of my fix.

It is not. The function's comment says thread key; the code reads
`parsed.options.promptCacheKey` — the same arbitrary Responses input the audit
had just rejected, and the same field `src/adapters/cursor/request-builder.ts:227`
warns against using as a conversation id. **The Vertex replay namespace has the
same defect #1297 reports for CCA**, differently shaped.

I had found a second instance of the bug and mistaken it for the fixed version,
because the comment described the right thing while the code did something else.
That is the third time in this work-phase I have taken a name or a comment as
evidence of behaviour.

**Consequence:** do not copy Vertex into CCA. Record Vertex as an analogous
unresolved misuse on the issue, so the next person does not repeat my reading.

## What is actually confirmed

`_clientThreadId` **does** reach the adapter. It is assigned at
`core.ts:1413` and that same `parsed` object is handed to
`adapter.buildRequest()` at `:1863` and `:2833`. It is simply unreferenced in
`google.ts` today, which is why grep found nothing — absence of use, not absence
of availability.

## The contract distinction I had missed

"Give CCA what Vertex has" is wrong for a second reason beyond B1. The two
values are not the same kind of thing:

| Path | Value | Scope |
|------|-------|-------|
| Vertex | `vertexReplaySessionId` | **local** replay namespace only |
| CCA | `antigravitySessionId` | local replay key **and** a Google-visible wire field, sent as `request.sessionId` (`google.ts:390`) |

So changing the CCA id changes what goes on the wire to Google, while changing
the Vertex one does not leave the process. Any fix must keep the `-<uint63>`
shape, test request serialization, and — importantly — **claim nothing about
Google accepting or benefiting from a different identity**, since I have no
provider evidence for that.

It is also a scoped repair, not a universal one: a client that sends no
`x-codex-parent-thread-id` keeps the unstable text fallback. That belongs in
the PR body rather than being discovered by the next reader.

## #1296 — disposition confirmed, with the wording corrected

"Do not patch" is right, but my draft leaned toward "the reporter's chain was
closed by the move to `required: false`". That overstates what I checked: I
found no current producer-to-401 path, which is not the same as proving the
historical one is gone, and a write-path ACL failure may still surface
somewhere I have not traced.

Honest wording for the issue: **no current producer-to-401 path found on
`dev`**; the misclassification shape is real and worth guarding; a versioned
repro or a stack trace would change the answer. Not closed as disproven.

## Final acceptance

1. #1297: CCA wire id prefers `_clientThreadId`; tests prove same thread +
   differing first-user text + differing cache keys → one identity, and
   different thread ids do not collide. Wire shape and serialization asserted.
   No claim about Google-side benefit.
2. #1297 report also records the Vertex misuse as an analogous open item.
3. #1296: documented disposition, phrased as "no current path found" rather
   than "disproven".
4. Ablation, full suite, typecheck, privacy scan.

---

# Outcome

| Issue | Disposition |
|-------|-------------|
| #1297 | **fixed** — PR #1311 |
| #1296 | **open, diagnosed** — no current producer-to-401 path found |

## What the review kept catching

Four rounds on two issues, and the same species of error each time: **I read a
name or a comment and treated it as evidence of behaviour.**

1. `promptCacheKey` — the name says cache affinity, so I used it as conversation
   identity. It is unvalidated client input, and the repo already warns against
   exactly this in `cursor/request-builder.ts`.
2. `vertexReplaySessionId` — its comment says "Prefer Codex's stable opaque
   thread key". The code reads `promptCacheKey`. I found a second instance of
   the reported bug and read it as the fixed version.
3. The three `core.ts` branches — I confirmed #1296 by reading three lines that
   pass `err.message` into a 401, and never checked whether anything can reach
   them carrying an ACL error. Nothing can: two take fixed messages, the third
   preserves neither `code` nor `cause`, and read-path hardening no longer
   throws.
4. `codex-thread:` prefixing — I called it namespacing that "cannot collide". A
   first message equal to the prefixed form collides deterministically; the
   reviewer produced it, and I reproduced it before narrowing the claim.

Each was cheap to check and I checked none of them until asked.

## #1297 — the fix, and what it does not claim

CCA wire id now prefers `_clientThreadId`, prefixed before hashing. Seven tests,
one property each, including an **envelope-level** one: the changed value goes on
the wire to Google as `request.sessionId`, so proving the derivation is not the
same as proving it arrives. Ablation fails 4.

Stated in the PR rather than left for a reader to find: a client without the
thread header keeps the unstable text anchor; the residual prefix collision is
asserted rather than hidden; deploying changes the Google-visible session id for
conversations already in flight; and no claim is made that Google benefits from
the new identity, because there is no live CCA evidence for it.

The Vertex misuse is recorded on the issue as a separate open item. Bundling it
into a fix for a different path would have hidden it.

## #1296 — diagnosed, not patched, and not closed

The misclassification shape is real; the reachability is not established. I
drafted a fix that pushed a synthetically coded error through the three branches
and abandoned it, because a regression against a state production never creates
is a green test that proves nothing.

The wording on the issue matters: **"no current producer-to-401 path found"**,
not "disproven". I have not traced every write-path ACL failure to its surface,
and the reporter's 319 logged occurrences on 2.10.x happened. A stack trace or
exact version would settle which producer it was.

Also left for whoever picks it up: the ACL errors already carry codes
(`ETIMEDOUT`, `EICACLS`, `EACCES`, `EPERM`, `EACLIDENTITY`,
`EACLRETRYEXHAUSTED`), so classification never needs message matching — and my
first draft's code list was missing three of those, enumerated from the two
constants I happened to have read.
