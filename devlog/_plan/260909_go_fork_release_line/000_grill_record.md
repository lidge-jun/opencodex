# Grill record — fork release line direction for the Go takeover

Date: 2026-09-09
Status: **decided — executing** (dogfood phase; archive to `_fin` once the Go
artifact ships through the release line)

## What was grilled

A `grilling`-skill session (design tree, round by round) stress-testing what
happens after the CLI flip close-out (#56/#58/#55 closed, #44 the only open
tracker). The driver question was the next-phase direction of the Go takeover
line, with everything downstream of it forced to be explicit.

## Decision tree — each node and the owner's ruling

1. **Grill object** → the *roadmap*: what the next batch of Go migration work
   is and in what order.
2. **Milestone anchor** → *capability*: a phase is won when a user-visible
   capability works without Bun, not when code structure is Go-shaped.
   (Grounding fact: the most convincing verification of the day was the
   runtime-probe tests turning green by themselves once the port-10100
   instance stopped.)
3. **Next-phase verb** → *(c) ship an installable artifact first* — build and
   run `go/bin/ocx` (never built before), then decide use/coverage from the
   artifact's real state. Rationale: (a) use-migration without a verified
   build is jumping the unknown; (b) coverage expansion before any use
   feedback is blind.
4. **Destiny of the fork `dev-go` line** → *(a) the fork is the main
   battlefield* — the owner forks independently, releases their own versions,
   and *considers donating upstream once mature*. Fork = final line; upstream
   (lidge-jun/opencodex) = reference pulled, future donation target.
5. **ADR contradiction fix scope** → *(b) ADR-0008 + ADR-0009* — close the
   contradiction inside the ADR asset; CONTEXT.md/AGENTS.md fork-reality prose
   is operational guidance, a separate governance decision, not ADR business.
6. **Artifact action** → *(a) local build + smoke* — build `go/bin/ocx`,
   verify the 42 Go-owned commands run natively, the 10 TS-owned print the
   standalone delegation error, and the dev-mode delegation path works.
7. **Artifact destination** → *(c) dogfood first* — point daily `ocx` at the
   Go binary, let real use surface the gap list, fix gaps, *then* ship
   (also the accumulation basis for the upstream-donation maturity test).

## Facts the tree rested on (all verified, not assumed)

- **F1** — CLI registry 42 Go-owned / 10 TS-owned (Bun-dependent by design per
  ADR-0009); oracle-able surface complete.
- **F2** — All takeover work lives on fork `dev-go`: 1033 ahead / 183 behind
  `upstream/dev`; `go/` is 9 subsystems, ~57k lines.
- **F3** — ADR-0008's end state ("single binary at 100% differential parity")
  was written for the upstream line; the delivered increment set is fork
  tickets #1–#43, all closed — including #40 single-binary packaging, #41
  cutover (Go binary is the *release runtime*), #42 release pipeline, #43
  upgrade/rollback oracle.
- **F4** — Fork vs upstream relation had never been made explicit before this
  session; zero PRs exist fork→upstream.
- **F5** — The sidecar/server face is far past "first read route": hot path,
  non-streaming relay, ws bridge, SSE relay, Lab routes all closed.
- **F6** — Nobody had ever run the Go binary: `go/bin/` had no artifact, the
  operating instance and daily CLI were the npm TS build.
- **F7** — Only open issue is #44 (seam tracker).
- **F8** — The fork's npm line already publishes on its own cadence:
  `@bitkyc08/opencodex`, 233 versions, latest 2.48.0 (2026-09-08); upstream
  has no npm package under `opencodex` (E404), so no version collision.
- **F9** — `release.yml` (post-#42) requires release tags to attach a
  TypeScript-free single-binary Go artifact behind the `go-release-artifacts`
  gate — but no such release was ever produced (`gh release` empty; npm tarball
  has no Go binary).
- **F10** — The ADR contradiction, precisely: ADR-0008's "TypeScript CLI and
  server remain the operating surface" vs the #41/#42 reality "Go binary is the
  release runtime / release tags ship single-binary artifacts". ADR-0009 had
  superseded the 100%-parity clause without ADR-0008 marking it.
- **F11** — Standalone Go binary on the 10 TS-owned commands prints "this
  standalone ocx binary needs the TypeScript lifecycle owner…" (exit 1)
  unless `OCX_TYPESCRIPT_CLI` points at a full distribution; dev-mode
  delegation discovers `src/cli/index.ts` walking up from cwd.

## Delivered (same session)

- **ADR update** — commit `3803c2afd`: ADR-0008 gains a "Status update
  (2026-09-09)" section (increment state #1–#43, operating surface now Go,
  parity clause explicitly deferred to 0009, fork-line prose marker); ADR-0009
  gains a fork-line addendum tying its Bun-dependent list to the 10 standalone
  delegation commands.
- **First artifact build + smoke** — `go/bin/ocx`: 20 MB static ELF
  (CGO_ENABLED=0, `-ldflags -X main.version=2.42.0`). Smoke rows all green:
  `--version` from any cwd; `help` (74 lines); `v2 status` native on an empty
  home; standalone delegation error (exit 1, F11 text) from a non-repo cwd;
  dev-mode delegation through `src/cli/index.ts` (exit 0, `Usage: ocx restore
  [back]`); claude disabled gate byte-identical to the parity expectation
  (exit 1); `login zai` running native (key slice, not delegation).
- **Dogfood switch** — `~/.local/ocx-dogfood/ocx` → `go/bin/ocx`, PATH
  prepended in `~/.bashrc` (interactive shells now resolve `ocx` to the Go
  binary, verified). Revert: delete the two trailing `.bashrc` lines, or call
  `~/.bun/bin/ocx` explicitly. The npm install stays untouched.

## Open observations during dogfood (gap list, to be filled by real use)

- 42 Go-owned commands' daily feel (v2/claude/opencode/status/sync/…).
- The 10 TS-owned standalone error paths — with the caveat that running
  *inside the repo cwd* silently delegates to Bun (dev mode); only outside the
  repo does the standalone error surface. First open question this raises:
  should any of the 10 become native (which are actually needed standalone)?
- Sidecar face: the artifact runs the CLI; the server face (`ocx start` via the
  Go sidecar vs the TS server) has not been exercised as a daily surface.

## Not yet decided (downstream of the gap list)

- Release mechanics for the Go artifact (the never-run `release.yml` attach
  path; GitHub release tags vs npm channel split).
- Fork governance prose in CONTEXT.md/AGENTS.md (deferred out of the ADR scope
  ruling; operational guidance, needs its own decision round).
- The upstream-donation maturity test (what "mature" means — fed by dogfood
  and shipped-release experience).

## References

- ADRs: `docs/adr/0008` (status update), `docs/adr/0009` (fork-line addendum).
- Fork ticket #44 (open) — the seam tracker whose body records the registry
  state this direction builds on.
- Session commits on `dev-go`: `b7d969602` (claude flip), `ce4b30760` (update
  archived), `8c582a851` (devlog archive), `0af23fe1a`/`7d241c60b` (style),
  `868f433ee` (owner's spawn guard), `3803c2afd` (ADR update).
