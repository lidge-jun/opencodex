# GitHub Copilot Client Integration

GitHub Copilot follows the shared [client-integration ownership contract](integrations.md); this page records only what is specific to it.

## GitHub Copilot settings ownership

The GitHub Copilot CLI (`github/copilot-cli`) reads custom providers from JSON at
`providers.json` under `COPILOT_HOME`, default `~/.copilot`. `COPILOT_PROVIDERS_CONFIG` names the
file outright and wins over the directory. `githubCopilotConfigPath` in
`src/clients/config-export/github-copilot.ts` resolves that file once for export and writing, and
`githubCopilotHomeDir` resolves the directory detection reads. Both overrides go through
`absoluteClientPath`, so a relative value refuses with `ClientPathError`: the proxy and the CLI
can run from different working directories. Detection reads the directory itself, which the CLI
creates on its first run.

The managed contribution is two fragments. `providers[name=opencodex]` is one provider with
`type: "openai"`, the proxy's `/v1` root as `baseUrl`, and the non-secret
`LOOPBACK_API_KEY_PLACEHOLDER` from `src/clients/config-export/constants.ts` as `apiKey`. Copilot's
`openai` type covers OpenAI-compatible endpoints and defaults to Chat Completions, so the CLI
appends `/chat/completions` itself. `models[id=<slug>]` holds one row per normalized export model,
Fast rows included. `id` is the bare model slug the CLI shows in its picker, and `wireModel` is
the proxy selector the CLI sends as the model name. `maxPromptTokens` is set only from an
authoritative context window; an unknown model makes the CLI assume 128,000, and a guessed number
would not enlarge the window.

Copilot stores `apiKey` as plain text and treats a `$ENV` string literally, so there is no safe
place for a real credential. Exports reject a listener that needs an admission header, and the
writer's admission gate refuses apply while still permitting cleanup after a bind change.
`githubCopilotApplyRefusal`, the spec's `validateApply`, refuses apply and refresh when the
catalog is empty or a model id carries `]` or `=`, because such an id has no array selector the
ownership record can spell and disable would not find the row again. Disable and Undo stay
available.

The user's other providers and model rows are sibling array elements and survive every write. The
fragments declare no refreshable paths, so an edit to the owned provider or a model row classifies
as a foreign edit and refuses refresh and disable until the operator replaces or restores the
block. `ocx export --client github-copilot` asks the live `/api/client-config` route, like Qoder,
Raycast and Factory Droid. Owned-catalog refresh in `ocx sync`, `/api/sync` and catalog refresh
includes GitHub Copilot. The managed path templates live in `src/integrations/mutation-plan.ts`,
and `tests/clients/github-copilot-client.test.ts` covers the contract: the generated document,
relocated-home detection, apply and Undo, shared `ClientPathError` refusal, owned cleanup after
the bind changes to require admission, and the unaddressable-id refusal.
