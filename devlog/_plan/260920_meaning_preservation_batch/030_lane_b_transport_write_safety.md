# Lane B — request-scoped transport and managed-write safety

Status: PR #5264 open against `dev` at exact head `235525b52a`, hosted CI
in flight. One branch, two ordered commits plus this progress record, per the
batch topology.

## Scope

- #5087 — DNS pinning and transport selection now follow whether a proxy
  actually applies to the request, not whether one is configured.
- #5241 — a managed configuration write never follows a terminal symlink to
  another file, including apply/refresh/disable/restore and their races.

Both items carry the existing contributor pull requests by luvs01 with a
`Co-authored-by` trailer on each branch commit. The original pull requests
stay open for the coordinator.

## Branch

`codex/260920-lane-b-transport-write-safety`. Commits in order:

1. `fix(transport): decide DNS pinning by whether the proxy applies to the request`
2. `fix(integrations): reject symlinked managed write targets`

## Review findings on current dev (beyond the carried diffs)

- #5087's carried model counted a non-SOCKS `ALL_PROXY` for `http:` targets on
  POSIX only. The repository's own provider-outbound e2e drives that exact
  request through the proxy and runs green on the Windows shard too, so the
  platform gate was dropped: `ALL_PROXY` counts for `http:` on every CI
  platform. A present-but-unusable scheme-matched variable now fails closed
  instead of falling through to `ALL_PROXY`.
- The Mihomo IPv6 fake-IP gate keeps its stricter documented condition
  (scheme-matched variable or SOCKS5 `ALL_PROXY`, non-SOCKS `ALL_PROXY`
  never counts) via a dedicated `schemeMatchedProxyFor`, so the documented
  and tested #3462 behaviour is byte-identical. Moving it to the new snapshot
  would have contradicted the provider docs in every shipped locale.
- The carried #5087 diff had no regression for the DNS-failure degradation
  branch. Added both directions: a mismatched proxy surfaces the DNS error
  instead of degrading to an unpinned fetch; a scheme-matched proxy keeps the
  degradation.
- #5241's carried diff re-exported the new primitive from `src/config.ts`,
  which sits exactly at its file-size ratchet cap. The re-export was dropped;
  the only consumer imports the leaf directly.
- #5241's carried tests covered apply (at rest and swap-during-write) and the
  Cline pair boundary. Added disable and restore refusing a symlinked target
  with the linked file byte-identical. Refresh shares the apply observation
  and write path, so it inherits the same refusals.

## Decision-function reach (#5087)

Every `providerOutboundGet/Post` caller — provider discovery, the
model-catalog gather modules, quota probes, ollama show, and the management
model-refresh routes — funnels through the single changed decision. The main
inference dispatch (`providerFetch`) and OAuth token exchange
(`src/oauth/*`, bare global fetch) do not use the DNS-pinned transport today
and are unchanged.

## Verification

- Local suites, focused tests, typecheck, builds and live runs: NOT RUN (lane
  rule). Verification is static source review plus exact-head hosted CI.
- Union-defect sweep: no capped file touched (`src/config.ts` left
  byte-identical), no new test files (layout inventories unchanged), nothing
  exhaustive over a union restated (locale catalogs, rosters and generated
  counts untouched).
