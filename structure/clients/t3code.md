# T3 Code Client Integration

T3 Code follows the shared [client-integration ownership contract](integrations.md); this page records only what is specific to it.

## T3 Code settings ownership

T3 Code (`pingdotgg/t3code`) keeps server settings in JSON at `userdata/settings.json` under
`T3CODE_HOME`, default `~/.t3`. `t3codeHomeDir` in `src/clients/config-export/t3code.ts` resolves
that directory once for export, writing and detection. POSIX overrides use `absoluteClientPath`;
Windows overrides must have a fully qualified drive or UNC root after tilde expansion against
the effective home. Drive-relative and drive-less rooted paths refuse with `ClientPathError`,
because the proxy and T3 Code can run on different drives. Detection reads `<base>/userdata`,
which the T3 Code server creates on its first start.

The managed contribution is one fragment, `providerInstances.opencodex`: a T3 Code provider
instance with `driver: "claudeAgent"`. Its `environment` carries the proxy origin as
`ANTHROPIC_BASE_URL` (no `/v1`; Claude Code appends `/v1/messages`), the non-secret
`PROXY_MARKER` from `src/claude/auth-detect.ts` as `ANTHROPIC_AUTH_TOKEN`, an empty
`ANTHROPIC_API_KEY`, and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`. That is the proxy-mode
`ocx claude` environment on a loopback bind. Every variable is written `sensitive: false`,
because T3 Code moves sensitive values into its secret store and blanks them in the file. None of
these values is a credential. `config.customModels` holds one `{ slug, name }` entry per
normalized export model, Fast rows included. The slug is the proxy selector, which T3 Code passes
verbatim as the Claude model id and the Messages surface resolves like any other selector.

No Codex block is written. T3 Code lists Codex models through `codex app-server`, which reads the
routed catalog the Codex integration injects into `CODEX_HOME`, so Codex threads route only while
that integration is enabled and T3 Code runs Codex with the same home.

Every Claude turn the instance sends hits the Messages surface. `t3codeApplyRefusal`, the spec's
`validateApply`, refuses apply and refresh while `resolveApiSurfaceSettings` reports that surface
closed, whether by an explicit `apiSurfaces.messages.enabled` or the inherited
`claudeCode.enabled`. Disable and Undo stay available.

The fragment declares no refreshable paths. T3 Code rewrites an instance whenever a user edits it
in its settings UI, by marking a variable sensitive, adding a custom model or toggling the
instance. Each of those classifies as a foreign edit and refuses refresh and disable until the
operator replaces or restores the block. Exports reject a listener that needs an admission header,
because T3 Code would send only the marker. The writer's admission gate protects apply while still
permitting cleanup after a bind change. `ocx export --client t3code` asks the live
`/api/client-config` route, like Qoder, Raycast and Factory Droid. Owned-catalog refresh in
`ocx sync`, `/api/sync` and catalog refresh includes T3 Code. The managed path template lives in
`src/integrations/mutation-plan.ts`, and `tests/clients/t3code-client.test.ts` covers the
contract. `tests/clients/t3code-client-lifecycle.test.ts` also covers relocated-home
detection, apply and Undo, cross-platform Windows drive/UNC and tilde admission,
shared `ClientPathError` refusal, owned cleanup after
the bind changes to require admission, and the Messages-surface refusal.
