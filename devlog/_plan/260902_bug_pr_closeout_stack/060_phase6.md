# 060 — Phase 6: #3158 T19/T21 documentation debt

Two of the four remote-hub follow-ups are documentation-only and close in one diff.
T2 and T3 are behaviour gaps and stay open on #3158.

## T19 — /readyz gained protocol negotiation metadata

`src/server/index.ts:1170-1178` builds the readiness body as:

    const body = {
      service: "opencodex", version: VERSION, uptime: process.uptime(),
      pid: process.pid, port: boundPort ?? listenPort, status,
      ...readyProtocolMetadata(config, req),
    };

`src/remote/protocol.ts:46-57` adds `protocol`, `minimumClientProtocol`, and `managementUrl`
— the configured `hub.managementPublicOrigin` when `runtimeRole === "hub"`, otherwise the
observed request origin.

`docs-site/src/content/docs/reference/cli/lifecycle.md:164` still says the sanitized HTTP
identity is `{service, version, uptime, pid, port, status}`.

**MODIFY `docs-site/src/content/docs/reference/cli/lifecycle.md`** — extend that sentence to
name the three added fields, say where `managementUrl` comes from in each runtime role, and
keep the CLI JSON shape `{ready, status, pid, port}` explicitly distinct from the HTTP body.

## T21 — three config keys ship undocumented

`src/types/config.ts:259,272,284` declare `hub.managementPublicOrigin`,
`remoteGui.allowedTailscaleUsers`, and `remoteGui.allowInsecureHttp`.

`docs-site/src/content/docs/reference/configuration/server.md:268` mentions the first two in
one prose sentence about `runtimeRole`; `allowInsecureHttp` appears nowhere. The
`guides/remote-hub.md` page shows `ocx config set` examples, but the reference page is the
source of truth for key semantics.

**MODIFY `docs-site/src/content/docs/reference/configuration/server.md`** — document each key
with type, default when absent, what it gates, and the failure mode of setting it wrong.
`allowInsecureHttp` in particular is a security-relevant opt-out and needs the warning.

## Locales

English is the source. Per AGENTS.md, translated locales must not contradict the English
source; the tr/ja/fr/ru/zh-cn pages already carry the `runtimeRole` sentence, so leave them
rather than half-translating. Note the gap in the PR body.

## Verification (C)

- `rg` proof that each key name now appears in the reference page.
- the docs build is a CI job (`gates`), judged with the rest of the train.

