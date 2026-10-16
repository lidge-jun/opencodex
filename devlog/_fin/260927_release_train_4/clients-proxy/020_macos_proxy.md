# Phase 2: macOS system proxy discovery (#5893)

Depends on `010_recipe.md` for lane order. Carry the small proxy change after
rebasing its draft head onto current `dev`; do not change Windows discovery or
explicit proxy precedence. `structure/config-proxy.md:1-20` owns the contract.

## Exact change map

- NEW `src/config/macos-system-proxy.ts`: observe and parse macOS system
  proxy settings only on Darwin; return no discovery for disabled, malformed,
  or unavailable settings. No caller imports this module on every request.
- MODIFY `src/config/proxy-env.ts`: before, `proxy: "auto"` considers the
  existing Windows path and merges loopback bypasses. After, Darwin discovery
  is considered only for that explicit setting and when no inherited scheme
  proxy wins. Translate macOS exceptions only when their matching semantics
  are proven equivalent to Bun's `no_proxy` semantics. A bare name such as
  `localhost` must not enter either effective proxy-bypass variable as a
  suffix. If any system exception is not faithfully representable, refuse
  macOS auto-discovery and leave process proxy variables unchanged with a
  privacy-safe diagnostic. Preserve the address-only loopback bypass. Add
  proven-safe entries to the bypass variable the selected HTTP(S) transport
  actually reads. If inherited `ALL_PROXY`/`all_proxy` selects SOCKS,
  macOS discovery must not add scheme proxies or discovered exceptions.
  Preserve the inherited proxy path and assert both transports'
  effective routes when the two bypass variables disagree. Redact
  credential-bearing proxy URLs.
- MODIFY `tests/server/proxy-env.test.ts`: retain source tests and add a case
  with lowercase `no_proxy` distinct from uppercase `NO_PROXY`; assert the
  effective bypass after activation. Drive a request to `localhost` and
  `app.localhost` (or the proxy matcher used by that request) and prove that
  the exception does not widen direct egress. An unrepresentable exception
  must refuse discovery before the normal `mergeNoProxyEntries` tail; assert
  a full byte-identical snapshot of `HTTP_PROXY`, `HTTPS_PROXY`, lowercase
  equivalents, `ALL_PROXY`, `all_proxy`, `NO_PROXY`, and `no_proxy`. Cover
  safe wildcard/IP entries, malformed/disabled `scutil` output, explicit
  environment precedence, `proxy` unset, inherited SOCKS `ALL_PROXY` with
  conflicting uppercase/lowercase bypass lists, and unchanged Windows
  behavior. Tests use
  a mocked system command; they do not claim a real macOS Settings session.
- MODIFY `structure/config-proxy.md` and the English plus affected translated
  `docs-site/src/content/docs/*/reference/configuration/server.md` pages to
  state the actual opt-in/automatic precedence after code is verified.

## Acceptance and proof

Activation scenario: Darwin with `config.proxy: "auto"`, no inherited HTTP(S)
or SOCKS proxy (`ALL_PROXY`/`all_proxy` included), and valid system settings
sets the proxy and safely representable bypass list. Bypass precedence is
asserted per transport: Bun's native HTTP(S) fetch reads a non-empty lowercase
`no_proxy` before `NO_PROXY`, while `resolveProxyRoute` honors an explicitly
defined uppercase `NO_PROXY`, including an empty value. Tests keep route
assertions for both transports when the two variables disagree.
Negative scenarios: unset `config.proxy` never reads macOS system settings or applies
discovered routes, while the existing inherited-proxy loopback bypass remains;
inherited HTTP(S) or SOCKS proxy wins without mixed bypass semantics,
unrepresentable exceptions refuse before any environment write, disabled or
bad system settings leave egress unchanged, and Windows keeps its prior route. Run
`bun test tests/server/proxy-env.test.ts`, `bun run test:changed`, `bun run
typecheck`, `bun run structure:check`, and `bun run privacy:scan`. Build
`docs-site/` if docs change. `tests/lab/core-lab-boundary.test.ts` checks the
core import rule. Perform explicit security review of credential-bearing
proxy URL handling. Recheck exact-head CI and live `dev` CI before the next batch.
