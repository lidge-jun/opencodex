# DONE — 2.43.0 release train

Both owner-authorized channels are published and downloadable:

- npm latest 2.43.0; main/tag/gitHead 06ec553630fa2ee51a96b5cbf694089021249194; GitHub https://github.com/lidge-jun/opencodex/releases/tag/v2.43.0
- npm preview 2.43.0-preview.20260906; preview/tag/gitHead 53c784c2a635b061799e4f7542432a921f548bf9; GitHub https://github.com/lidge-jun/opencodex/releases/tag/v2.43.0-preview.20260906
- dev pre-moved to 2.44.0 at 81871b3fa7034250b8d5ba2cbbfde44e40f0e69c.

Final verifier exited 0: registry dist-tags, both package gitHeads, release draft/prerelease flags, remote tag SHAs, tarball SHA-512 integrity, 1033 packaged files per channel, CLI/source/dashboard entrypoints, and three stable source files byte-matched to the main commit. Required exact push CI and Service lifecycle succeeded for both release SHAs; main docs deployment also succeeded.

Both Release workflows returned failure solely after successful signed npm publication, because registry processing exceeded their five-minute smoke windows. Waited for real registry metadata and downloadable tarballs, rebuilt notes using the unchanged canonical script, and completed the skipped GitHub release creation. No duplicate npm publish and no fake green workflow claim. Stable signed provenance transparency log index 2727757812; preview 2727657111.

Known residuals: pending fixes deferred by owner; CodeQL promotion warnings not dismissed or claimed fixed; full Windows suite remains outside the current shipping gate. Windows install/keyring/service checks passed. Two nonresponsive audit agents were retired; direct release audit recorded honestly.

Original checkout remains dev at ef9c538f36f94f0e95c7f4833642e5b03bd29e2e; pre-existing modified/untracked closeout files untouched. No installed runtime or service configuration was changed. Next work is the separately deferred fixes; no required release work remains.
