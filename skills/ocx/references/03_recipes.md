# Recipes

Each sequence below was run against a live proxy. Every command named here exists; where the
obvious-sounding command does *not* exist, that is called out rather than left as a trap.

Preflight for all of them:

```bash
ocx ready --json     # {"ready":true,"status":"ready","pid":…,"port":…}
ocx status --json    # confirm proxy.running and no version skew
```

## 1. Audit the account pool and pause an exhausted account

```bash
ocx account list openai --json --quota
ocx account pause openai <account-id> --json
```

Read `accounts[]`; each row carries `id`, `paused`, `selected`, and — only under `--quota` — the
quota windows. Quota is fetched only when asked for, so a bare `account list` shows no percentages.

`paused` and `selected` are independent: a paused-but-selected account still receives requests.
Check both before concluding an account is out of rotation.

Pausing has two side effects the word does not imply: threads pinned to that account are unbound,
and if it was active a fallback is chosen. The CLI prints this on stderr.

To pause everything that is spent in one call:

```bash
ocx account pause-exhausted openai --json
```

Read `pausedAccountIds`, but also `failedAccountCount`: that route refreshes quota per account and
can partially fail. A non-zero failure count means those accounts were never evaluated — which is
not the same as "not exhausted".

## 2. Change pool strategy and sticky limit

```bash
ocx account strategy openai --json          # read
ocx account strategy openai round-robin --json
ocx account sticky openai 5 --json
```

A bare invocation reads and never writes. The response echoes the **applied** value, not the one
you sent, because the server normalizes — compare them if you care whether your value survived.

Both pools have these settings, and the same verbs steer both:

```bash
ocx account strategy anthropic --json
```

`--json` uses pool-neutral keys (`strategy`, `stickyLimit`) for both, so you do not branch on which
pool answered.

Values are not validated locally: the server owns the strategy names and the 1–100 sticky bound and
returns a `reason` you can read.

## 3. Trace one conversation end to end

```bash
ocx logs --conversation <conversation-id> --jsonl
ocx logs explain <request-id>
```

**There is no `ocx request-history` command.** `ocx logs explain <request-id>` is the route-decision
view; it returns `routeDecision` with `routeKind`, every `candidates[]` entry with its `eligible`
flag and `exclusions`, and `selected` naming the winner and the `reason` it won.

`--jsonl` rows carry `requestId`, `conversationId`, `provider`, `model`, `status`, `durationMs`, and
`attempts[]`. Human output prints `conv=<id>` so a conversation filter can be distinguished from an
empty result.

`--provider` and `--model` both match failover attempts, so a request is findable by the model that
actually served it, not only the one requested.

## 4. Attribute spend per account

```bash
ocx usage --range 7d --json
```

Read `accounts[]`. Two things to respect:

- A row with `ambiguous: true` (label `legacy-ambiguous`) aggregates several accounts from before
  labelling existed. Do not read it as one identity.
- Per-account totals are **withheld** under `--provider` or `--model`, because account rows cannot
  be honestly re-partitioned that way. The report says so rather than printing an empty table.

`providers[]` and `models[]` carry `estimatedCostUsd`. Costs are estimates; `estimateReasons` in the
log rows tells you why (for example `usage_estimated`, `expected_price_overlay`).

## 5. Rotate an access key and confirm it went quiet

```bash
ocx access key list --json
ocx access key create rotated --json          # the plaintext key is in THIS response only
ocx access key remove <old-id> --yes --json
ocx access key list --json                    # the old id is gone; check usage on the rest
```

Note the argument style: `create <name>` and `remove <id>` are **positionals**, not `--label` and
`--id`. `remove` also refuses without `--yes`.

The list carries per-key usage, so a key whose count stops advancing is genuinely unused. The
plaintext key appears once, in the `create` response, and is never retrievable again.

An `ambiguous` footer on the list means two configured keys share an id, so per-key totals do not
exist for them — do not attribute usage to either.

## 6. Add a provider, test it, make it default

```bash
ocx provider list --json
ocx provider add <name> --json                # registry providers auto-configure by name
ocx provider test <name> --json
ocx provider set-default <name> --json
```

The promote verb is `set-default`, not `default`. A custom provider not in the registry also needs
`--adapter` and `--base-url` on `add`.

Test before promoting: `provider test` reports reachability and the selected model, and a provider
that answers `list` is not necessarily one that answers a request.

## 7. Diagnose "management API is unreachable"

```bash
ocx ready --json     # is it up at all?
ocx status --json    # is it the build you think, on the port you think?
ocx doctor           # what is structurally wrong (human; `--json` is refused with exit 2)
```

In that order. `ready` false with `doctor` clean usually means it is still starting; `ready` true
with a transport error on a specific verb means the route is failing, not the proxy.

`doctor` has no `--json` mode. It rejects the flag with exit 2 rather than printing prose to a
caller that asked for JSON, so parse `ready --json` and `status --json` for machine-readable
health and treat `doctor` as the human explanation of why they are unhappy.

A credential-conflict reason is the case where retrying is pointless — the install is broken and
`doctor` explains it.

## 8. Preview, then run, a storage cleanup

```bash
ocx storage report --json
ocx storage cleanup --percent 25 --json      # PREVIEW: deletes nothing, exits 0
```

Read `count`, `bytes`, and `candidates[]`. **Report those to the user and get approval before**
adding `--yes`:

```bash
ocx storage cleanup --percent 25 --mode quarantine --yes --json
```

`quarantine` is recoverable:

```bash
ocx storage trash list --json
ocx storage trash restore <entry-id> --yes --json
```

`--mode permanent` is not recoverable. There is no undo, no trash entry, and no confirmation prompt
— only the flag you passed.

The preview runs in both paths because the mutating route requires the `digest` the preview returns
and rejects a stale one with 409. So the two invocations agree about what is being authorized.

## 9. Read Muse Code usage, and know why it can be old

`meta-muse` reports usage differently from every other provider, and the difference changes what
you can conclude from it.

```bash
ocx account list meta-muse --json --quota
```

Each row's `quota` carries the 5-hour and weekly windows plus `updatedAt`. **Read `updatedAt`, not
just the percentages.** Meta publishes no quota endpoint; the value arrives inside a streaming
response and is cached, so it is as old as the last streaming turn through this provider — possibly
hours or days.

```bash
ocx account refresh meta-muse
```

This reports that there is nothing to refresh, and that is correct rather than a failure. A fresh
number would require spending a real inference turn, so no command issues one. To update the
reading, run an actual request through the provider and read the list again.

Two absences are also expected and are not defects:

- An account that has not yet served a streaming turn has **no** `quota` key at all. That is
  distinct from `quotaUnavailable`, which means a probe was attempted and failed — nothing is
  probed here.
- A turn that goes through request translation rather than passthrough reports no usage, so a
  client on a translated wire will never move this number.

`ocx provider test meta-muse` answers `applicable: false` with reason `static_catalog`. The
provider sets `liveModels: false` deliberately — its authenticated roster includes image and voice
models this Responses-agent provider cannot drive — so the absence of a live probe is a design
decision, not a broken connection.
