# Recipes

For a short task/target/read-back map, start with [Choose a workflow](../SKILL.md#choose-a-workflow).

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

## 6. Save locally or change the running provider configuration

Discover the installed grammar without starting a proxy:

```bash
ocx provider --help
ocx provider add --help
ocx provider pacing --help
ocx provider apply --help
```

Local `list`, `show`, `add`, `remove`, and `set-default` need no running proxy.
Registry providers are seeded by name; custom providers need `--adapter` and
`--base-url`. Complete credential entry through the supported human login or
stdin handoff, never by putting a key in an agent transcript.

```bash
ocx provider list --json
ocx provider add <name> --json
ocx provider show <name> --json
```

Without `--sync`, the add receipt has `needsSync: true`. When synchronization is
requested, `ocx provider add <name> --sync --json` actually attempts it after
saving. Inspect `sync.status`, `sync.ok`, `needsSync`, and the exit code. A stopped
proxy yields `not-running` and exit 1 while preserving the save. Only `applied`
with `ok: true` clears `needsSync`; policy skips and catalog-only outcomes do not.

For an authorized change to the running proxy, first confirm the intended target:

```bash
ocx ready --json
ocx status --json
ocx provider snapshot --json
ocx provider add <name> --live --json
ocx provider set-default <name> --live --json
ocx provider snapshot --json
```

These are separate operations; promote only when requested. Live add uses the
target's presets, refuses an observed duplicate without `--force`, and does not
fall back to local config on refusal. Its preflight is not an atomic create-only
check: a concurrent add can race with the server's upsert. `--live --sync` is
invalid. Live removal requires explicit deletion authority:

```bash
ocx provider remove <name> --live --yes --json
ocx provider snapshot --json
```

The server checks dependencies, reassigns the default when needed, and performs
its account/custom-model cleanup. Local removal still refuses the default and
last provider. A receipt's `success: true` means persisted; inspect
`catalogRefresh` and the exit code before reporting convergence. See
[JSON receipts](02_json_shapes.md#provider-write-receipts).

### Edit transport and pacing

Existing `provider edit` is live; do not append `--live`. Its added settings are:

```bash
ocx provider edit <name> --upstream-http-version http1.1 --fast on --context-window 128000 --json
```

`--upstream-http-version -` and `--context-window -` clear their overrides;
`--fast off` disables Fast. Omitted fields stay unchanged; zero is not a clear.
Read configured pacing rules and separate runtime observations before editing:

```bash
ocx provider pacing <name> --json
ocx provider pacing <name> --enabled on --rpm 30 --min-interval-ms 1000 --max-concurrent 2 --json
ocx provider pacing <name> --json
```

`rules: null` means no rules are configured. Numeric flags alone do not enable a
missing block. Scalars preserve the observed model rules, but the PATCH replaces
the whole block and is **not CAS**: a concurrent edit can be overwritten. Use
snapshot/apply below when a baseline check is needed. `--enabled off` disables
pacing. Fractional RPM is supported within validated bounds; limits must be positive.

For complete rules, including per-model rules, prepare a non-secret JSON object
such as `{"enabled":true,"requestsPerMinute":30}` and use:

```bash
ocx provider pacing <name> --file pacing.json --json
```

The file replaces the entire pacing block and cannot be combined with scalar
flags. `--file -` reads piped stdin. The [bounded input rules below](#snapshot-edit-apply)
also apply to pacing.

### Snapshot, edit, apply

Use the same intended host and CLI context throughout. A snapshot contains no
cross-invocation target token; target pinning only lasts within one invocation.
Take a redacted editor snapshot and keep its baseline unchanged:

```bash
ocx provider snapshot --json > providers.baseline.json
cp providers.baseline.json providers.next.json
```

Edit `providers.next.json`, then review its diff against the baseline. Both must
contain exactly the public editor's `defaultProvider` and `providers`. Secret,
derived and unknown fields are forbidden; do not add keys, tokens, any `headers`
field (even non-secret headers), or the display markers `hasApiKey`, `hasHeaders`,
`xaiResponsesOptInState`, and `initialModelSelection`. This read-only snapshot is
not raw config export; raw export can disclose credentials and remains a human
handoff outside the agent session.

```bash
ocx provider apply --baseline providers.baseline.json --file providers.next.json --json
ocx provider snapshot --json
```

Add `--yes` only when the reviewed next document removes or renames providers
and that deletion is authorized. Batch PUT preserves the server's public-baseline
comparison and untouched private values; it does **not** perform single-provider
DELETE's OAuth account cleanup. On HTTP 409 (exit 5), stop: take a fresh snapshot,
review concurrent changes and rebuild the proposed edit. Never replace the
baseline or retry automatically. After an uncertain write or saved-but-not-converged
receipt, inspect current state before considering another write.

Inputs must be regular UTF-8 JSON files or explicit piped `-`; at most one batch
input may use stdin. Each input is limited to 4 MiB and a 30-second read deadline;
the combined serialized `{baseline,next}` body must also fit 4 MiB. Interactive
stdin, special files, conflicting sources and invalid shapes are refused before
a write. Error messages do not echo input values.

Provider discovery testing is a separate, potentially upstream operation:
`provider test <name> --json` can contact the model-discovery endpoint, and
`applicable: false` means a static catalog. It never proves successful inference.

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
create/update/delete use the explicit revision workflow below; combo editing targets
a different resource. A missing profile returns exit 4; a missing operand returns 2.

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

## 14. Add a custom model locally or on the running proxy

Inspect installed grammar offline first, then verify the live target when needed:

```bash
ocx models add --help
ocx models order --help
ocx ready --json
ocx status --json
ocx models live --json
```

Use a provider configured on that target and its raw upstream model ID. For an
explicitly requested live addition:

```bash
ocx models add <provider> <raw-model-id> --live --display-name 'Research model' --context-window 128000 --modalities text --json
ocx models live --json
```

Keep the returned custom `id` for later edits/removal. Live removal resolves on
that same target and requires deletion authority:

```bash
ocx models remove <complete-stored-id> --live --yes --json
ocx models live --json
```

A provider/model selector is also accepted when unambiguous. Do not substitute a
display label or truncate an ID; ambiguous selectors refuse without deletion.
There is no revision protection, alternate-ID retry or local fallback.

Omitting `--live` saves local custom configuration. Local `add`/`remove --json`
return `{action, model, needsSync, sync}` and opportunistically synchronize if a
proxy exists. No proxy means `sync.status: "not-attempted"`, `needsSync: true`
and exit 0; it does not undo the save or require starting a proxy. An attempted
failed/refused/incomplete sync returns nonzero. Policy-skipped success may exit 0
with `needsSync: true`; only complete applied sync clears it. Local JSON removal
requires `--yes`, even on a terminal. `list-custom --json` lists local stored IDs,
so it is not evidence of a different live target's custom registry.

### Change a discovered model's label

Display-name writes take provider plus **raw upstream model ID**, split at the
first slash. Preserve further slashes. Do not pass a picker alias or guess how
to decode an encoded public ID:

```bash
ocx models display-name <provider>/<raw-model-id> --set 'Research model' --json
ocx models live --json
ocx models display-name <provider>/<raw-model-id> --clear --json
```

Setting and clearing are alternative writes, not a sequence to run automatically.
`--clear` sends null. Pricing, public identity and custom-model `edit` are separate.
A saved label with failed refresh may print `saved: true` and exit 1; read back
instead of treating it as rollback.

### Order the picker without dropping identities

```bash
ocx models order status --json
ocx models live --json
```

Use `pickerAvailable` public IDs for a manual full permutation, including every
routed candidate exactly once. Keep the current featured models in their exact
required leading order; ambiguous, missing, extra or duplicate IDs are refused.
The placeholder below stands for the complete reviewed comma-separated list:

```bash
ocx models order set --models '<complete-public-id-permutation>' --json
ocx models order status --json
```

The command re-reads settings and model identities immediately before writing;
changed state yields conflict. This check is **not CAS**, so a later concurrent
write can still race. Re-read on refusal and after success; never auto-reset to
make an invalid order pass.

As alternatives, `models order set --mode alphabetical|provider|most-used --json`
derives a complete routed order. Preset modes do not prepend the manual featured
prefix. Most-used reads all-time/all-surface usage and refuses incomplete history;
unranked candidates remain present. A saved order containing bare native IDs
blocks both manual and non-default presets. Only an explicitly requested
`models order reset --json` or `models order set --mode default --json` clears
saved order/mode first. Reset does not change featured selection.

## 15. Create or revise a routing profile from an editable document

Only proceed with authority to activate Lab and any already-enabled automation
on the target: create/update may activate it, including upstream probes. Reads
below do not require that activation. Discover grammar and inspect the chosen ID:

```bash
ocx route policy update --help
ocx route policy list --json
ocx route policy show reliable --json > profile.observed.json
jq 'del(.id, .model, .revision) | if .alias == null then del(.alias) else . end' profile.observed.json > profile.next.json
```

The `jq` step prepares a working document; it does not write user configuration.
Edit and review `profile.next.json`. Allowed fields are `alias`, `candidates`,
`require`, `optimize`, `limits`, `unknownEvidence`, and `compatibility`, with only
their supported nested fields. The show-only `id`, `model`, `revision` and a null
alias are not writable input. Keep `profile.observed.json` unchanged.

```bash
ocx route policy update reliable --file profile.next.json --expected-revision '<exact-revision-from-observed-show>' --json
ocx route policy show reliable --json
```

Copy the opaque revision from the original observation. Never fetch a fresh
revision silently, change update into create, or automatically retry 409/exit 5.
On conflict, read show again, review concurrent changes and prepare a new edit.
For an authorized new ID, use `ocx route policy create <new-id> --file profile.next.json --json`
without a revision. For authorized deletion use
`ocx route policy remove <id> --yes --json`; deletion is not revision-protected.
Files (or `--file -` piped stdin) use the 4 MiB/30-second bounded input contract.
Server validation remains authoritative for candidates, aliases and policy semantics.

## 16. Edit combo targets and inspect actual decision observations

Start with `ocx combo set --help`, `ocx combo list --json` and
`ocx combo show <stored-id> --json`. A targets file is a nonempty ordered array,
not the complete show object. Use actual configured provider/raw model pairs;
this is the file shape:

```json
[{"provider":"example","model":"raw/model","weight":1,"reasoningEfforts":["high"],"modelProfile":"Reasoning tasks","lastResort":false}]
```

Optional target fields are `weight`, `reasoningEfforts`, `modelProfile` and
`lastResort`. Explicit `false` and order survive. Efforts must be a nonempty unique
list of `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; custom-model empty/none/minimal
semantics do not apply here. File input follows the same 4 MiB/30-second limits.
For the requested edit, use:

```bash
ocx combo set <stored-id> --targets-file targets.json --image-input auto --reasoning-effort-mode strict --json
ocx combo show <stored-id> --json
```

`--targets-file` and `--targets` conflict. Omit both to preserve complete target
metadata on a partial edit. Explicit `auto` and `strict` override saved disabled
image input and adaptive reasoning; omitted settings preserve their existing
values. `--reasoning-effort-mode strict|adaptive` is distinct from
`--effort-mode fallback|force`, which controls the default effort. Native-alias
accepts `on`, `off`, or legacy bare true. To remove an incompatible retained native
alias, the requested edit must pair `--native-alias off --alias -`. Combo set is
an upsert without CAS; re-read instead of assuming a concurrent edit was protected.

Statistics are observation only and do not run a decision probe:

```bash
ocx combo stats <stored-id> --range 30d --json
```

Use the exact stored combo ID from list/show, not its public model or alias.
Ranges are `7d`, `30d` (default), or `all`. Report measured attempts, model tokens,
decision tokens and coverage alongside counts. Nullable averages are unavailable,
not zero. Preserve incomplete/truncated history flags. This response contains no
monetary cost or comparative savings baseline; do not invent either from tokens.

## 17. Inspect pool policy before changing account scope

Discover syntax offline, then confirm the intended live target:

```bash
ocx account pool --help
ocx account quota-activation --help
ocx ready --json
ocx status --json
ocx account pool openai --json
ocx account pool anthropic --json
```

The target's `supported` list decides which fields can be written. Preserve null,
`enabledEffective`, and optional `inert`: null is not false, stored policy is not
proof of an available account, and threshold zero is not the pool enable switch.
OpenAI has no pool `--enabled` or `--quota-window` writer. `reset-first` strategy
is OpenAI-only; `least-loaded` is Kiro-only. Anthropic pool windows are
`five-hour`, `weekly`, `max-utilization`. For a requested supported policy edit:

```bash
ocx account pool anthropic --threshold 80 --quota-window five-hour --json
ocx account pool anthropic --json
```

Only supplied fields change. For one OpenAI account use an explicit selector:

```bash
ocx account auto-switch openai status --account <id-or-alias-or-main> --json
ocx account auto-switch openai inherit --account <id-or-alias-or-main> --json
ocx account auto-switch openai status --account <id-or-alias-or-main> --json
```

`inherit` writes null, `on` writes 80, `off` writes 0, and `threshold N` accepts
0–100. Without `--account`, the existing auto-switch command changes pool scope.
Read override and effective threshold separately; never infer a missing threshold
as 80 or resolve an ambiguous alias by guessing.

Paid-credit policy requires explicit intent to allow or disallow spending after
the included limit. `account credits openai <id> on|off --json` targets one account;
`account credits openai --all on|off --json` targets all current selectable accounts
plus main when enabling, and clears the policy list when disabling. These selectors
are exclusive. `showCodexCredits` is only a display preference and never supplies
that intent. Do not enable credits as login/quota recovery. Read back the roster
with `ocx account list openai --json` and retain the actual returned IDs.

Quota activation is another policy, not grant redemption. For an authorized edit:

```bash
ocx account quota-activation openai <id-or-alias-or-main> --window fiveHour off --json
ocx account list openai --json
```

Its window spelling is `fiveHour` or `weekly`, unlike Anthropic pool `five-hour`.
Enabling may schedule quota refresh; unavailable enablement can return 409 while
disabling remains allowed. The receipt's `available` is observed availability,
not a claim that a refresh already completed.

```bash
ocx account anthropic-reset-grants --json
```

An optional exact Anthropic account ID selects the read; this is not the Codex
alias/main resolver. The GET may contact upstream status, but never consumes a
grant or resumes `pendingOperation`. Preserve unavailable versus empty grants,
nullable dates/reasons and journal state. Spending remains a human GUI handoff.

## 18. Choose login options for the actual flow

Use `ocx account login --help` for grammar. Ordinary fresh provider OAuth accepts
`--add-account on|off`; omission preserves `addAccount: !reauth`. Off permits the
existing import preference and does not delete an account. Either explicit value
is rejected for reauth and Codex login. `--open-browser on|off` is supported for
browser-capable flows, including Codex browser login; it is rejected with Codex
`--device` and native device-only `kimi`, `nous`, `github-copilot`. Native Kiro
`--method` rejects both new options because that add-only flow owns browser/device
handling. Keep existing unflagged defaults.

The operator completes browser/device verification. A returned device grant is
not a browser-launch success. Keep `flowId`, account ID and human verification
code separate, and preserve pending/expired/cancelled or validation-pending state.
Do not restart login automatically, capture credentials, or perform verification
for the operator. `--no-wait --json` is a public handoff, not completed login.

Live OAuth logout is `ocx logout <public-oauth-provider> --live --json`; use only
when logout on that target is requested. It does not sign out Codex/native-main,
remove one selected account, or fall back to local credential deletion on failure.
No-live logout retains local removed/not-found behavior (exit 0/4). Re-read the
appropriate account roster instead of inventing a live `removed` result.

## 19. Replace memory or compaction overrides deliberately

```bash
ocx agent memory-models --help
ocx agent memory-models show --json
ocx agent compaction-routing show --json
```

Each set replaces its entire block. A memory file contains only `extract` and/or
`consolidation`, each with `model` and optional `reasoningEffort`. Scalars are:

```bash
ocx agent memory-models set --extract-model <route> --extract-effort high --consolidation-model <route> --json
ocx agent memory-models show --json
```

Omitted phases use their existing/default route; they do not stop. Effort requires
a model for the same phase. Alternatively `--file memory.json` accepts the block
itself, including explicit `{}` for no overrides. `clear` sends null; `{}` and
null remain distinct saved values, neither disables the memory pipeline. File
mode and scalar flags conflict; the 4 MiB/30-second input limits apply.

```bash
ocx agent compaction-routing set --model <route> --effort high --triggers manual,auto --sources '<exact-source>,<provider>/*' --json
ocx agent compaction-routing show --json
```

Use exact unique source selectors or provider/* patterns, not guessed aliases.
Omitted triggers use the server default and omitted sources mean all source models;
they do not retain an old custom scope. File mode uses `model`, optional
`reasoningEffort`, `triggers`, `sourceModels`. `clear` sends null and restores normal
compaction routing, not disabled compaction. A saved setting needs no synthetic
model call. Inspect `catalogRefreshPending`; true or unverified status is nonzero.

## 20. Change runtime settings and v2 with explicit targets

```bash
ocx system settings --json
ocx agent injection status --json
ocx agent sidecar status --json
```

System boolean options are `--show-codex-credits`, `--account-picker`,
`--main-account-hard-lock`, `--ultra-fast-tier`, `--fast-rows`, each on/off.
Credit display does not authorize paid use, and system Ultra Fast is separate
from provider Fast. New-option writes report only observed task fields;
Ultra Fast requires the command's same-target GET read-back. Pending catalog,
unverified read-back or deferred/refused native apply must be reported as such.

For requested injection/sidecar edits, with read-back:

```bash
ocx agent injection set --sync-codex-defaults off --json
ocx agent injection status --json
ocx agent sidecar web --stream-routed-output on --json
ocx agent sidecar vision --timeout-ms 30000 --json
ocx agent sidecar status --json
```

Injection preserves omitted model/effort/prompt/guidance; `-` clears the first
three. The returned default-sync value is normalized state, not a catalog receipt.
Web reasoning is supported. `--max-descriptions` and `--timeout-ms` are vision-only;
`--stream-routed-output` is web-only. Timeout is 1–2147483647 milliseconds. Partial
sidecar writes preserve siblings. Its `codexWebSearch` report distinguishes saved
settings from native apply; ownership refusal is not repaired by blind retry.

```bash
ocx v2 --help
ocx v2 status --json
ocx v2 status --live --json
```

No-live operates on local native/config state; `--live` uses the selected proxy
with no local fallback. Both support JSON. For an authorized live mode change:

```bash
ocx v2 mode v1 --live --json
ocx v2 status --live --json
```

Only an explicitly requested live `mode` may include
`--acknowledge-surface-advisory`; never add it automatically. Other verbs and local
mode reject it. To save literal reserved hint text, quote one operand after `--`:

```bash
ocx v2 mode-hint --live --json -- '--clear'
```

That saves the text `--clear`; without the terminator `mode-hint --clear` clears
the override. Controls occur before `--`; the suffix is one raw nonblank operand.
Local mode/keep-native and changed on/off still attempt real sync even without a
discovered port. Threads/hints and unchanged on/off add no sync. Local JSON reports
`changed`, observed `state`, and `sync`; void/malformed sync evidence is
`unverified`, exits 1, and does not erase an already-landed change. Live writes
retain full catalog disposition; read back after partial/unknown outcomes.

## 21. Preview a file integration, then commit the reviewed plan

Discover syntax offline; these operations need the intended running proxy:

```bash
ocx integration client preview --help
ocx integration client status --client hermes --json
ocx integration client preview --client hermes --operation apply --json > hermes-preview.json
```

Review `changes`, `state`, `foreignEdit`, `canApply` and `willChange`. A refused
plan or applicable no-op is successful inspection (exit 0), not applied work.
Changes are structural paths, not secret values or a full file diff. Preview
uses passive catalog evidence; it does not secretly refresh providers. If the
preview is unavailable, resolve catalog availability separately and preview again.

Only after reviewing an applicable plan and choosing to apply it:

```bash
PLAN_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' hermes-preview.json)"
ocx integration client enable --client hermes --plan-fingerprint "$PLAN_FINGERPRINT" --json
ocx integration client status --client hermes --json
```

The token is concurrency evidence, not authorization. Commits accept `pN:` plus
32 lowercase hex digits; a refused preview may show `pN:unbound`, which cannot
commit. Repeat the exact action/client/profile/options. `apply` maps to enable;
`overwrite` maps to enable with `--overwrite-conflict`; `disable` maps to disable.
Existing direct enable/disable/restore remains available without a fingerprint.
A stale commit prints a fixed re-preview instruction on stderr, leaves stdout
empty and exits 5. Never adopt a replacement token or retry automatically.

### Restore after inspecting drift

The following operation/profile IDs are examples; select actual IDs from history:

```bash
ocx integration client history --client aside --profile 1 --json
ocx integration client restore --op op-example --client aside --profile 1 --preview --json
```

If drift is refused, inspect the changes first. Only when replacing the later edits
is intended, preview that explicit intent and review the resulting plan:

```bash
ocx integration client restore --op op-example --client aside --profile 1 --preview --confirm-drift --json > restore-preview.json
```

Then, if authorized, repeat the same op/profile/drift choice in the bound write:

```bash
RESTORE_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' restore-preview.json)"
ocx integration client restore --op op-example --client aside --profile 1 --confirm-drift --plan-fingerprint "$RESTORE_FINGERPRINT" --json
ocx integration client status --client aside --profile 1 --json
```

Aside preview and bound writes require one profile; there is no aggregate preview.
Generic restore omits client/profile, and the server derives its non-Aside client
from the operation. The plan does not contain opId or all original command input;
keep that context yourself. `--preview` and `--plan-fingerprint` cannot combine.

### Replace or clear Droid reasoning defaults

Repeated `--reasoning-default MODEL=EFFORT` replaces the complete map, not one key.
Use exact, case-sensitive namespaced IDs and efforts supported by the target.
The example model below is fictional; substitute a supported connected model.

```bash
ocx integration client preview --client droid --operation apply --reasoning-default example/model-a=high --json > droid-preview.json
```

After review and an explicit apply decision:

```bash
DROID_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' droid-preview.json)"
ocx integration client enable --client droid --reasoning-default example/model-a=high --plan-fingerprint "$DROID_FINGERPRINT" --json
ocx integration client status --client droid --json
```

Repeat every map entry in the commit. Omission preserves existing defaults;
`--clear-reasoning-defaults` sends `{}`. To clear, preview apply/overwrite with
that flag and repeat it in the matching enable command. Clear and entries conflict;
duplicate keys refuse. These flags work only for Droid apply/overwrite, never
another client, disable or restore. The server validates model-specific efforts.

For a requested complete clear, first inspect:

```bash
ocx integration client preview --client droid --operation apply --clear-reasoning-defaults --json > droid-clear-preview.json
```

After reviewing that applicable plan and choosing the clear:

```bash
DROID_CLEAR_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' droid-clear-preview.json)"
ocx integration client enable --client droid --clear-reasoning-defaults --plan-fingerprint "$DROID_CLEAR_FINGERPRINT" --json
```

## 22. Retire recovery history or refresh Aside profiles

History removal permanently retires the selected recovery record and its backup;
it is not restore or disable. Inspect history, confirm that losing that recovery
point is intended, then use its exact opId (the ID here is fictional):

```bash
ocx integration client history --client aside --profile 1 --json
ocx integration client history remove --op op-example --client aside --profile 1 --yes --json
ocx integration client history --client aside --profile 1 --json
```

No selector means the global journal; `--client aside` means aggregate Aside
history and `--profile N` narrows it. Other client selectors are refused for
removal. The newest row is protected. `snapshotRemoved:false` exits 1 after the
record was retired: cleanup is incomplete, not rolled back. Do not replay deletion.

```bash
ocx integration client sync --client aside --json
ocx integration client status --client aside --json
```

Sync uses the existing attested Aside owner, with no profile selector or broad
sync/local fallback. `{results:[]}` means no eligible profiles and exits 0, not
applied writes. Any failed profile exits 1 while preserving successful outcomes.
Read every row, residual flag and separately labeled redacted backup path; address
the refusal before another sync. Reopen Aside after verified profile-file changes.

## 23. Save a runtime Desktop profile or inspect Cursor

```bash
ocx claude desktop profile show --json > desktop-observed.json
jq '.profile' desktop-observed.json > desktop-profile.json
```

Edit and review the versioned profile itself, not the outer response. Preserve
server-owned applied markers; do not forge them to claim application. Import
accepts bounded regular JSON files or explicit piped stdin, with the existing
4 MiB/30-second input contract. For the requested save:

```bash
ocx claude desktop profile import desktop-profile.json --json
ocx claude desktop profile show --json
```

This saves on the selected runtime only. It does not apply to native Desktop;
`--apply` and native-mode flags are refused. A failed runtime save never writes a
local fallback. Existing `claude desktop show/import` remain local and existing
`claude desktop apply` is a separate action on that machine; verify host/context
before choosing it. Runtime profile reads can gather model inventory.

```bash
ocx integration native cursor status --json
ocx integration native cursor local-installer --json
```

Cursor status can gather model inventory; installer lookup can fetch a public
manifest. Neither is an offline guarantee, download, install or toggle. An
unavailable installer with `reason:null` is valid, including when Private Inference
is already installed. Credential mode requires an existing proxy credential;
the displayed placeholder is not one. Do not fetch a key to complete this read.

## 24. Observe the Hub and change maintenance policy deliberately

```bash
ocx remote-workspace hub status --json
ocx remote-workspace hub runtimes --json
ocx remote-workspace hub sessions --json
```

These read the selected management Hub; ordinary `remote-workspace status` stays
executor-local. Runtimes is an object keyed `codex`, `claude`, `pi`, not an array.
Available Hub with no devices/sessions is empty success. Disabled Hub can arrive
as outer HTTP 200 with `available:false`, empty collections and a fixed CLI reason;
the CLI prints this observation and exits 1. It is not an empty available Hub.
Inner HTTP 409 exits 5 with stderr guidance. Use the intended Hub with feature
activation configured; do not enable it or pair/start/revoke a session as recovery.
Runtime reads can probe executable availability.

```bash
ocx storage policy show --json
ocx storage policy set --archived-bytes-over 1073741824 --reduce-to-bytes 536870912 --json
ocx storage policy show --json
```

This saves nested `trigger.archivedBytesOver` and `target.reduceToBytes` without
starting cleanup or changing omitted enabled state. Byte values are safe
nonnegative integers. Alternatively choose `--remove-oldest-percent 10` (legacy
`--percent 10`); these two spellings and reduce-to are mutually exclusive.
Percentages are integer CLI inputs with server-supported range 1–100. Read the
returned policy/job; an already-enabled schedule retains its authority. Do not
append `--enabled true` or run cleanup unless that additional effect is intended.

Only when revocation without remote cleanup is explicitly requested:

```bash
ocx link revoke --link-id lnk_0123456789abcdef --force --yes --json
```

The link ID is fictional; use the selected actual ID. A successful forced revoke
reports `remoteCleanup:"skipped"`, derived from force intent. Idempotent not-found
reports `remoteCleanup:"unverified"`; neither proves a remote disconnect attempt.
Both can exit 0. Follow the receipt's `ocx disconnect` recovery on the remote
client when authorized. `--force` requires `--yes`; `--yes` alone is invalid.
Ordinary revoke remains unchanged.

## 25. Follow observed windows without claiming lossless history

Discover the installed flags, then choose a one-shot view or follow:

```bash
ocx logs --help
ocx logs --limit 200 --json
ocx logs --follow --events --limit 200
```

`--events` requires follow, implies JSONL and permits redundant `--jsonl`; `--json`
is one-shot and cannot combine with follow/events. Each events-v1 object contains
`schemaVersion`, `type`, `rows`, `cursor`, `limit`. Replace your window on `snapshot`;
append then trim to limit on `append`. Preserve order and repeated request IDs.
The initial snapshot is emitted even empty, as are reset/removal snapshots.
Stable empty polls stay silent. Legacy full-array responses use cursor null;
no cursor is fabricated. This reconstructs observed windows, not requests lost
between polls or evicted from the ring.

If a row feed is required instead:

```bash
ocx logs --follow --jsonl --limit 200
```

This preserves the legacy row shape but re-emits changed occurrences, including
same-ID status/token amendments and repeated IDs. Do not deduplicate blindly by
request ID. Row output cannot represent removals, resets or exact window order;
use events for that. Log follow limit is 1–2000 (default 200).

```bash
ocx observe injection --help
ocx observe injection --limit 500 --json
ocx observe injection --follow --jsonl --limit 500
```

Injection follow emits ordered `{seq,at,line}` rows, advancing its internal `after`;
`at` is epoch milliseconds. Limit is 1–2000, default 500. `--json` stays one-shot,
and `--jsonl` requires follow. Capture is not enabled by observing it. Empty polls
do not establish whether capture is off, idle or missing records. Runtime drift
that can be detected stops the command; undetectable restarts and latest-N gaps
cannot be ruled out because this API has no epoch/gap marker.

Both follows poll serially after a one-second wait, with 10-second fetch/body and
32 MiB response limits. On malformed/oversized/transport failures they stop, not
truncate or reconnect. Reduce limit for oversized windows. Ctrl-C exits 130,
SIGTERM 143, failures 1; no later poll/output survives cancellation. Verify the
exit status and retained observations; a stopped follow is not a completed history.

## 26. Read timeline, ledger health and one key's usage

```bash
ocx companion timeline --help
ocx companion timeline --hours 24 --bucket-minutes 60 --metric total --aggregation sum --grouping model --model example/model-a --hide-provider excluded-provider --json
ocx health --json
ocx system health --json
```

Timeline models/providers above are fictional. Repeat `--model` once per exact
provider/model identifier; nested model slashes are allowed, embedded CSV is not.
Repeat `--hide-provider` for exclusions; there is no positive `--provider` filter.
Hours are 6/24/72/168; bucket minutes 1–1440 with at most 2000 buckets. Metric is
total/input/output/cached, aggregation sum/average/max, grouping model/modelAccount.
Compare `appliedFilters` with the request. Start/end/bucketSeconds are seconds,
not the milliseconds used by ordinary usage custom windows. Preserve
`missingMeasurements` and `truncated`: zero points may be missing evidence.
Empty series retains metadata and is not a complete-zero usage claim.

Root health checks liveness; system health reads management diagnostics. Its
`status:"ok"` may coexist with `spendLedger.degraded:true`, unheld ownership or
nonzero persistence/corruption counters. Exit 0 confirms a valid observation, not
that every subsystem is healthy. `system status` remains a separate aggregate.

On a standalone/Hub management host, use a non-secret key ID from masked listing:

```bash
ocx access key list --json
ocx usage --api-key-id key-example --range 7d --json
```

Replace the fictional ID. Require matching `filter.apiKeyId` in the result; an
older server ignoring it is refused. Unknown acknowledged IDs may return
`matched:false`/no traffic instead of 404. Preserve incomplete/custom-window facts.
Connected clients reject caller-selected key scope before enrolled-key access or
transport; omit the flag for self-only usage or perform the selected-key report
on the Hub. A data key cannot grant management access.

Rename only the label of an authorized key, then re-list:

```bash
ocx access key rename key-example 'Research client' --json
ocx access key list --json
```

Use a unique ID or unambiguous name. The narrow write sends only ID/name, retains
provider/model scopes, and does not rotate/delete or return plaintext. Names are
trimmed, nonempty, control-free and at most 64 JavaScript string units. Resolution
and write are not CAS; on an unknown outcome inspect the masked roster before
retrying. `api-key rename` shares this command family.

## 27. Hand off a selected-key model or audio check

First discover grammar without contacting a model:

```bash
ocx access test --help
ocx access audio transcribe --help
ocx access audio live-check --help
```

These tasks may contact upstream services and spend quota; transcription also
uploads the chosen file. Obtain explicit operator authorization for the particular
model request, file upload or live readiness check. The operator then uses a
private terminal outside the agent session and attaches an already-approved
secret source to stdin. Never ask for the key in chat, read it into agent tools,
or put it in argv/environment. The following are the **ocx side** of that private
stdin pipe, not commands for the agent to run or direct interactive key prompts:

```bash
ocx access test example/model --protocol responses --api-key-stdin --json
ocx access audio transcribe sample.wav --model gpt-4o-mini-transcribe --api-key-stdin --json
ocx access audio live-check --model gpt-live-1-codex --api-key-stdin --json
```

These are alternative tasks, not a batch to execute. Model/file examples must be
replaced with the explicitly selected target and file. Direct TTY input refuses.
Input is at most 4096 bytes with a 30-second deadline: valid UTF-8, printable ASCII,
no outer whitespace/control characters or extra lines; one final LF/CRLF is allowed.
This deliberately covers currently issued keys; it does not claim the server's
configuration schema forbids Unicode. Exact key occurrences in permitted response
text are replaced with `[redacted]`; arbitrary encodings are not guaranteed detected.
Mutable input buffers are cleared, but immutable strings/carrier copies are GC-managed.

The target is the identity-checked local serving origin or the existing normalized
enrolled Hub origin. No custom origin flag, admin credential or enrolled-key fallback
exists. Detected target/enrollment changes refuse rather than silently redirect.
Ask the operator for the non-secret outcome only; do not capture the input pipeline.

### Interpret the model observation

Chosen-key mode first sends one credentialless malformed-JSON control to the exact
selected protocol endpoint. Only the native key-required 401 permits the subsequent
single fixed 16-token request with the supplied key. Control is capped at 5 seconds/
4096 response bytes; the model request at 60 seconds/2 MiB, including body reads.
Authless/unrecognized controls stop without inference. Local logging/admission
bookkeeping can still occur. There are no retries or protocol substitutions.

Success means: “Credentialless request was refused; the model request using the
supplied key succeeded.” This is not atomic key verification, certified scope or
billing attribution: policy/listener changes between the two calls remain possible.
Inspect the versioned report's control/request observations and response completion.
Length-limited text stays `completion:"limited"`; a tool-only/refusal/content-filter
or malformed response is unsupported, not success merely because HTTP was 2xx.
Existing tests without `--api-key-stdin` retain their legacy payload and cannot
establish anything about a newly selected key.

### Interpret transcription and live readiness

Audio uses explicit-key admission directly, not the model control. Transcription
requires one nonempty regular file no larger than 25,000,000 bytes, read within
30 seconds; multipart is bounded to 32 MiB. Models are gpt-4o-transcribe,
gpt-4o-mini-transcribe or whisper-1; actual target support still governs acceptance.
Upload plus response has a 130-second limit and 2 MiB response cap. Only `{text}`
is returned, including valid empty text, with exact-key redaction; extra fields
are discarded. Failure leaves stdout empty, prints fixed stderr and exits nonzero;
there is no JSON error envelope. No automatic retry uploads the file again.

Live-check sends only fixed session.update and session.close. Within 15 seconds,
readiness must be session.started/updated with a nonblank native session ID;
socket open or session.created is insufficient. It then waits up to 2 seconds for
normal code-1000 closure. Frames are capped at 64 KiB UTF-8 each, 2 MiB total.
Readiness with unverified closure is partial and exits 1. Normal close after an
earlier error does not erase the failure. The report proves only the observed
session readiness/closure, not server lease release or a full voice roundtrip.
There is no microphone capture, audio upload in live-check, tool execution or
reconnect, and no promise that opening the upstream session costs nothing.

## 28. Select a bounded log window and search usage model rows

```bash
ocx logs filter --help
ocx logs filter --surface claude --status errors --time-window 1h --scan-limit 2000 --limit 50 --json
ocx usage --range 7d --search 'model-a' --json
```

`logs filter` fetches one recent snapshot, selects within it, then returns the
newest matching rows in their original order. `--scan-limit` is the raw window
(default 2000), while `--limit` caps output (default 200); both accept 1–2000.
Read `window.loaded`, `matched` and `returned` before describing the result.
No matches means none in this observed window, not none in stored history.
Choose `--jsonl` instead of `--json` only when row-only output is sufficient.
This command rejects follow/events; use recipe 25 for streaming observations.

Optional selectors are `--model`, `--provider`, `--conversation` (also
`--conversationId`), `--intercepted-only`, `--min-tok-per-sec`,
`--max-tok-per-sec`, and `--protocol-mode`. Model/provider equality ignores case
and surrounding whitespace and includes resolved/served models and attempts.
Claude includes Desktop; absent surface is Codex. Status success selects
200–299 and errors 400–599. Time windows are all/15m/1h/24h.
Speed bounds use observed value-kind tok/s only: minimum inclusive, maximum
exclusive; unavailable speed cannot match an active bound. Protocol choices are
all/native/translated/legacy-bridge/blocked/none; none includes invalid or absent
traces. Conversation selection accepts the server's hash-aware identities.

Usage search is different: it matches a trimmed, case-insensitive substring in
model/provider/resolvedModel, sorts by total tokens and returns at most 100 model
rows. It leaves report totals and provider/day/account rows unchanged. Check
`modelView` for match/return counts and truncation. An explicit blank search
selects a top-100 view; omit search for the existing layout. Exact `--provider`
and `--model` still scope the underlying report. On a connected client the same
search stays inside self-only Hub usage; it cannot select another key's records.

## 29. Read the saved companion usage view

```bash
ocx companion show --json
ocx companion usage --json
```

Run on the machine serving the intended management API. Usage captures saved
`models` and `hiddenProviders`, then reads today and 30d sequentially from the
same runtime. It applies those filters to the public totals/model rows and
preserves unmeasured, unpriced, incomplete and window facts. Null model selection
means all; an explicit empty selection means none. It does not change saved
settings, perform native window actions or use a connected-client relay.

Inspect both `ranges` entries and the process exit. A failed range is unavailable,
not zero; the other remains visible, `partial` is true and the command exits 1.
Both available ranges can still contain incomplete data. Server defaults preserve
null `settingsUpdatedAt` and set `settingsFallback`; a valid corrupt-file fallback
also sets `settingsCorrupt` and warns in human output. Malformed settings stop the read before
usage requests. Do not infer a valid user-saved filter from a fallback or describe
these separate reads as one atomic snapshot.

## 30. Read one API-key pool's quota

```bash
ocx account list example --json
ocx account list example --quota --json
ocx account list example --quota --refresh --json
```

Replace `example` with a configured API-key provider. The first command lists
stored identities without requesting quota. Use the second only when its
upstream probe work is authorized; the third explicitly refreshes the existing
quota cache. This reads each key's quota, not the provider-wide report returned
by `account refresh`, and does not create or reveal a key.

Read `quotaMode`, `quotaUnavailable` and the actual `quota` fields together.
Probe, passive and unsupported are distinct. Missing/unavailable is not zero;
real zero credit or usage remains zero. Custom windows and provider credits can
be present instead of familiar Codex percentages. Returned key rows without
quota-mode evidence are unverified/nonzero; an empty pool is valid. A read does not alter stored key
selection or prove that a credential can serve a model. Do not replace a failed
measurement with a paid test request or repeatedly force-refresh it.
