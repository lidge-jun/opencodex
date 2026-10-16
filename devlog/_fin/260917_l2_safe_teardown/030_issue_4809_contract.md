# 030 — Stored, effective, and pending for the two Desktop switches

Issue #4809. Child PR, branch `codex/settings-apply-and-effective-state`,
based on the parent's head branch.

## The defect

`PUT /api/settings` persists `codexDesktopAuthless` and
`codexClientCompaction` and then converges the **catalog**:

```ts
// Both Desktop compatibility switches change the injected config.toml shape, so converge now
// rather than waiting for the next start; the injector re-reads config and rewrites the form.
... ? await convergeCodexCatalog() : undefined;
```

`src/server/management/config-routes.ts:600-607`

The comment is false. `convergeCodexCatalog` rejects any request whose
`scope !== "catalog"` (`src/codex/convergence.ts:668`,
`src/codex/management-convergence.ts:139`) and never calls
`injectCodexConfig`. The injector is reached only from `syncModelsToCodex`
(`src/codex/sync.ts:207,273`), `ocx init`, and the connect paths. So
`~/.codex/config.toml` keeps its old shape until a separate `ocx sync`.

The CLI compounds it by discarding the response body entirely and printing a
fixed string (`src/cli/system-command.ts:59-65`):

```text
System settings updated.
```

And there is a second, quieter failure. On a non-loopback bind without
`unauthenticatedLoopbackListener`, `standaloneCodexRoutingTarget` drops the
flag (`src/codex/inject/routing-target.ts:63`), yet both GET and PUT report
the configured `true` (`config-routes.ts:328,623`). The user reads back the
value they set and gets the behaviour they did not.

## Contract

### Three fields, not one

For each of the two switches the settings response reports:

| Field | Meaning |
|---|---|
| `stored` | what is persisted in `config.json` |
| `effective` | what the injector would actually apply on this bind and role |
| `applied` | whether `~/.codex/config.toml` now reflects it |

`effective` uses the predicate Report C extracted from
`src/codex/loopback-target.ts:92`:

```ts
codexDesktopAuthless === true
  && runtimeRole !== "client"
  && !shouldInjectApiAuthHeader(config)
```

When `stored !== effective`, the response carries the reason —
`non_loopback_bind_requires_admission_token` or `client_role` — and the CLI
prints it. A switch that is stored on and effectively off is the exact case
the issue calls a configuration lie, and it stops being one when the response
says so.

### Apply inline

When the integration is enabled and the proxy is live, the route runs the real
injection after persisting, and reports the result. Report C establishes this
is callable: `injectCodexConfig(port, config?, options?)` is async
(`src/codex/inject.ts:111,182`) and the handler is already async and already
dynamically imports the sync path for `/api/sync`
(`config-routes.ts:637`).

Two ordering constraints are hard:

- The save's config-mutation transaction (`C`) must be **closed** before
  injection starts. Coordinated homes take `N -> C`
  (`src/codex/codex-write-lock.ts:18,335`), so calling the injector from
  inside `C` inverts the order.
- Config is re-read from disk for the injection rather than reusing the
  server's startup object, matching what `/api/sync` already does.

Failure modes are reported, never flattened into success:

| Injector outcome | Response |
|---|---|
| write lock busy (`inject-coordination.ts:464`) | `applied: false`, `retryable: true`, "run `ocx sync`" |
| desired state off / hub-gated (`inject.ts:688`) | `applied: false`, reason `integration_disabled` |
| non-paginated history refusal (`inject.ts:442`) | `applied: false` with the reason string |
| external provider owns the home (`inject.ts:264`) | `applied: false`, reason preserved |
| proxy not live | `applied: false`, reason `proxy_not_running` |

`history_paginated_requires_native_writer` is **not** a failure here: apply
already stands the relabel down and writes the config half
(`inject.ts:472-484`). A paginated home applies normally, which is what makes
this child coherent with the parent.

`catalogRefreshPending` (`src/codex/catalog-refresh-status.ts:102`,
`config-routes.ts:609`) is the existing precedent for a
"this is not finished yet" field, and the new fields follow its shape rather
than inventing a second vocabulary.

### State the auth-source consequence

Flipping `codexDesktopAuthless` moves `requires_openai_auth` in the injected
table (`src/codex/inject/config-toml.ts:95`). `010` shows upstream reads that
flag to decide whether to show the login screen at all
(`tui/src/lib.rs:2070-2073`). Both the API response and the CLI state, at the
moment of the change, whether the Codex app will now present
`~/.codex/auth.json`. This is an identity-surface change and the user is told
while they are making it.

### CLI output

`ocx system settings` stops printing a fixed string. It prints the stored
value, the effective value when it differs and why, whether the injected
config was rewritten, and the auth-source consequence. `--json` passes the
response through, as it already does (`src/cli/runtime-api.ts:348`).

### Correct the comment

`config-routes.ts:600-601` is rewritten to describe what the code does. A
comment asserting the opposite of the behaviour is how the next maintainer
inherits this bug.

## Scope boundaries

- No change to what the switches *mean*. The injected shapes stay exactly as
  `src/codex/inject.ts:335-365` produces them.
- No new setting, no schema migration, no GUI redesign. The GUI reads the same
  response and is free to show the new fields later.
- `codexClientCompaction` gets the same three-field treatment. It has no
  inert case of its own — Report C shows it is dropped only on
  admission-required targets (`routing-target.ts:53`) — so its `effective`
  differs from `stored` under that one condition and is reported the same way.
