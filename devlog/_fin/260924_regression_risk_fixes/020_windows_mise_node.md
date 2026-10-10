# Windows npm global under mise-managed Node

Defect: src/update/install-detection.mjs detectMiseOwner walks /node_modules/ markers and reads <toolRoot>/.mise.backend.toml. On Windows, npm -g under a mise-managed Node installs to <mise>/installs/node/<ver>/node_modules/@bitkyc08/opencodex, so toolRoot is the Node tool root and its metadata (short = "node", full = "core:node") is read as contradictory OpenCodex ownership: ocx update is refused with metadata_inconsistent. POSIX is unaffected (lib/node_modules puts toolRoot one level deeper, where no metadata exists).

Change: after parsing, if the metadata names a Node runtime (short is node or nodejs) and its backend is not an npm: backend, the package sits in that runtime's global node_modules and mise did not install OpenCodex: return { recognized: false }, so ordinary npm detection applies. Every other mismatch, including npm:some-other-package, stays metadata_inconsistent (fail closed).

Tests (new tests/update/update-mise-node-runtime.test.ts): Windows and POSIX-shaped paths under a core:node tool root detect as npm with no mise error; short = "node" with an npm: backend stays inconsistent; the existing contradictory-metadata tests keep passing.

Docs: structure owner of src/update (install detection section).


## Audit fold (round 1 FAIL)

The exemption is narrowed: only metadata that is exactly the mise core Node runtime (short = "node", full = "core:node") AND a package path that is that tool's <version>/node_modules/<package> (the Windows npm global layout, installPath directly under toolRoot) is classified as not mise-owned. Every other backend for short node/nodejs, unreadable metadata and every OpenCodex mismatch stay fail-closed.


## Residual

detectMiseOwner treats a backslash UNC path (\\server\share) as Windows but a slash-form //server/share path as POSIX, as before this change; on such a path a case difference in the node tool directory misses the exemption and keeps the old metadata_inconsistent refusal.
