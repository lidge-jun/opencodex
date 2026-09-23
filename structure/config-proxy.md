# Proxy Configuration

`src/config/proxy-env.ts` remains the single application owner for global proxy
configuration. An explicit SOCKS5 or SOCKS5h URL selects ALL_PROXY and removes
stale scheme-proxy variables; HTTP(S) settings retain their existing environment
precedence. Activation keeps the existing Windows auto-discovery path and loopback
NO_PROXY entries; the no-configured-proxy return merges all of them only when an inherited
SOCKS proxy is the only inherited proxy; whenever Bun applies an inherited HTTP(S) scheme proxy
or HTTP(S) `ALL_PROXY`/`all_proxy`, it matches by domain suffix, so activation adds only the
loopback addresses (never `localhost`); a proxy-free
process is left untouched. The in-process
matcher treats a bare `localhost` or IP-literal entry as one host, never a suffix. When opposite-case
`ALL_PROXY` and `all_proxy` provide SOCKS and HTTP(S) together, the SOCKS wrapper forces an exact
`localhost` request direct while keeping the address-only environment bypass. An inherited non-empty
lowercase `no_proxy`, which Bun fetch reads first with suffix matching, receives only the loopback
addresses, never a name it would match as a suffix. When the
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
