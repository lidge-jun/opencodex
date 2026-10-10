# Publication outcome: 2.77.0 released

OpenCodex 2.77.0 is published as the stable `latest` release from `main`
commit `06841165f884a9176d701310638b2112aca7a514`, whose tree is identical to
the verified candidate `0818ea1812`.

1. Version pre-move #6549 opened `dev` at 2.78.0 (`87e3156339`) after its exact-head
   Cross-platform CI and Service lifecycle passed.
2. Promotion #6550 merged as a merge commit through the owner-authorized admin PR
   route. As with #6468, only the main-target `enforce-target` rule and CodeQL's
   new-alert count against `main` were red; neither gates `release.yml`.
3. Push-event Cross-platform CI
   [37169967963](https://github.com/lidge-jun/opencodex/actions/runs/37169967963)
   and Service lifecycle 37169967951 succeeded on `06841165f8`.
4. Release workflow
   [37170949169](https://github.com/lidge-jun/opencodex/actions/runs/37170949169)
   (`version=2.77.0`, `tag=latest`, `dry-run=false`, `expected-sha=06841165f8`)
   succeeded in every job: dispatch validation, preflight, five standalone and three
   desktop packages, verification, npm publish, release attachment and outcomes.

Published evidence:

- npm `@bitkyc08/opencodex@2.77.0`, dist-tag `latest`, gitHead `06841165f8`,
  shasum `4b0155005e19588bdaab1661eb02479de5546dad`, SLSA v1 provenance (Sigstore
  log index 3076198266). The registry served the version about five minutes after
  the publish step acknowledged it.
- GitHub release [v2.77.0](https://github.com/lidge-jun/opencodex/releases/tag/v2.77.0),
  tag on `06841165f8`, marked Latest, 25 assets (same set shape as v2.76.0):
  standalone archives for darwin arm64/x64, linux arm64/x64 and windows x64, the
  macOS app/dmg, Linux AppImage/deb and Windows MSI, checksums, updater signatures
  and `latest.json`.
- Docs deploy for `06841165f8` succeeded (run 37169967937).
- Install smoke in a throwaway npm prefix with an isolated home: `ocx --version`
  reports `opencodex 2.77.0` and `ocx help` runs; the darwin arm64 archive matches
  its published SHA-256.

Not verified here: launching the signed desktop installers on real macOS, Windows
and Linux hosts, the in-app updater path from 2.76.0, and the native limits already
recorded for #6220, #6473 and #6502. The intermittent Windows test-teardown
`EPERM` described in `022_candidate_acceptance.md` remains a test-cleanup follow-up.
