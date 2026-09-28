# Proxy Configuration

`src/config/proxy-env.ts` remains the single application owner for global proxy
configuration. An explicit SOCKS5 or SOCKS5h URL selects ALL_PROXY and removes
stale scheme-proxy variables; HTTP(S) settings retain their existing environment
precedence. Activation keeps the existing Windows auto-discovery path and adds opt-in
macOS discovery for `proxy: "auto"`. It never consults macOS settings when any scheme
proxy or `ALL_PROXY`/`all_proxy` is inherited. The shared path keeps loopback
NO_PROXY entries; the no-configured-proxy return merges all of them only when an inherited
SOCKS proxy is the only inherited proxy; whenever Bun applies an inherited HTTP(S) scheme proxy
or HTTP(S) `ALL_PROXY`/`all_proxy`, it matches by domain suffix, so activation adds only the
loopback addresses (never `localhost`); a proxy-free
process is left untouched. The in-process
matcher treats a bare `localhost` or IP-literal entry as one host, never a suffix. When opposite-case
`ALL_PROXY` and `all_proxy` provide SOCKS and HTTP(S) together, the SOCKS wrapper forces an exact
`localhost` request direct while keeping the address-only environment bypass. An inherited non-empty
lowercase `no_proxy`, which Bun fetch reads first with suffix matching, receives only the loopback
addresses from the shared path; macOS auto-discovery adds its translated exceptions separately. When the
environment no longer selects SOCKS, activation
restores the native fetch; removing a saved field alone does not erase inherited
process environment variables.
SOCKS4 is rejected instead of being advertised as a working transport.

`src/cli/start-args.ts` parses `ocx start --socks5 [host:port]` and the mutually
exclusive `--socks5-off`. The start owner persists only an explicitly requested
change; the off flag refuses to erase a non-SOCKS proxy. Invalid-address errors
never echo user-supplied credentials, and status messages redact proxy URLs.
The parser regression cases live in `tests/cli/start-args.test.ts`.
The config CLI masks credential-bearing `proxy` URLs in show, get, and mutation output:
userinfo is stripped while host and port stay visible, `direct` and credential-less values
print unchanged, and a non-URL value that is not `direct` is masked whole. `config export`
keeps the raw file so exports can restore credentials. Get and mutation output select
redaction by the normalized final path segment, matching lookup and mutation semantics.

On macOS, `src/config/macos-system-proxy.ts` reads the top-level static HTTP/HTTPS
settings from `/usr/sbin/scutil --proxy` once, with a timeout and output bound.
Only enabled schemes are installed. IP literals and the all-host `*` exception
are translated. A single leading `*.` followed by a valid DNS name maps to
`.<domain>`; Bun matches at label boundaries, so `foo.local` bypasses for
`*.local` while `xlocal` does not. Bun also bypasses the bare apex `local`,
the one widening of that translation. The exact link-local ranges
`169.254/16`, `169.254.0.0/16`, and `fe80::/10` are omitted because Bun
cannot represent them; one generic diagnostic says link-local IP literals
use the proxy. Other CIDRs or glob forms, simple-host bypasses, PAC/WPAD,
and malformed settings refuse discovery before any proxy-environment write.
Accepted exceptions and configured `noProxy` entries enter both `NO_PROXY`
and an inherited non-empty `no_proxy`, since Bun gives lowercase precedence.
Before macOS discovery there is no inherited proxy, so Bun's suffix matching
of an ordinary configured name can only keep that name and its subdomains on
their pre-discovery direct route; it cannot move a host onto the proxy. When
an inherited non-empty lowercase `no_proxy` exists and configured `noProxy`
contains bare `localhost` (any case, with or without a trailing dot), discovery
refuses before any environment write. Bun cannot represent that exact-host
bypass in lowercase: adding it would also bypass `app.localhost`, while omitting
it would send exact `localhost` through the new proxy. Without inherited
lowercase `no_proxy`, the existing uppercase-only merge remains. This applies
only to macOS discovery, not inherited or explicit proxy activation. For
loopback, only addresses are appended, never an automatic bare `localhost` suffix.
Inherited SOCKS routes keep their existing uppercase bypass semantics and do
not receive macOS exceptions. The diagnostic reports a category, never raw
settings or credential-bearing URLs. Regression cases live in
`tests/server/proxy-env-macos.test.ts`.
