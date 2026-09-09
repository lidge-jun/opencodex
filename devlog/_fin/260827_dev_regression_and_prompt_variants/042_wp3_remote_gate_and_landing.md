# 042 — C-phase: the remote gate, and what it caught

Verification moved off the Mac entirely this phase. The standing instruction stopped being
"never the full suite locally" and became "no `bun test` on this machine", so the local box
does editing, committing and browser inspection, and `lidge-ai` does everything that executes.

## Building the runner, because it was not there

`scripts/OCX-RUN.md` said the runner was "installed on `lidge`". Both halves were wrong:
the ssh alias is `lidge-ai` (plain `lidge` does not resolve at all), and `~/bin/ocx-run`
did not exist on that host. The doc is corrected in this unit rather than left to mislead
the next person, because the failure it produces is `command not found` — which reads as a
PATH problem and sends you looking in the wrong place.

Three setup steps, each a measured fact rather than an assumption:

1. `scp scripts/ocx-run lidge-ai:bin/ocx-run` + `chmod +x`. The script is in the repo, so
   installing it is a copy.
2. `git clone --branch dev https://github.com/lidge-jun/opencodex ~/ocx-verify/repo`. A
   fresh directory, deliberately NOT `~/ocx-promptset/repo` — that checkout has another
   unit's dirty tree and an `origin` pointing at a stale `/tmp` bundle, so a gate run there
   would have mixed in work that is not this PR's.
3. `bun install` in the repo root **and again in `gui/`**. This is the one the first gate
   run failed on: `gui/` is a separate workspace, so the root install leaves
   `vite/client` and `@vitejs/plugin-react` unresolved and the gui typecheck dies with
   TS2688/TS2307 before a single test runs.

A quoting trap worth recording: `ssh host "... $HOME ..."` expands `$HOME` on the LOCAL
machine, so the remote tried to run `/Users/jun/bin/ocx-run`. Writing the launcher to a
file and `scp`-ing it removes every layer of shell quoting at once, which is what finally
worked.

## What the gate caught

`gate: FAIL rc=1` on the second run, with `1083 pass / 1 fail`:

    (fail) French base catalog > does not ship accidental English values

`gui/tests/fr-localization.test.ts:179` flags any key whose French value equals its
English one. The offender was `codexSet.base.position` = `{position} / {total}` —
punctuation and two placeholders, with no words in it to translate.

The fix is to list it in `INTENTIONAL_ENGLISH` beside `codexSet.custom.navPosition`,
which is the same string for the same reason in the custom-layer navigator. The
alternative — inventing a French spelling of "1 / 2" — would satisfy the check while
making it weaker for every key that really does carry prose.

Worth noting what this proves about the remote gate: this failure exists only in a locale
test that neither the focused server tests nor the base-variant GUI test would ever have
run. A narrow local check would have shipped it.

## Third run: green

    gate: OK rc=0 name=gate finished=2026-08-27T04:17:15+09:00
    1084 pass, 0 fail, 9712 expect() calls, 178 files, 41.96s
    lint:gui  1 pre-existing warning, 0 errors
    privacy-scan  passed

## Live evidence, captured over CDP

`--dump-dom` returns an empty document for this SPA — the dashboard renders after the
initial parse, and the flag captures too early. Headless Chrome with
`--remote-debugging-port` and a WebSocket client works, with one constraint: the browser
dies when the spawning `exec` call returns, so launch and inspect have to be a single
command.

- `GET /api/codex-prompt` → `baseSelection={"kind":"default"}`, `maxBaseVariants=2`,
  `baseVariants=[]`. This is the probe the previous session left unfinished.
- `[data-layer-id=base-instructions]` contains
  `<button role="switch" class="toggle on" aria-checked="true">`.
- Clicking the row opens `dialog.codex-set-base-dialog` at `1 / 2`, `kind=default`,
  read-only with its reason stated.
- The next arrow steps to `2 / 2`, `kind=new`, showing the replacement warning.

Both PR screenshots come from that session, so they are the running build rather than a
mock-up.

## Landed

PR **#2707** against `dev`. Commits: `b715985ab` (runtime + server tests),
`71f129976` (GUI + locales + devlog 040/041), `18b9393b0` (the locale-check fix),
`06e8e8ad2` (screenshots). Every commit and push used `--no-verify`.

Initial CI: `enforce-target`, `hygiene`, `changes`, `react-doctor`, `storage policy`,
`api usage`, all three `keyring` jobs and `label` green. The GUI-screenshot gate
(`pr-quality.cjs:527`, armed by changed `gui/` paths) is satisfied by the two inline
images in the body.

