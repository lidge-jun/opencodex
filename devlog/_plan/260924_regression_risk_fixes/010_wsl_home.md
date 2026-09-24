# WSL Codex home

Defect: src/codex/home.ts defaultCodexHome now returns the local ~/.codex whenever it is a directory. Before #5441 a local home without config.toml let WSL discovery pick the Windows Codex home. A WSL user whose ~/.codex exists but holds no Codex state, and who ran against the Windows home, is moved to an empty local home on upgrade: auth and sessions disappear and sync writes a new local config.

#5441's case is a fresh local install that Codex itself is using before config.toml exists. Codex writes auth.json on login and sessions/ plus history.jsonl on first use.

Change (src/codex/home.ts):

- keep localCodexHomeIsDirectory (stat, ENOENT/ENOTDIR = absent, other errors = present).
- add localCodexHomeInUse(home, deps): true when any of config.toml, auth.json, sessions, history.jsonl is present by the same stat rule (unexpected stat error counts as present, never switch on doubt).
- defaultCodexHome: not a directory -> discovery ?? local (unchanged); directory and in use -> local; directory with no Codex state -> findWslWindowsCodexHome ?? local (the pre-#5441 behaviour).

Tests (new tests/codex-integration/codex-home-wsl-local-state.test.ts, registered in layout.json and test-layout-expected.json): bare local dir + Windows home -> Windows; local dir with auth.json -> local; local dir with sessions -> local; unexpected stat error on markers -> local; non-WSL unaffected. The existing codex-home-wsl.test.ts fresh-home case keeps passing (its statSync mock reports every path present).

Docs: structure/codex-home.md and the Codex integration guide sentence that says directory presence decides.


## Build note

A local ~/.codex that exists but is empty, with a discoverable Windows home, resolves to the Windows home (the pre-#5441 behaviour). That is the accepted direction: moving an existing user off the Windows home loses their auth and sessions, while a fresh user who has not run Codex locally yet loses nothing and CODEX_HOME overrides. The existing fresh-home test now models a fresh install honestly (auth.json present, config.toml absent) instead of a mock that reported every path present.
