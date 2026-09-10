# wp6 — main promotion and stable release

Stable publishes only after the prerelease has been exercised. The same gates apply
with the stable dist-tag, and `release.yml` additionally refuses a prerelease version
string on `main`.

## Sequence

Confirm the preview channel showed no new defect, promote dev into `main` through a
pull request, wait for the `main` push-event `ci.yml` run to succeed, then dispatch the
Release workflow with the stable version, the `latest` dist-tag, and the pinned SHA.
Verify the published version through `npm view` rather than trusting the run summary.

Because PRs here target `dev` rather than the default branch, GitHub never auto-closes a
linked issue. `AGENTS.md` puts that manual close at the point the change reaches `dev`,
not `main`.

## Exit

`npm dist-tag` `latest` points at the new stable version, the `main` release SHA has a
successful push-event CI run, and the sweep results are recorded in this unit.

## Resolved numbers

The stable version is `2.52.0`. `assert-ahead` compares `origin/dev`'s package version
against it and requires a strict win, and 2.52.0 does not outrank 2.52.0, so dev has to
move to `2.53.0` before this release can publish. That move is its own pull request,
opened by dispatching `dev-version-bump.yml` from `main`; the workflow never pushes dev
itself.

Because the release SHA changes `package.json`, the service-lifecycle condition in
`release.yml` fires, so that SHA also needs a successful `service-lifecycle` run.

The dispatch is
`gh workflow run release.yml --ref main -f version=2.52.0 -f tag=latest -f expected-sha=<40-char main SHA> -f dry-run=false`.
`release.yml` serializes on a `release` concurrency group, so preview and main cannot
publish at the same time.
