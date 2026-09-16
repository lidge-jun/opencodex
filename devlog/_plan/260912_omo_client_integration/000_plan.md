# omo as an export and integration client

## What this unit adds

`omo-ai@beta` (5.0.0-0.beta.53, bin `omo`, repo `code-yeongyu/oh-my-openagent`)
describes itself as "omo native edition - the senpi-based OMO harness". It keeps
engine state under `~/.omo/agent` and its allowlist of carried-forward state
files names `models.json` — the same custom-provider catalog Pi, Prime and Aside
read. The user asked for its preset to appear on the Integrations page beside
the other thirteen clients, with a real brand mark.

This unit registers `omo` as the fourteenth export client and the fourteenth
file integration, reusing the Pi builder the way `prime` and `aside` already do
rather than restating the document shape a fourth time.

## Why the Pi family is the right precedent

`prime` is documented in `src/clients/config-export.ts` as "the pi coding agent
shipped under a different brand": it derives its config directory and env prefix
from its own `piConfig` block, so `models.json` is the same contract. omo reaches
the same place by a different route — it is a harness around
`@code-yeongyu/senpi`, written by the same author as Pi — so the claim has to be
verified against senpi's parser rather than assumed from the family
resemblance. `001_omo_contract.md` carries that evidence; the builder is only
reused where the bytes are verified to be accepted.

## Path resolution

omo publishes its own precedence in `bin/lib/agent-dir.js`:
`OMO_CODING_AGENT_DIR`, then `SENPI_CODING_AGENT_DIR`, then
`PI_CODING_AGENT_DIR`, then `~/.omo/agent`. The third entry is Pi's variable and
is deliberately honored by omo itself, so mirroring the chain is reporting omo's
contract, not inventing a shared one. Relative overrides are refused for the
reason MCode, ZCode, Pi and Prime already refuse them: a background proxy and a
foreground client can have different working directories and would otherwise
disagree about which file is named.

## Work phases

| id | phase | contents |
|----|-------|----------|
| wp1 | roadmap | this unit: contract evidence, registration checklist, mark provenance, per-phase docs |
| wp2 | registration | the whole atomic change: path helpers, `EXPORT_CLIENTS.omo`, contribution, `INTEGRATION_CLIENTS.omo`, CLI help and count, catalog-refresh fan-out, every GUI list and record, the mark wiring, nine locales, and every test literal and allowlist that moves with them |
| wp3 | GUI verification | build and serve this worktree's GUI, confirm the row, tab and mark render, and copy-edit the semantics prose against what the page actually shows |
| wp4 | docs | `docs-site` agents reference and integrations guide, English plus translated locales |
| wp5 | verification | typecheck, focused tests, GUI build, and the rendered dashboard proving the row and tab exist |
| wp6 | gjc rename | the Gajae Code label becomes `gjc` on every user-visible surface, with the `gajae` id untouched |

wp3, wp4 and wp6 each depend on wp2; wp5 depends on wp3 and wp4.

**Why wp2 is one phase and not two.** The first plan split backend from GUI.
Two audit rounds failed it on the same ground.
`tests/gui/integrations-invariants.test.ts` asserts sorted equality between
`EXPORT_CLIENT_IDS` and five lists, three of which live in `gui/src`; the GUI
test literals and the two translation allowlists hang off the same edit; and CI
runs `cd gui && bun test` unconditionally. There is no ordering of the halves
that leaves the tree green at the boundary, so registration is one change.

## Scope boundaries

In scope: registration of one new client id across the surfaces
`002_registration_checklist.md` enumerates, plus its brand mark and its docs
rows.

Out of scope: any change to how the Pi document is built for the existing
clients; any new remote-bind credential path; any change to the Integrations
page layout or to the journal/rollback machinery; publishing, releasing, or
pushing anything.

Also out of scope, deliberately: renaming the `gajae` client **id**. wp6 changes
what the user reads, not what the system keys on. The id is the segment in
`/api/client-integrations/gajae` and the key an enable record is filed under, so
renaming it would orphan the stored state of anyone who already connected that
client and leave our ownership record unable to match the block it wrote. The
user asked for the short name and chose the label-only scope.

## Terminal outcomes

DONE requires all five criteria in the bound goalplan to hold with fresh proof:
the row and tab render on the running dashboard with a real mark, the exported
document matches the schema omo parses at the path omo resolves, `bun run
typecheck` is clean, every exact-list test passes with omo included plus a new
omo test, and an enable/disable round trip writes and removes only the owned
fragments.

BLOCKED is the outcome if senpi turns out to reject the Pi document and no
honest mapping exists. NEEDS_HUMAN is the outcome if omo publishes no usable
first-party mark and the user wants something other than the monogram fallback.
