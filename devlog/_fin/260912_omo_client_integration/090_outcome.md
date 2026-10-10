# Outcome

Shipped as PR #4290, merged into `dev` on 2026-09-12 as `eb314c53a0` at head
`9689ee8ceb0d868faa0643b036f8e8d9be4bd03c`. CI on that exact head: 25 pass, 0
fail, 2 conditional jobs skipped. Merged under the `MAINTAINERS.md` dev-only
maintainer-integration exception, with the decision and CI evidence recorded on
the PR.

## What landed

`omo` is the fourteenth export and file-integration client. It reuses the Pi
builder, opted into session affinity, resolves `~/.omo/agent/models.json` under
omo's own three-variable precedence, detects on the agent directory, and is
loopback-only by deferral. `Gajae Code` now reads `gjc` everywhere a user looks,
with the id, config path, API route and env var deliberately unchanged.

## The evidence that mattered

Three claims could not have been settled by inspection, and each was checked:

1. **senpi accepts the Pi document.** The file a live Apply actually wrote
   returned true from senpi's own compiled `validateModelsConfig`, while an
   `audio` input modality and a keyed `models` object both returned false, so
   the check could not be vacuous.
2. **The v4 false positive is rejected.** With `~/.omo` holding only
   `binary-runtime` and no `agent/` — the exact state of the machine this was
   built on — the row reads *Not installed* with Apply disabled, and creating
   `~/.omo/agent` flips it to *Not applied*.
3. **The page renders.** Tab, row and mark captured from the built GUI;
   `evidence/integrations-omo-tab.png`.

## What the process caught

Four independent audit rounds returned FAIL or NEAR-PASS and changed the work:

- The backend/GUI split was abandoned after two rounds proved no ordering of
  the halves leaves `tests/gui/integrations-invariants.test.ts` green.
- `omo` moved to the end of `EXPORT_CLIENTS` rather than beside `prime`, because
  `EXPORT_CLIENT_IDS` is `Object.keys` order and three tests assert it exactly.
- `buildOmoContribution` gained the session-affinity flag, which `build` already
  had; without it `ocx export` and an enabled integration would have written
  different documents.
- The catalog-refresh decision was forced to confront four disagreeing fan-out
  lists instead of the one the checklist named.

Two mistakes are worth keeping visible. The first attempt at the rendered proof
ran `ocx start` with only `OPENCODEX_HOME` redirected, which is not isolation —
it rewrote the user's real Codex catalog and pointed `~/.grok/config.toml` at a
port that was about to die. Both were restored and the second attempt redirected
`HOME` and `CODEX_HOME` too. And `privacy:scan` passed locally while failing on
three CI jobs, because the file it objected to was still untracked when the
local scan ran.

## Left open

- `docs-site/.../zh-tw/reference/management-api.md` lists the
  `GET /api/client-config` clients only as far as `dsh`. That list already
  omitted `zcode`, `prime`, `aside` and `raycast` before omo existed, so it is a
  pre-existing translation gap rather than this unit's debt; widening it quietly
  here would hide it.
- `prime` is in none of the catalog-refresh fan-outs. That looks like an
  oversight from when it landed, and is recorded in `002` so the next person
  does not read it as a pattern to copy.
- No CI check compares the docs client tables against `EXPORT_CLIENT_IDS`, so
  the docs rows stay guarded by review alone.
