# Codex App / codex-rs findings

## Summary

The sidebar disappearance is caused by two independent filters in Codex App / app-server:

1. Provider filter: when `model_providers` is omitted, app-server defaults to the active configured provider.
2. Source filter: when `source_kinds` is omitted or empty, app-server defaults to `INTERACTIVE_SESSION_SOURCES`.

In the local codex-rs checkout at `/Users/jun/Developer/codex/codex-cli/codex-rs`, `INTERACTIVE_SESSION_SOURCES` is:

```text
cli
vscode
custom atlas
custom chatgpt
```

It does not include `exec`.

## Source anchors

codex-rs source anchors:

- `/Users/jun/Developer/codex/codex-cli/codex-rs/rollout/src/lib.rs`
  - `INTERACTIVE_SESSION_SOURCES` includes `Cli`, `VSCode`, `Custom("atlas")`, `Custom("chatgpt")`.
- `/Users/jun/Developer/codex/codex-cli/codex-rs/app-server/src/filters.rs`
  - `compute_source_filters(None)` returns `INTERACTIVE_SESSION_SOURCES`.
  - `compute_source_filters(Some(Vec::new()))` also returns `INTERACTIVE_SESSION_SOURCES`.
  - `ThreadSourceKind::Exec` requires an explicit source filter.
- `/Users/jun/Developer/codex/codex-cli/codex-rs/app-server/src/request_processors/thread_processor.rs`
  - `model_providers: None` becomes `Some(vec![self.config.model_provider_id.clone()])`.
  - `source_kinds` flows through `compute_source_filters()`.
  - Those filters are passed to `thread_store.list_threads()`.
- `/Users/jun/Developer/codex/codex-cli/codex-rs/state/src/runtime/threads.rs`
  - SQL filter applies `threads.archived = 0`, `threads.preview <> ''`, optional `threads.source IN (...)`, optional `threads.model_provider IN (...)`, and optional `threads.cwd IN (...)`.

## Local DB evidence

Read-only query against `/Users/jun/.codex/state_5.sqlite` for project cwd `/Users/jun/Developer/new/700_projects/opencodex`:

| model_provider | source | count |
| --- | --- | ---: |
| `openai` | `cli` | 7 |
| `openai` | `exec` | 2 |
| `opencodex` | `exec` | 43 |
| `opencodex` | subagent thread-spawn JSON | 2 |

Default Codex App list while opencodex is active:

```sql
WHERE archived = 0
  AND preview <> ''
  AND source IN ('cli', 'vscode', 'atlas', 'chatgpt')
  AND model_provider = 'opencodex'
```

That returns zero rows locally because opencodex-created project rows are `source = 'exec'`.

## Upstream patch direction

The cleaner upstream fix would be in Codex App / codex-rs:

- either request `sourceKinds` including `exec` for the project sidebar,
- or make the project sidebar intentionally provider/source agnostic when the user is browsing project history,
- or expose a UI affordance for source filtering.

opencodex cannot change Codex App's `thread/list` request payload. The opencodex-side fix therefore must be an explicit compatibility mode that temporarily adjusts local metadata and restores it later.

## opencodex fix direction

For `syncResumeHistory: true`:

- backup original thread metadata into `~/.opencodex/codex-history-backup.json`;
- remap old OpenAI `cli`/`vscode` rows to `model_provider = 'opencodex'`;
- promote opencodex-created user `exec` rows to `source = 'cli'`;
- update the rollout JSONL first `session_meta` line consistently so Codex's rollout scanner does not repair the DB back to the hidden state;
- on `ocx stop` / `ocx restore`, restore only rows recorded in the backup manifest.

Default remains unchanged: no history mutation unless the user explicitly enables `syncResumeHistory`.

## Legacy PR #13 upgrade edge

There is one unsafe-to-automate edge case:

1. A user enabled `syncResumeHistory: true` on a development build before backup support existed.
2. That build remapped old `openai` interactive rows to `opencodex`.
3. The user upgrades while those rows are still remapped.
4. The new backup manifest does not exist, so `ocx stop` cannot know which `opencodex` interactive rows were originally OpenAI rows.

The fix must not silently rewrite all `opencodex` `cli`/`vscode` rows to `openai`, because future or app-created rows can legitimately be opencodex-owned. Instead:

- normal `ocx stop` detects and reports ambiguous unbacked rows;
- it leaves them unchanged by default;
- `ocx recover-history --legacy-openai` is the explicit manual recovery path for users who know those rows came from the old remap.

## 2026-06-22 correction: native restore cannot leave opencodex providers behind

Live local testing showed that the conservative "leave unbacked opencodex rows unchanged" approach
breaks Codex App after `ocx stop`:

```text
Codex can't load config.toml, so this thread can't resume.
Fix config.toml: Model provider `opencodex` not found.
```

The root cause is straightforward: `ocx stop` removes `[model_providers.opencodex]` from
`~/.codex/config.toml`. Any remaining `threads.model_provider = 'opencodex'` row can therefore point
Codex App at a provider id that no longer exists. This applies not only to legacy `cli`/`vscode` rows,
but also to opencodex-created `exec` rows and subagent rows if the user resumes them directly.

Revised opencodex invariant:

- while opencodex is active, `syncResumeHistory: true` may remap/promote history so the App sidebar is visible;
- after native restore (`ocx stop`, `ocx restore`, uninstall), no user thread should be left with
  `model_provider = 'opencodex'` unless the Codex config still contains that provider;
- backed-up OpenAI rows restore to OpenAI;
- opencodex-owned user rows are ejected to `openai`, and `exec` source is promoted to `cli`, so native
  Codex can list/resume them after the proxy provider has been removed;
- root `model = "provider/model"` values are also stripped on native restore because provider-prefixed
  routed model ids are invalid without the opencodex provider/catalog.

Local repair evidence after the correction:

- `ocx recover-history --legacy-openai` recovered 218 user thread rows to `openai`;
- `ocx stop` left zero user rows with `model_provider = 'opencodex'`;
- `~/.codex/config.toml` no longer contains `[model_providers.opencodex]`, root
  `model_provider = "opencodex"`, or root `model = "provider/model"`.
