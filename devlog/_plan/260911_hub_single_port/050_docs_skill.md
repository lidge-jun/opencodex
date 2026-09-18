# 050 — PR5: docs (en + ko), the `ocx` skill, and the help copy

Unit: `devlog/_plan/260911_hub_single_port`. Stack position 5 of 5. Branch
`codex/260911-l7-hub-docs-skill`, on `codex/260911-l4-hub-token-ux` = `b26eee311`
(`docs(devlog): record the PR4 review round`), which carries PR1 (launchd repair), PR2 (loopback
companion), PR3 (hub local clients) and PR4 (hub token UX). Issue: lidge-jun/opencodex#4236. The
four devlogs `010`–`040` in this directory are the source of truth for what the code does; nothing
here was copied from the plan without checking it against `src/`.

**Restacked mid-work, and it changed the copy.** The branch was cut from `fb1898e19`, the base tip
at the time. While this unit was being written the base was rebased onto PR1 and then grew a
four-commit review round (`1211759bf`, `0cfcfd284`, `75d4c5a5b`, `b26eee311`), so `fb1898e19` left
its history entirely. The rebase onto `b26eee311` had one conflict, in `src/cli/registry.ts`'s `hub`
details — both sides had edited the `--data-url` paragraph — resolved by keeping the base's new
refusal text and appending this unit's `--management-url` / `--clients` lines.

The review round was not only a text change, and four of its findings made sentences in this unit's
first draft false. All four were reconciled across all six pages (see
"Reconciled with PR4's review round" below). Every count in the Verification section is from the
rebased, reconciled tree.

No runtime behaviour changes. The only `src/` edits are help/registry copy.

## Scope: English and Korean only

`docs-site/` carries seven translations (`fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw`). This unit
rewrote **en + ko** and deliberately left the other five out of scope, matching #4241's precedent
(English first, translations as follow-ups) and the operator's instruction. Consequence recorded
honestly: `fr`, `ja`, `ru`, `tr`, `zh-cn` and `zh-tw` copies of `guides/remote-hub.md` and
`reference/configuration/server.md` still describe the pre-#4236 world — the manual
`export OPENCODEX_API_AUTH_TOKEN` step, the ported-only loopback listener, no `ocx hub invite`. Those
pages also still carry #4241's two defects (the nested `ocx config set` before its parent object, and
the retired `--allow-insecure-http`), which #4241 likewise left to a follow-up. That is one
translation-parity task, not six: the en page is now the only place the recipe is maintained.

## What shipped

### 1. `guides/remote-hub.md` (en), rewritten around the one-port recipe

#4241's structure and every claim its guard test pins are intact. What changed:

- **The setup block is the one-port recipe.** `hostname` = the tailnet IP, `hub.dataPublicOrigin`
  beside `hub.managementPublicOrigin`, and
  `ocx config set unauthenticatedLoopbackListener '{"enabled":true}'` — the port-less companion
  form. The `export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"` line is **gone**, and
  `ocx status` was added to the end of the block because the `Hub:` block PR4 added summarizes
  every line above it.
- **New `### The data-plane token provisions itself`.** The three-step precedence (env → existing
  owner-only file → 32 fresh random bytes), that only the path is printed, that a foreground
  `ocx start` reads the same file, that an **admin** token in `OPENCODEX_API_AUTH_TOKEN` is refused
  with `unset … and rerun`, and the four token-source strings `ocx status` prints.
- **New `### One port, and the ported alternative`.** The companion form, the collision refusal on a
  loopback or wildcard `hostname` (write time *and* startup), the ported form
  `{"enabled":true,"port":10104}` kept as the documented alternative, and the restart requirement —
  which is PR3's "a restart is required for ported-form hosts" caveat, stated where an operator will
  hit it.
- **New `### The hub's own local clients`.** PR3's result: `ocx claude`, Claude Desktop, Cursor,
  `system-env` and the vision helper now work on the hub. The exact admitted wire list,
  `count_tokens` named as **not** admitted (Claude Code degrades to local estimation), and why
  `/api/*` stays 404 there. The hub-gate sentence is quoted verbatim, with the note that it means the
  gate and not `clientIntegrations`.
- **New `## Inviting another machine`.** `ocx hub invite` → the copy-paste
  `echo '<code>' | ocx connect … --pairing-code-stdin` block; the origin resolution; that
  `--management-url` is a confirmation and not an override; the list of refusals that happen *before*
  a code is minted; and the `corsAllowOrigins` precondition with the exact
  `ocx config set corsAllowOrigins '["http://localhost:10100"]'` command and the reason (`ocx connect`
  presents `Origin: http://localhost:<its own port>`, grants are origin-bound).
- **New `## macOS service operations`.** The repair no-op and its exact log line; the status
  four-state table with `launchd state could not be verified` explained as an unanswerable probe
  rather than a down service; and the restart correction below.
- **Tailscale Serve kept, with two corrections.** The forwarder section survives intact (it is still
  required: Serve proxies only to `127.0.0.1`). Its example port moved from `10100` to `10110`,
  because on a companion hub `127.0.0.1:10100` is opencodex's own socket. And a new paragraph says
  **do not point Serve at the companion listener** — see the finding below. The loopback-bind trap
  table is unchanged and now says explicitly that it is about the *bind*, with the companion listener
  named as the sanctioned way to get a `127.0.0.1` socket on a hub.
- Seven new troubleshooting rows for the new failure surfaces, each naming the command that fixes it.

### 2. `ko/guides/remote-hub.md`, rewritten to mirror the en structure

The ko page existed but was a condensed pre-#4241 copy: it set `hub.managementPublicOrigin` before
creating `hub` (the #4200 defect, in Korean), exported the token by hand, and offered the retired
`--allow-insecure-http`. It is now a section-for-section mirror of the en page, including the
parent-object warning with `config parent path not found: hub`, the one-port recipe, the token
precedence, both listener forms, the hub's own local clients, the invite flow, the Serve forwarder
and the `403 origin_rejected` trap, the macOS four-state table, and the same troubleshooting rows.

### 3. `reference/configuration/server.md` (en + ko)

- **en.** PR2's port-optional paragraphs were verified present and correct, and extended: the restart
  requirement now applies to both forms and says why, and the hub gate on the hub's own clients is
  named there. The `hostname` row no longer claims a non-loopback bind *requires*
  `OPENCODEX_API_AUTH_TOKEN` — it states the real resolution order. `## Remote access` no longer says
  "the proxy refuses a remote bind without this variable", which stopped being true in PR4. New
  `hub.dataPublicOrigin` row, including that it is advisory, that it is **not** `.catch`ed (a typo is
  rejected at write time, because falling back to the bind address is what the field exists to
  avoid), and a paragraph on how the two public origins relate, why `--management-url` can only
  confirm and `--data-url` can override, and that the companion form is refused on a loopback or
  wildcard bind.
- **ko.** The ko page had no loopback-listener section at all and no Remote Hub key table. Both were
  written: a new `### 토큰을 받을 수 없는 로컬 클라이언트` documenting both forms, the refusal, the
  restart requirement, the admitted wire list and the hub gate; and a four-row key table including
  `hub.dataPublicOrigin` with the same relationship paragraph. `hostname` and `## Remote access` got
  the same token-precedence correction as en.

### 4. `skills/ocx`

- **`SKILL.md`** — "Remote hub: two things agents get wrong" became three. The new first item is the
  one-port topology, `ocx hub invite` (with `--management-url` as a confirmation), "read the `Hub:`
  block in `ocx status` before asking the operator anything", and the hub gate. The reference pointer
  now also routes to `04_failure_semantics.md` for the service semantics.
- **`references/05_remote_hub.md`** — new `## One port, and what runs on it` (both listener forms,
  the refusal, the admitted wires, an explicit "do not propose widening the listener to `/api/*`"),
  `### The hub gate on the hub's own clients`, `### The hub's data token is not yours to produce`
  (never tell an operator to export one; never regenerate; never copy the file), `### ocx status
  answers most hub questions`, and `## Inviting a machine (ocx hub invite)` with the refusal text and
  the `corsAllowOrigins` fix. `ocx hub invite` joined the command table.
- **`references/04_failure_semantics.md`** — new `## Service and launchd semantics (macOS)` (the
  repair no-op is success; `restart` does not bounce a healthy job; the four-verdict table with
  "repair?" per row) and `## A hub-gated skip is not a failure` (exit 0 with nothing written, nothing
  to retry).
- **`references/03_recipes.md`** — new recipe 10, "Invite one more machine onto a hub": read the
  `Hub:` block, `ocx hub invite --json`, hand over `command`, and the two normal refusals that burn
  no code.
- **`references/01_management_surface.md`** was **not** hand-edited. `bun run skill:surface:check`
  reported it current before and after (PR4 had already regenerated it for `ocx hub invite`), so
  `bun run skill:surface` was not needed.

### 5. Help copy (`src/cli/registry.ts`, `src/cli/help.ts`)

Read as a first-time hub operator. PR4's `ocx help hub` and `ocx help service` text is accurate, so
only three things were touched — each of them something that was wrong or missing:

- **`service` details gained the macOS restart and status semantics.** The only line about
  `restart` was Windows-specific, and after PR1 the statement an operator would infer — "restart
  restarts it" — is false on macOS. See the finding below.
- **`hub` details now say `--management-url` is a confirmation, not an override**, and explain
  `--clients`. The usage line lists the flag, so an operator reading only the help would have
  assumed it overrides and then hit a refusal. PR4's devlog records the decision; the help did not.
- **The top-level banner's `ocx status` line** now mentions the hub block, because nothing in
  `ocx --help` pointed at the one command that answers "what is this hub doing".

Nothing else in the banner was reworded. `tests/cli/cli-help.test.ts` and
`tests/cli/cli-registry.test.ts` are green.

### 6. `tests/ci-workflows/docs-remote-hub-claims.test.ts` extended

New `describe("the one-port hub recipe")`, five tests, run over **both** locales where the claim is
locale-independent:

- both locales carry `ocx config set unauthenticatedLoopbackListener '{"enabled":true}'` **and**
  `{"enabled":true,"port":10104}` (the recipe and the documented alternative);
- neither locale carries a line telling the reader to export the token. The assertion is
  **line-anchored** (`/^\s*export\s+OPENCODEX_API_AUTH_TOKEN/m`) rather than a substring: the prose
  has to be free to name the variable, because the page must say the step is gone and that an admin
  token is refused there. A substring ban would have forced the page to be vaguer than the truth —
  and the first draft of this test failed for exactly that reason, which is how the anchor got
  chosen;
- both locales route a joining machine through `ocx hub invite`, name the `corsAllowOrigins`
  precondition with its exact command, and show `--pairing-code-stdin`;
- the en page keeps `launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` and the
  `launchd state could not be verified` state;
- the en page says `Do not point Serve at the loopback companion listener`.

No new test file, so no `scripts/test-layout/layout.json` registration was needed.

## Reconciled with PR4's review round

The base's review round changed four behaviours this unit had already documented. Reading `src/` at
the new base rather than trusting the first draft is what caught them.

1. **`ocx hub invite` now refuses a loopback- or wildcard-derived data origin** instead of
   advertising `http://localhost:<port>` (which would tell the other machine to dial itself and
   spend the single-use code). The resolution order is `--data-url` → `hub.dataPublicOrigin` → the
   bind address, and the last step only works when the bind is an address another machine can dial.
   An explicit override is never second-guessed, because a loopback data origin is legitimate over
   an SSH tunnel. Documented in the invite section, the reference table, the skill, and as a
   troubleshooting row in both locales. The first draft's "…or `http://<bind>:<port>` as a last
   resort" would have sent an operator on a loopback-bound hub straight into the refusal with no
   idea why.
2. **The reused `service-api-token` file is re-checked for the admin token**, with a *different*
   remedy: delete the file and run `ocx service repair`, because `unset OPENCODEX_API_AUTH_TOKEN`
   says nothing about a file. Both collision checks now run ahead of the loopback short-circuit,
   since the launch wrapper reads that file into the variable whatever the hostname. Every page that
   said "the existing file is reused" now says it is re-checked, not trusted.
3. **The `ocx status` token states changed.** `present (env)` no longer exists — the state is always
   about the file (`present (file)`, `unsafe (file)`, `admin-collision (file)`, `missing`), and the
   shell's variable is a separate sub-line. The first draft listed `present (env)` as a state, which
   is exactly the honesty defect the review round fixed in the code. Both guides, the reference
   pages and the skill now list the four real states and explain why the file wins.
4. **Every successful invite prints a `Bound browser origin:` line on stderr**, and it is not in the
   `--json` envelope. It matters because a grant is bound to one origin while a remote `ocx connect`
   presents `Origin: http://localhost:<its own port>`, so a non-default bound origin means the other
   machine must already be on that port. The skill's recipe now says to relay that line, which an
   agent reading only `--json` would otherwise drop.

One smaller correction rode along: the `corsAllowOrigins` fix command now preserves the hub's
existing entries, so all three places that quote it say to run the line `invite` prints rather than
a hand-written one-element array.

## Findings while writing this

Two corrections that the code supports and the plan's own wording did not.

**`ocx service restart` does not restart a healthy macOS job.** *(Superseded — see
[Restart wording](#restart-wording-after-ee6a20a0e) below. The finding was right and the base fixed
the code rather than keeping the copy; this paragraph is kept as the reason the fix exists.)* The
assignment (and the design doc)
said to document "restart with `ocx service restart` or `launchctl kickstart -k …`". On darwin,
`serviceCommand` maps `restart` → `repair` (`src/service.ts:4862`), `repairService` calls
`installLaunchd` (`:3587`), and after PR1 `installLaunchd` returns early — printing
`service is already loaded from the current plist; nothing to do.` — whenever the rendered plist
equals the file, the token file is unchanged, and `launchctl print` agrees (`:2637`-`2649`). There is
no stop/start anywhere in that path. So on a healthy hub `ocx service restart` is a no-op, and after
changing `unauthenticatedLoopbackListener` the operator needs
`launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` (or `ocx service stop` then
`ocx service start`). The guide, the skill and `ocx help service` all say this instead of the
easier-to-write claim. PR1's no-op is right; the copy just has to stop implying otherwise.

**The companion listener must not be a Tailscale Serve target.** It is a real socket on
`127.0.0.1:<proxy port>`, so `tailscale serve --https=… http://127.0.0.1:10100` would be accepted —
and then fail. The companion substitutes a `RequestPolicyView` with `hostname: 127.0.0.1`
(`src/server/index.ts:790`-`800`), which makes `isApiAuthRequired` false, and in that branch
`isAllowedRequestOrigin` requires a **loopback `Host` header**
(`src/server/auth-cors.ts:90`-`94`). Serve forwards `Host: hub-name.tailnet-name.ts.net`, so the
data routes answer `403 origin_rejected` — the exact trap #4241 documented for a plain loopback
bind, reachable a second way. The guide now states this beside the forwarder, and the forwarder's
example port moved off `10100` so the two sockets cannot be confused. This is a documentation fix,
not a code change: the companion is for processes *on* the hub, which send their own loopback
`Host`.

## Restart wording after `ee6a20a0e`

The base (#4249) gained `ee6a20a0e` *fix(service): make `ocx service restart` restart a healthy
launchd job* after this unit was written, which inverts the claim the section above had just landed
in five files. `restart` no longer folds into `repair`: it runs the same refresh and, when nothing
was reloaded, runs `launchctl kickstart -k gui/<uid>/com.opencodex.proxy` in place, verifies with
`probeLaunchdLoadState`, and prints `ℹ️  service restarted (launchctl kickstart -k …)`. `repair`
keeps the no-op — a repair of a healthy service must not be an outage — and a bare `ocx service`
still selects `repair`. Linux always restarted (`systemctl --user restart`); Windows is unchanged.

So every passage that said *restart aliases repair* / *restarts nothing* / *run kickstart yourself*
was rewritten to name `ocx service restart` as the verb, and `launchctl kickstart -k` demoted to the
documented manual fallback that the failure path itself prints:

- `guides/remote-hub.md` — the macOS service-operations block now leads with `ocx service restart`
  and its one output line, states that a bare `ocx service` still picks `repair`, and notes that
  Linux/Windows never had the gap. The `unauthenticatedLoopbackListener` "restart the proxy" prose
  and the two troubleshooting rows name the command; the no-op row is now about `repair`, which is
  the verb that still correctly does nothing.
- `ko/guides/remote-hub.md` — the same three places, mirrored.
- `skills/ocx/references/04_failure_semantics.md` — the second "reads as a failure and is not" entry
  is inverted: `restart` is NOT an alias, so an agent asked for a restart says `ocx service restart`
  rather than writing a launchctl line for the operator.
- `skills/ocx/references/05_remote_hub.md` — the listener field, the hub-gate fix and the
  standalone-rollback step each name the command.
- `skills/ocx/SKILL.md` — the pointer line now carries both halves of the pair.
- `tests/ci-workflows/docs-remote-hub-claims.test.ts` — the launchd-semantics gate pins the new
  claim (`ocx service restart` … always restarts), forbids the old "is an alias of `repair`"
  sentence, and keeps the kickstart line pinned only alongside the words "manual fallback", so the
  page cannot quietly promote it back to the recommended route.

Both locales now also distinguish `ocx restart` (the proxy process you started) from
`ocx service restart` (the service the manager supervises) wherever a restart is prescribed —
`src/cli/help.ts:62`'s verb is a different one and was left alone. `src/cli/registry.ts`'s `service`
entry was already reconciled in the base by `ee6a20a0e`; the docs were made to match it, not the
reverse.

A repo-wide grep for the old claim found two more pages outside this unit's original file list, and
both were fixed in the same commit because they quote the code verbatim and the code changed:
`reference/cli/lifecycle.md` (en + ko) had `| restart | Alias of repair. |` in the `ocx service`
subcommand table, and the `ocx status` version-skew paragraph still printed the pre-`ee6a20a0e`
advice (`ocx service repair (ocx service restart is an alias)`) that `src/cli/version-skew.ts` no
longer emits. The `repair` row and the bare-`ocx service` row there are now honest about the
conditional reload too, which was a gap PR1 left rather than one this round created. The other five
locales of `lifecycle.md` (`fr`, `ja`, `ru`, `tr`, `zh-cn`, `zh-tw`) still carry both old rows —
added to Left over, same follow-up as the other translation parity work.

## Decisions

- **Keep #4241's structure and every guarded claim.** The loopback-bind trap, the forwarder section
  and the Serve constraints are still true and still the thing operators get wrong; the one-port
  recipe is additive. The guard test was extended, never relaxed.
- **en + ko only**, recorded above with the exact list of what the other five locales still claim.
- **The `hostname` row and `## Remote access` in `server.md` had to change**, even though they are
  outside this stack's nominal surface: after PR4 they state a refusal that no longer happens. A
  reference page that tells you the proxy will refuse to start is not a cosmetic inaccuracy.
- **`--management-url` is documented as a confirmation in all four places** (guide, reference,
  skill, `ocx help hub`). PR4 made the refusal deliberate; the only way an operator learns it
  without hitting it is if every surface says so.
- **`count_tokens` is documented as not admitted**, in the guide and the skill, rather than being
  left silent. PR3 pinned the 404 with a test so widening it is a deliberate act; documenting the
  current answer is the other half of that.
- **The one-port recipe sets `hub.dataPublicOrigin`** in the setup block rather than only mentioning
  it. Without it, `ocx hub invite` falls back to `http://<tailnet IP>:<port>`, which is exactly the
  address a machine behind the TLS frontend cannot use — the guide would be handing out a broken
  command.
- **The Docker section was not converted to the companion form.** The container binds `0.0.0.0`,
  where the companion form is refused and unnecessary; the section now says so in one sentence
  instead of growing a second recipe.

## Verification (exact commands, this branch)

```
bun test tests/ci-workflows/docs-remote-hub-claims.test.ts \
  tests/ci-workflows/skill-ocx.test.ts \
  tests/cli/cli-help.test.ts tests/cli/cli-registry.test.ts    # 57 pass, 0 fail, 515 expect()
bun test tests/ci-workflows/docs-remote-hub-claims.test.ts     # 12 pass (was 7)
bun test tests/ci-workflows/skill-ocx.test.ts                  # 16 pass
bun test tests/cli/cli-help.test.ts tests/cli/cli-registry.test.ts   # 29 pass
bun test tests/cli/cli-capabilities.test.ts                    # 17 pass
bun test tests/ci-workflows/docs-429-failover-claims.test.ts \
  tests/ci-workflows/docs-provider-billing-claims.test.ts \
  tests/ci-workflows/docs-readme-translation-parity.test.ts \
  tests/ci-workflows/docs-bun-source-requirement.test.ts       # 64 pass (the other docs-claims gates)
bun run typecheck                                              # clean
bun run privacy:scan                                           # Privacy scan passed
bun run skill:surface:check                                    # 01_management_surface.md is current
cd docs-site && bun install --frozen-lockfile && bun run build # 425 pages built, Complete!
```

Every command above was re-run after the restack and the four reconciliations; the counts are from
the final tree. `docs-site/AGENTS.md` requires that build for any `docs-site/` change, and it
passed (twice: once before the restack, once after). On top of it,
every in-page anchor was checked against the generated HTML rather than by eye: all six new English
ids exist in `dist/guides/remote-hub/index.html`, and a script compared every `href="#…"` against
every `id="…"` in `dist/ko/guides/remote-hub/index.html` and both `server/index.html` pages —
zero unresolved, including the percent-encoded Korean anchors
(`#한-포트-그리고-포트를-지정하는-대안`, `#토큰을-받을-수-없는-로컬-클라이언트`).

Read-only CLI checks on this machine (a live hub): `bun run src/cli/index.ts help hub` and
`… help service` were run to read the rendered copy. No `ocx service …`, `ocx start/stop/ensure/
sync/restore` and no `launchctl` command was run, per the operator's instruction.

No repository-wide suite (operator instruction); hosted CI at the exact pushed head is the proof.

## Left over

- **Five translations** (`fr`, `ja`, `ru`, `tr`, `zh-cn`, `zh-tw`) of `guides/remote-hub.md` and
  `reference/configuration/server.md`, which still carry both #4241's defects and the pre-#4236
  recipe. One follow-up. The same five copies of `reference/cli/lifecycle.md` join it: their
  `ocx service` table still says `restart` is an alias of `repair`, and their `ocx status` paragraph
  still prints the pre-`ee6a20a0e` skew advice. en + ko are fixed.
- `POST /v1/messages/count_tokens` on the loopback listener is documented as a 404 in two places. If
  PR3's open question is answered yes, both sentences move together.
- Cursor's `apiKeyMode` copy (PR3's note) is GUI text and is not documented here either way.
- `ocx hub` has one subcommand. If hub-side key listing/revocation ever lands, the guide's
  "revoke from **Integrations → API Keys**" sentences are the ones to revisit.
