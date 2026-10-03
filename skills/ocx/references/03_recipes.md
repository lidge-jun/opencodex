# Recipes

Choose a task first with offline root, family and leaf help, then read its generated
chapter. For live management sequences, check the target before the first call:

```bash
ocx ready --json
ocx status --json
```

Inspect readiness and `versionSkew.relation`. Local configuration and local Lab
inspection do not require starting the proxy. Each example uses only that leaf's
supported output flags; mutation examples require authority for that task.

## 1. Audit the account pool and pause an exhausted account

```bash
ocx account list openai --json --quota
ocx account pause openai <account-id> --json
ocx account list openai --json
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
ocx account strategy openai --json
ocx account sticky openai --json
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

For the per-REQUEST view of the same identity, filter the log by the account label:

```bash
ocx logs --account p3f9a1 --jsonl
```

The label is the stable non-PII digest the proxy already persists — `main` and `p<hex6>` for Codex
pool accounts, `o<hex6>` for other OAuth providers — never an email or an upstream account id.
Rows served by a single-account provider carry no label. Like `--provider` and `--model`, the
filter matches failover attempts, so the request is findable by the account that finally served it.
Human output prints `acct=<label>` so a filtered result can be told apart from an empty one.
- Per-account totals are **withheld** under `--provider` or `--model`, because account rows cannot
  be honestly re-partitioned that way. The report says so rather than printing an empty table.

`providers[]` and `models[]` carry `estimatedCostUsd`. Costs are estimates; `estimateReasons` in the
log rows tells you why (for example `usage_estimated`, `expected_price_overlay`).

## 5. Prepare an access-key rotation without exposing the new key

```bash
ocx access key list --json
```

Creating a key or starting a rotation returns a one-time plaintext credential in both text and
JSON output. **Do not perform either operation in an agent session**, including through the
aliases, executable wrappers, or management POST routes named in
[Secret-bearing commands](../SKILL.md#secret-bearing-commands). Ask the user to perform that step
in a terminal outside the agent session, configure and verify the replacement, and report only
configuration confirmation and the non-secret key/rotation IDs. Never ask for the key itself.

Configuration confirmation is not revocation approval. Identify the existing key ID and obtain
separate explicit revocation approval before taking either path below. An existing explicit
approval for that exact revocation remains valid; do not ask again for the same action and ID.

For an in-place rotation, commit the pending replacement on the same ID:

```bash
ocx access key rotate commit <id> <rotation-id> --json
```

For a separately created replacement, remove only the old ID:

```bash
ocx access key remove <old-id> --yes --json
```

After the command succeeds, inspect the matching result:

```bash
ocx access key list --json
```

For an in-place rotation, the same ID remains and `pendingRotation` disappears. For a separately
created replacement, the old ID disappears. The list alone does not prove the replacement accepts
traffic; use the user's successful connection verification as that evidence. `remove <id>` is
positional, not `--id`, and refuses without `--yes`.

To cancel a pending rotation, with authority to discard the replacement:

```bash
ocx access key rotate abort <id> <rotation-id> --json
```

Abort retains the old credential and removes the pending replacement. Re-list to inspect pending
state. On stale, mismatched, or expired rotation IDs, or an uncertain commit result, inspect
non-secret state and report the refusal or uncertainty. Do not start another rotation, delete the
entry, or retrieve a secret as automatic recovery. Missing pending state alone is not proof of a
successful commit: expiry and abort also clear it.

The list carries per-key usage. A count that stops advancing shows no recorded new usage in that
observation window; it does not prove no client still needs the key. Creation and rotation-start
return the plaintext once; list does not return the full plaintext.

An `ambiguous` footer on the list means two configured keys share an id, so per-key totals do not
exist for them — do not attribute usage to either.

## 6. Save a provider, then verify live adoption

Local config operations do not need a running proxy:

```bash
ocx provider list --json
ocx provider add <name> --json
ocx provider show <name> --json
```

Registry providers are seeded by name; custom providers also need `--adapter`
and `--base-url`. Complete credential entry through the supported human login or
stdin handoff, never by putting a key in an agent transcript.

`needsSync: true` means saved, not live-applied. Adding `--sync` to this JSON
invocation does not execute sync. After authorized synchronization and the live
preflight, compare configured state with runtime state:

```bash
ocx inspect config --json
ocx provider test <name> --json
ocx models live --provider <name> --json
```

The test may contact the upstream model-discovery endpoint; it is not an inference
success test. `applicable: false` means the provider has a static catalog, not a
failed connection. Only promote the verified provider when requested:

```bash
ocx provider set-default <name> --json
ocx provider list --json
```

`set-default` saves local config; its receipt and any convergence warning must be
reported separately. Do not equate a local list with live management state.

## 7. Diagnose "management API is unreachable"

```bash
ocx ready --json     # is it up at all?
ocx status --json    # is it the build you think, on the port you think?
ocx doctor           # what is structurally wrong (human; `--json` is refused with exit 2)
```

`ready` false distinguishes `pending`, `failed` and `unreachable`; only pending
suggests waiting for startup. A ready process still may be the wrong role or
version for a specific management operation. Diagnose that target before retrying.

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

## 10. Invite one more machine onto a hub

Inspect non-secret state on the **hub** first:

```bash
ocx status                 # read the Hub: block first -- origins, listener, token source
```

Have the operator run `ocx hub invite` in a human-operated terminal outside the agent session.
Both output modes expose a plaintext pairing grant or the command embedding it; `--json`
is not a safe agent-output alternative. The operator transfers the generated command directly
to the other machine. It already carries both origins and `--pairing-code-stdin`, so do not
assemble it by hand or ask for it in chat. The code is secret, single-use, and expires in five minutes.

**Ask only for non-secret confirmation, such as expiry and the `Bound browser origin:` line.** That line is on stderr rather than in the JSON envelope,
and when the bound origin is not `http://localhost:10100` the joining machine has to already
be running on that port or the exchange is refused and the code is spent.

Three refusals are normal and none of them burns a code:

- `No loopback browser origin is admitted for pairing` — run the
  `ocx config set corsAllowOrigins '["http://localhost:10100"]'` line the error prints, as
  printed (it preserves the hub's existing entries) and with the **joining** machine's proxy
  port. Grants are origin-bound and `ocx connect` presents its own `http://localhost:<port>`.
- A data origin that would be this machine's own loopback — the bind is loopback-only or a
  wildcard and `hub.dataPublicOrigin` is unset, so there is nothing honest to advertise. Set
  `hub.dataPublicOrigin`, or pass `--data-url` for one invite. Do not work around it by
  sending `http://localhost:<port>`; that is the thing it is refusing.
- A rejected `--management-url` — on `invite` that flag confirms
  `hub.managementPublicOrigin` rather than overriding it. Drop the flag, or change the config.

Full context: [05_remote_hub.md](05_remote_hub.md#inviting-a-machine-ocx-hub-invite).

## Aside profiles

These commands and the Aside refresh in `ocx sync` require a compatible running ocx proxy.
There is no local profile-file fallback when the server is unavailable or too old. Follow
the [proxy upgrade, restart, and retry sequence](https://opencodex.me/guides/integrations/#aside-profile-controls),
then fully quit and reopen Aside after its profile files update successfully.

```bash
ocx integration client status --client aside --json
ocx integration client enable --client aside
ocx integration client disable --client aside --profile 1
ocx integration client history --client aside --profile 1
ocx integration client restore --client aside --profile 1 --op <opId>
```

Read `profiles[]` to find numeric profile IDs. No profile selector means a bulk toggle; an
explicit selector affects only that registered profile. Sync intent and actual file state
are distinct, so inspect each result after a partial bulk operation. The CLI returns nonzero
for a partial refusal. Never use the overwrite or drift flags merely to suppress a refusal.

## 11. Choose a model preset and inspect new arrivals

These are live management operations. Start with the saved preset and selection:

```bash
ocx models preset show --provider anthropic --json
ocx models selected anthropic --json
```

When asked to select the curated roster:

```bash
ocx models preset apply anthropic --json
ocx models selected anthropic --json
```

`fallback: "preset-empty"` preserves the existing selection; do not report an
empty preset as a successful narrowing. `preset apply <provider> --all` clears
the allowlist. The dashboard's disabled custom preset is not another CLI mode.

Read the discovery policy before changing it. This example disables automatic
exposure of newly discovered models for one provider, then reads it back:

```bash
ocx models new-policy --provider anthropic --json
ocx models new-policy off --provider anthropic --json
ocx models new-policy --provider anthropic --json
ocx models new-arrivals --json
```

The provider read may report `inherit`; omission of `--provider` selects global
policy. Recent arrivals show recorded discovery state, not a fresh upstream probe.

## 12. Inspect and dry-run an existing routing profile

Use an ID returned by the list (here `reliable` is an example saved ID):

```bash
ocx route policy list --json
ocx route policy show reliable --json
ocx route policy dry-run reliable --model-context 128000 --tools --image --structured-output --json
```

Only run this evaluation with authority to activate Lab on the target. The management POST can activate Lab and start automation that is already enabled there, including upstream probes. Use list/show for observation without that activation effect.

Dry-run evaluates saved routing evidence without an inference request; it does
not create or edit a profile. `evaluate` is the same dry-run operation. Profile
create/update/delete remain dashboard workflows; combo editing targets a different
resource. A missing profile returns exit 4; a missing operand returns 2.

## 13. Inspect local Lab evidence before exporting or running probes

No live management preflight is needed for these local reads:

```bash
ocx lab status --json
ocx lab catalog --json
ocx lab automation status --json
ocx lab automation runs --limit 10 --json
ocx lab public community --json
```

Use `lab subjects`, `lab subject <id>`, `lab observations --subject <id>`,
`lab event <id>` and `lab artifact <digest>` to follow evidence lineage. These
read the local projection, not a connected hub's database.

For a requested evidence transfer, preview selected events before export:

```bash
ocx lab public preview --event <event-id> --json
```

The public family also supports export, file verification and import; export and
import write local evidence. Automation enable/disable and manual `lab run` are
explicit mutations and can launch quota-consuming probes. Inspect their leaf help
and obtain task authority rather than using them to repair a failed read. Local
policy persistence does not prove another running proxy's scheduler adopted it.
