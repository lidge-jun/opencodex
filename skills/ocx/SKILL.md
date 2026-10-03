---
name: ocx
description: "Operate opencodex (`ocx`): discover CLI tasks offline, inspect local configuration, and manage a running proxy’s account pool, providers, models, routing, usage report, and management API. Use for proxy operation rather than editing the opencodex codebase."
---

# Operating `ocx`

`ocx` supports local configuration and named live management workflows. Coverage is
per task: provider edits, account selection, model visibility, routing reads, client
integration controls and diagnostics have different transports and limits. A shared
API prefix does not prove that every dashboard action has a CLI equivalent.

This skill is for **operating** a proxy. `AGENTS_INSTALL.md` covers installation
and operating consent; the repository `AGENTS.md` covers code changes.

## Find the task offline

Start at the smallest useful level; no running proxy is needed for help:

```bash
ocx help                         # compact root
ocx help models                  # family and declared children
ocx help models preset show      # exact leaf, when declared
ocx help --all                   # full top-level reference, when needed
```

Then read only the matching [task chapter](references/01_management_surface.md).
For example, use [providers/models](references/01_surface_providers-models.md)
for catalog work or [Lab](references/01_surface_lab.md) for local evidence.
Use `ocx help <family> <leaf>` or appended `--help`, not a trailing bare `help`
after nested operands. Missing detail can fall back to family help; it is not
proof that a runtime operation is absent.

For a route you already know, an optional lookup is:

```bash
ocx capabilities --route '/api/providers/{provider}/model-costs' --json
```

This matches the **declared path template**, not a concrete provider URL or HTTP
method. Exit 4 means no declaration matched. Full `ocx capabilities --json` and
`--mutating-only --json` are useful for broad inventories, not mandatory preflight.
Declarations describe the installed CLI; actual handlers remain the grammar authority.

## Choose a workflow

Start with the named read or preview, then follow its recipe. Help is offline;
the target column describes execution. A listed write still needs authority for
that task, and read-oriented probes can contact upstream services.

| Task domain | Start | Execution target | Verify the result |
|---|---|---|---|
| Lifecycle | `ocx status --json` | Local runtime | Compare readiness, runtime identity and version; [diagnosis](references/03_recipes.md#7-diagnose-management-api-is-unreachable) |
| Providers and models | `ocx provider snapshot --json` | Live management; local authoring is separate | Read saved state and catalog disposition; [provider edits](references/03_recipes.md#6-save-locally-or-change-the-running-provider-configuration), [model identities](references/03_recipes.md#14-add-a-custom-model-locally-or-on-the-running-proxy) |
| Accounts | `ocx account list --json` | Live management | Read active/selected state; quota is opt-in and can probe upstream; [pool policy](references/03_recipes.md#17-inspect-pool-policy-before-changing-account-scope), [per-key quota](references/03_recipes.md#30-read-one-api-key-pools-quota) |
| Agents and routing | `ocx route policy list --json` | Live management; `v2` distinguishes local and live | Inspect revision, saved overrides and apply outcome; [routing edits](references/03_recipes.md#15-create-or-revise-a-routing-profile-from-an-editable-document), [runtime settings](references/03_recipes.md#20-change-runtime-settings-and-v2-with-explicit-targets) |
| Integrations | `ocx help integration` | Selected runtime and its client files | Preview before applying; inspect refusals and ownership; [file integrations](references/03_recipes.md#21-preview-a-file-integration-then-commit-the-reviewed-plan) |
| Observation and maintenance | `ocx logs filter --help` | Live management; connected `usage` is self-scoped | Retain window, filter and incomplete/partial facts; [filtered reads](references/03_recipes.md#28-select-a-bounded-log-window-and-search-usage-model-rows), [companion totals](references/03_recipes.md#29-read-the-saved-companion-usage-view) |
| Access and remote | `ocx connect status --json` | Local connection; management runs on its serving host | Separate connection health, key scope and revocation; [remote targeting](references/05_remote_hub.md), [private key handoff](references/03_recipes.md#27-hand-off-a-selected-key-model-or-audio-check) |
| Lab | `ocx help lab` | Local evidence; explicit probes and automation have effects | Inspect evidence and export/probe limits; [Lab workflow](references/03_recipes.md#13-inspect-local-lab-evidence-before-exporting-or-running-probes) |

These are task entry points, not a count of GUI parity. Native window focus,
browser presentation and session-only actions retain their own interfaces.
Grant inspection does not authorize grant consumption; persisted local Desktop
export does not export an unsaved dashboard draft.

## Before live management work

1. `ocx ready --json` checks readiness (`ready`, `pending`, `failed`, `unreachable`).
2. `ocx status --json` checks the target and `versionSkew.relation`. `unknown` is
   not a confirmed match; a mismatch needs the intended installation resolved.
3. Run the task with `--json` **only when that leaf supports it**. `ocx doctor`
   rejects it; `ocx v2` supports JSON for both local and explicit live targets.

These checks do not require starting a proxy for offline help, local provider
configuration, config validation or local Lab inspection. On a connected client,
ordinary management commands do not automatically target the hub: perform them
on the hub or use its dashboard. See [remote targeting](references/05_remote_hub.md).

Inspect both the exit code and receipt. Saved config, runtime application, client
file convergence, skipped work and partial completion are different outcomes;
read back the relevant setting after a write. Exit 0 also covers previews and
intentional no-ops. Management failures normally print stderr prose even with
`--json`; usage codes include 2 and legacy 64 exceptions for `capabilities`,
`ready`, and `resolve`. See [JSON shapes](references/02_json_shapes.md) and
[failure semantics](references/04_failure_semantics.md) before scripting recovery.

## Observation and explicit-key API tasks

For request/injection follow, timeline exclusions and scoped usage, start with
[observation recipes](references/03_recipes.md#25-follow-observed-windows-without-claiming-lossless-history).
Use versioned log events to reconstruct observed windows; row JSONL cannot express
removals. Neither stream guarantees lossless traffic history.

Selected-key model/audio tasks are separate from management calls. They require
explicit operator authorization for upstream calls/uploads and a private human
terminal handoff for key input. Never collect the key in this agent session,
argv or environment, and never substitute an admin/enrolled credential. Read
[the selected-key and audio recipe](references/03_recipes.md#27-hand-off-a-selected-key-model-or-audio-check)
before proposing one. Reports are observations, not key-scope/billing certificates.

## Consent: one thing you must not do

**Do not star the repository on the user's behalf.** `ocx inspect star` reads the status, and that
is the entire CLI surface for it. The starring POST requires a dashboard session, so an ordinary admin-token
management call cannot perform it. That is not a barrier against a determined local
agent; the consent rule still binds every mechanism because it spends *their* GitHub identity. Do not route around it with `gh`, a direct HTTP call, or a minted session. If
starring would be useful, say so and let the user decide.

The same boundary covers the session-gated `/api/codex-prompt` writes: read them with
`ocx inspect codex-prompt`, and leave the writes to the dashboard.

## Secret-bearing commands

**Do not create an access key or start an access-key rotation from an agent session.**
This covers the create and rotation-start operations under `ocx access key`,
`ocx access keys`, and `ocx api-key`, their `opencodex` equivalents and executable
wrappers, and direct POST requests to `/api/keys` and `/api/keys/rotate`.
Both text and JSON responses contain a one-time plaintext data-plane credential,
which can enter the agent transcript. Ask the user to perform that step in a
human-operated terminal outside the agent session, configure and verify the
replacement, and report only confirmation plus non-secret key/rotation IDs.
Never ask for the plaintext key in chat or offer a pipe, redirection, or API
workaround to perform the secret-returning step inside the agent session.

`ocx hub invite` has the same boundary: text and JSON output expose a plaintext pairing
grant or a command embedding it. Use the human-operated terminal handoff in
[recipe 10](references/03_recipes.md#10-invite-one-more-machine-onto-a-hub); never ask for
the grant or generated command in chat. Continue non-secret setup and verification normally.

Configuration confirmation is not approval to revoke the existing credential.
Identify the existing key ID and obtain separate explicit revocation approval
before committing an in-place rotation or removing an old, separately replaced key.
An existing explicit approval for that exact revocation remains valid; setup
confirmation alone does not supply it. Commit and abort return no plaintext key,
but still require authority for their state changes. Follow
[recipe 5](references/03_recipes.md#5-prepare-an-access-key-rotation-without-exposing-the-new-key).

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

## Remote hub

Read `ocx status` on the hub and `ocx connect status --json` on the client before
changing their configuration. Pairing is not required to configure the hub.
The optional loopback companion serves inference only, never management calls.
A human transfers the invite directly to the joining machine outside this session.
Remote credential inputs remain stdin-only (`--pairing-code-stdin`,
`--admin-token-stdin`), never literal argv or environment values.

Disconnect restores local state but leaves the hub key valid. With explicit
revocation authority, revoke while still connected, or have the operator revoke
on the hub after disconnection. Do not work around ownership or partial-restore
refusals. [Remote hub](references/05_remote_hub.md) covers the one-port setup,
credential handoff, managed rotation and disconnection order.

## References

| File | Use it for |
|---|---|
| [Management index](references/01_management_surface.md) | declared capabilities in eight task chapters, with routes, flags and mutation notes (generated) |
| [JSON shapes](references/02_json_shapes.md) | response envelopes and error shapes |
| [Recipes](references/03_recipes.md) | copy-paste sequences for real tasks |
| [Failure semantics](references/04_failure_semantics.md) | exit codes, 503 classes, what to retry |
| [Remote hub](references/05_remote_hub.md) | hub/client roles, when pairing is and is not needed, key rotation, disconnection |

The generated index routes to eight task chapters. Lab includes local reads,
public evidence operations and explicit automation controls; it is not read-only.
Read-oriented probes can contact providers, consume quota or refresh caches.
Routing-profile writes use explicit file/revision workflows; discovered-model
display-name edits use raw upstream IDs, distinct from custom-model editing. Browser presentation and
session-only consent actions remain outside agent management authority.

The index and chapters are generated by `scripts/generate-ocx-skill-surface.ts`.
If metadata and execution disagree, check the installed CLI version and the live
target before reporting unsupported behavior; do not infer a new flag.
