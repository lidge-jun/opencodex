---
name: ocx
description: Drive a running opencodex (`ocx`) proxy from the CLI — account pools, provider routing, model catalog, usage and cost attribution, request logs, access keys, storage cleanup, and the management API. Use when a task involves controlling or inspecting an opencodex proxy rather than editing the opencodex codebase. Triggers: ocx, opencodex, proxy control, account pool, pause account, pool strategy, provider routing, usage report, cost attribution, access key, request log, conversation trace, storage cleanup, management API.
---

# Operating `ocx`

`ocx` controls a locally running opencodex proxy. The CLI covers the dashboard's operational
surface, with one consent exception (starring) recorded under Consent below. `ocx capabilities`
lists the *declared* index, not every verb.

Be precise about the gap, because guessing costs you more than reading: the capability index below
is complete and authoritative for what it lists, and it does not yet list every management route.
A route with no declared capability may still have a working command — `ocx access key` and
`ocx route policy` both work while `capabilities --route` returns nothing for them. So use the
index first, and fall back to `ocx <group> help` before concluding a capability is missing.

This skill is for **operating** a proxy. Two neighbours cover different jobs: `AGENTS_INSTALL.md`
is for installing one, and the repository `AGENTS.md` is for changing the codebase.

## Start here

```bash
ocx capabilities --json
```

That is the machine-readable index of declared verbs, the routes they drive, their flags, and whether they
mutate. Read it first rather than guessing a command name. It is not exhaustive — an unmatched
`--route` exits 4 when the table has no row, even if a working verb exists. The converse of
generation also holds: a verb can exist without appearing here (`ocx access key`, `ocx route policy`).

Narrow it when you already know what you want:

```bash
ocx capabilities --mutating-only --json      # only state-changing verbs
ocx capabilities --route /api/logs           # which verbs drive one route
```

An unmatched `--route` exits 4 rather than printing an empty success.

## Three steps before any management call

1. `ocx ready --json` — is the proxy up and admitting requests?
2. `ocx status --json` — is this binary the same build as the running proxy? A version skew means
   the help and flags you just read describe a *different* build than the one answering.
3. Then the real command, with `--json`.

Skipping step 2 is how an agent ends up reporting that a flag "does not work" when it simply does
not exist in the running build yet.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | usage error — bad or missing arguments; nothing was sent |
| 4 | not found — the named account, provider, key, or route does not exist |
| 5 | conflict — a lock is held or the state changed under you; usually retryable |
| 1 | everything else, including transport failure and any other HTTP error |

**Never read a printed error with exit 0 as success.** Commands used to print a failure and exit 0;
they no longer do, and a source scan keeps it that way. Exit 0 means no error was reported;
inspect the result to see whether anything mutated (cleanup without `--yes` is a preview).

## Reading a failure

A management failure prints up to three lines: the message, then `reason:`, then `hint:`. The
`reason` is the machine-actionable part — branch on it, not on the prose.

Four named classes are worth handling specifically:

| Reason | What it means | What to do |
|---|---|---|
| `oauth_mutation_busy` | another credential write is in flight (503, `Retry-After: 1`) | retry once after a second |
| `catalog_busy` | a catalog gather is in flight (503, `Retry-After: 1`) | retry once after a second |
| a config-mutation lock reason | a config write holds the lock | retry shortly |
| a credential-conflict reason | the install is broken, not busy | run `ocx doctor`; retrying will not help |

The first two are transient by construction and the server tells you how long to wait. The last is
the one to stop on: repeating it just produces the same error more times.

## Consent: one thing you must not do

**Do not star the repository on the user's behalf.** `ocx inspect star` reads the status, and that
is the entire CLI surface for it. The starring POST requires a real dashboard session precisely so
an agent cannot answer that question for its user — it spends *their* GitHub identity, which no
flag can delegate. Do not route around it with `gh`, a direct HTTP call, or a minted session. If
starring would be useful, say so and let the user decide.

The same boundary covers the session-gated `/api/codex-prompt` writes: read them with
`ocx inspect codex-prompt`, and leave the writes to the dashboard.

## Destructive verbs

`storage trash restore` and `storage policy run` refuse without `--yes` (exit 2, nothing sent).
`storage cleanup` without `--yes` is a preview that exits 0 having mutated nothing — do not treat
that 0 as a delete. There is no interactive prompt.

The expected sequence is preview, report, then ask:

```bash
ocx storage cleanup --percent 25 --json      # previews; deletes nothing; exits 0
```

Report the count and bytes from that output and get explicit approval before adding `--yes`.
`--mode quarantine` (the default) can be undone with `storage trash restore`; `--mode permanent`
cannot.

## Remote hub: two things agents get wrong

**Pairing is not hub setup.** Configuring a hub — providers, accounts, routing, keys — never
needs a pairing code. `GET /opencodex-session` mints a session by itself for a loopback
request, and for a `hub` reached over the trusted Tailscale ingress when the login is in
`remoteGui.allowedTailscaleUsers`. A pairing grant is the fallback for a remote browser that
neither position nor identity vouches for. The management API is a separate ladder again: an
agent driving a hub uses the admin token and never pairs. When a human asks "do I have to pair
to set this up?", the answer is no.

**`ocx disconnect` is only half of leaving a hub.** It restores local state and clears the
connection, then tells you the hub key is still valid. Revoke it too: `ocx connect revoke
--admin-token-stdin` while still connected, or delete the key in the hub dashboard under
Integrations → API Keys once the device is gone. Stopping after `disconnect` leaves a working
credential behind.

Credentials for these commands are stdin-only — `--pairing-code-stdin` and
`--admin-token-stdin`. There is no argv or environment form, and that is deliberate.

When `disconnect` refuses, do not route around it. Each refusal means the unwind cannot be
proven safe: another process owns the token, no journal records the pre-connect state, a
different client key owns the journal, or the restore was only partial.

Details, including key rotation's two-step commit: `references/05_remote_hub.md`.

## References

| File | Use it for |
|---|---|
| `references/01_management_surface.md` | the full capability → route map (generated) |
| `references/02_json_shapes.md` | response envelopes and error shapes |
| `references/03_recipes.md` | copy-paste sequences for real tasks |
| `references/04_failure_semantics.md` | exit codes, 503 classes, what to retry |
| `references/05_remote_hub.md` | hub/client roles, when pairing is and is not needed, key rotation, disconnection |

`01_management_surface.md` is generated by `scripts/generate-ocx-skill-surface.ts` and a test fails
if the committed copy drifts from the capability table. When it and the running binary disagree,
believe `ocx capabilities --json`.
