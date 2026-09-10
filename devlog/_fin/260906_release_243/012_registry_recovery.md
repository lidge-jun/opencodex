# Registry processing recovery

Preview Release run 33977377565 passed dispatch guard, dependency audit, source/version/CI/lifecycle gates, changelog, and npm publish. npm signed provenance (transparency log index 2727657111) and returned acceptance for 2.43.0-preview.20260906 at 2026-09-05T16:18:25Z, explicitly saying the package was being processed. The 30-attempt registry smoke ended before processing completed, so workflow conclusion is failure; do not report it as green and do not republish.

Registry metadata subsequently became visible with gitHead 53c784c2a635b061799e4f7542432a921f548bf9. Generated the release notes with the same canonical build-release-changelog.ts (baseline v2.42.0, 15 first-parent commits covered), then completed the skipped GitHub release creation at exactly that commit. Preview flag true, draft false, tag SHA verified. The tarball was delayed further; waited until ordinary canonical download succeeded. npm pack --ignore-scripts fetched all 1033 entries. Package manifest version, CLI bin, src/cli/index.ts, gui/dist/index.html and registry SHA-512 integrity passed.

Stable Release run 33977810259 was dispatched only after exact main push CI 33976953219 and Service lifecycle 33976953226 succeeded at 06ec553630fa2ee51a96b5cbf694089021249194. Stable processing remains pending as of this record; same-registry acceptance plus later readback is the recovery route, not a blind release rerun. Canonical stable notes prebuilt at .tmp/release-01a07240/main-notes.md if its smoke deadline also precedes processing completion.

These operational recoveries preserve all publication gates. A successful package publication and reconciled GitHub metadata are the final evidence, while the timed-out workflow remains honestly recorded as failed.
