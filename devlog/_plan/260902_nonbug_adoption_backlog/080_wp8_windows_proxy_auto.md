# wp8 — #1525 Windows `proxy: "auto"` (slice 1: startup WinINET static-proxy discovery)

Issue #1525 (score 60, enhancement/proxy/platform). Reviewer scoped the mergeable first slice:
startup-time WinINET static-proxy discovery behind `proxy: "auto"`, clear logs, no live mutation,
no direct fallback, PAC/WPAD deferred. Investigation by grok subagent (Poincare); see 081.

## Design

- `src/lib/windows-system-proxy.ts` (new): `readWindowsSystemProxy(reader?)` returns
  `{ kind: "proxy", url } | { kind: "disabled" } | { kind: "unsupported" } | { kind: "unreadable" } | { kind: "socks-only" }`.
  Reader spawns `%SystemRoot%\System32\reg.exe query HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings /v ProxyEnable` and `/v ProxyServer` with argv `execFileSync`, `windowsHide`, 2s timeout, never throws. Parsing: `https=` entry → `http=` entry → bare `host:port`; SOCKS-only ignored; normalized to `http://host:port`. The reader is injectable so tests never spawn `reg.exe`.
- `src/config.ts` `applyProxyEnv`: when the resolved string is exactly `auto` (case-insensitive, trimmed), call the discovery; on `proxy` continue with the resolved URL; every other outcome logs one privacy-safe line (no URL userinfo, and only host:port on success) and returns without setting `HTTP_PROXY` (today `"auto"` would be copied verbatim into `HTTP_PROXY`). Env vars still win; loopback `NO_PROXY` unchanged.
- `src/types/config.ts` JSDoc for `proxy`. No zod change (schema is passthrough and does not declare `proxy`).
- Docs: `reference/configuration/server.md` proxy row (English).
- Doctor: untouched this slice (it already hides values; `auto` shows as configured).

## Out of slice
PAC/WPAD, ProxyOverride → NO_PROXY, periodic re-check, direct fallback, live mutation.

## Acceptance
- Static URL / `${ENV}` / user env precedence: existing `tests/proxy-env.test.ts` unchanged and green.
- `auto` + injected reader returning proxy → `HTTP_PROXY`/`HTTPS_PROXY` set to normalized URL, log line without userinfo.
- `auto` + disabled/unsupported/unreadable/socks-only → env untouched, one log line.
- `auto` + user env set → env untouched.
- Parser unit cases: bare, `http=;https=`, `https=` only, `socks=` only, credentials stripped from log.
- tsc, privacy, focused test file.

