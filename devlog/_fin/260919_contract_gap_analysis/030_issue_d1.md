# D1: [Docs]: Align SOCKS5 HTTP/SSE routing documentation with configured outbound fetch

### Documentation problem type

Incorrect documentation

### Documentation location

`docs-site/src/content/docs/reference/proxy-formats.md:257` and `docs-site/src/content/docs/reference/configuration/providers.md:514`

### What is wrong or missing?

The proxy-format guide says HTTP/SSE does not use ALL_PROXY, and provider configuration says applicable ALL_PROXY retains native fetch. [src/lib/proxy-env.ts:89](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/proxy-env.ts#L89) selects the built-in SOCKS tunnel for SOCKS5 ALL_PROXY. The server configuration guide already describes that behavior.

### What should the documentation explain instead?

Distinguish HTTP(S) proxy handling from the SOCKS5 selection branch. Describe NO_PROXY exclusions, existing precedence and supported coding/protocol limits accurately.

### Suggested wording or example

“When configured outbound fetch selects an explicit SOCKS5 proxy or SOCKS5 ALL_PROXY and NO_PROXY does not exempt the target, HTTP/SSE uses OpenCodex’s built-in tunnel. Scheme-specific HTTP(S) proxy settings retain their separate documented behavior.” Verify surrounding precedence text against the actual resolver.

### Additional context or attachments

Pinned source: `7864869c31c41cca9830d93540238f17df8faafb`. Static documentation/source comparison only; no runtime test result is claimed.

Update all four English source pages: `docs-site/src/content/docs/reference/proxy-formats.md`, `docs-site/src/content/docs/reference/configuration/providers.md`, `docs-site/src/content/docs/reference/adapters.md:135`, and `docs-site/src/content/docs/guides/providers.md:975`, plus every translated copy of the contradicted statements; cross-link the correct server configuration section. No runtime change or new behavioral test is needed. Use a text consistency scan plus docs build/hosted checks during implementation. Related #2894 and merged #4986/#5070.

### Checks

- [x] I searched existing documentation issues.
- [x] No secrets or personal information are included.

Coordination: inspect open #3901 before implementation because it touches provider documentation and transport. Preserve its applicable changes and avoid a conflicting duplicate patch.
