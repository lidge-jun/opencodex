# 010 — What codex-rs actually does with a provider id

The parent design rests on one upstream claim: keeping
`[model_providers.opencodex]` on disk while removing the root routing keys
leaves native Codex working *and* leaves `opencodex`-tagged threads loadable.
That claim is checkable, and checking it also rules out the obvious
alternative orderings. Evidence below is from the Codex upstream corpus at
`/Users/jun/Developer/codex/_raw/repos/121_openai-codex/codex-rs`.

## Provider resolution is a whole-config concern, not a per-request one

`Config::load` builds the provider map and then resolves exactly one id:

```rust
let model_providers =
    merge_configured_model_providers(built_in_model_providers(openai_base_url), cfg.model_providers)
        .map_err(...)?;

let model_provider_id = model_provider
    .or(cfg.model_provider)
    .unwrap_or_else(|| "openai".to_string());
let model_provider = model_providers
    .get(&model_provider_id)
    .ok_or_else(|| {
        ...
        format!("Model provider \`{model_provider_id}\` not found")
        std::io::Error::new(std::io::ErrorKind::NotFound, message)
    })?
    .clone();
```

`core/src/config/mod.rs:3732-3749`

Three consequences follow directly, and they decide the whole contract.

**A missing provider id is fatal to config load, not to one request.** The
`?` propagates a `NotFound` out of `Config::load`. So removing the provider
table while root `model_provider = "opencodex"` survives does not degrade
anything — it breaks every single `codex` invocation with
`Model provider \`opencodex\` not found`, which is strictly worse than the
connection error #4812 reports. **The two removals can never be split in that
direction.** The degraded write must therefore be a single atomic
transformation, never a strip followed by a re-add.

**Root `openai_base_url` rewrites the built-in provider.**
`built_in_model_providers(openai_base_url)` constructs the `openai` provider
from that value (`model-provider-info/src/lib.rs:512-527`), so an injected
`openai_base_url` pointing at a dead proxy breaks native Codex even when no
OpenCodex provider table exists at all. Removing it is not optional; it is the
single most load-bearing part of the degraded restore.

**The default is `openai` when no root selector is present.** Dropping root
`model_provider` is sufficient to return the home to native operation. No
positive rewrite is needed.

## A resumed thread supplies its own provider override

```rust
typesafe_overrides.model_provider = Some(persisted_metadata.model_provider.clone());
```

`app-server/src/request_processors/thread_processor.rs:234`

That override is the `model_provider` argument in the resolution above, so a
thread row tagged `opencodex` needs a map entry named exactly `opencodex`.
With the table retained the resume succeeds and only that thread's requests
fail, against a dead port, with an ordinary connection error. With the table
removed the resume fails at config load.

This matches what `src/codex/inject.ts:490-495` already asserts on the apply
side — "Rows this home may have tagged `opencodex` resolve only through a
provider table" — and it is why the injector re-appends an existing table
before building its write witness (`src/codex/inject.ts:496-502`). The restore
direction is getting the same seam, for the same reason.

## `requires_openai_auth` is the auth source, visibly

```rust
fn should_show_login_screen(login_status: LoginStatus, requires_openai_auth: bool) -> bool {
    ...
    if !requires_openai_auth {
```

`tui/src/lib.rs:2070-2073`, reached from `tui/src/lib.rs:1214-1233`

The flag OpenCodex emits at `src/codex/inject/config-toml.ts:95` decides
whether Codex asks the user to sign in and whether it presents
`~/.codex/auth.json`. That is a user-visible identity change, which is why
#4809's requirement that the switch announce its auth-source consequence is a
correctness requirement rather than a cosmetic one.

## Bounds of this evidence

The corpus is a vendored snapshot, not the running binary on any particular
user's machine. What it establishes is the *shape* of resolution — override
beats root key beats `openai`, and a miss is fatal at load. The degraded
contract in `020` depends only on that shape, and it is conservative in the
one direction that matters: it never produces a config where a referenced
provider id is absent.
