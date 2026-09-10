# 003 — config.toml: layering, write safety, and when an edit applies

Researcher: Parfit (read-only). Upstream HEAD `2b5bdcf67`.

## 1. Load order

Lowest to highest precedence (`config/src/loader/mod.rs:96-109`, assembled at
`:225-413`, folded lowest-first at `state.rs:488-500`):

1. System `/etc/codex/config.toml`
2. Cloud enterprise fragments
3. **User `${CODEX_HOME}/config.toml`** ← what we write
4. Profile-v2 `${CODEX_HOME}/<name>.config.toml`
5. Project-local trusted configs (cwd, ancestor, repo `.codex/config.toml`)
6. Runtime/session flags including CLI `-c`
7. Thread-provided layers
8. Legacy `managed_config.toml` / MDM

Defaults are not a physical layer. Absent values deserialize to `None` and
runtime defaults apply afterwards (`config/mod.rs:3836-3845`).

## 2. Profiles — do not write `[profiles.x]`

Two systems exist and only one works:

- **Profile-v2 (current):** `--profile work` loads `${CODEX_HOME}/work.config.toml`
  as a full overlay (`loader/mod.rs:245-293`). Keys go at that file's **root**.
- **Legacy `[profiles.<name>]`:** still in the schema (`config_toml.rs:308-313`),
  but selecting it via root `profile = "name"` is now a **hard error**
  directing the user to `<name>.config.toml` (`config/mod.rs:3260-3266`).

So the five toggles are schema-valid inside `[profiles.x]` and simultaneously
unreachable there. WP1 writes root keys of the user config and nothing else.

## 3. When an edit takes effect

`config_lock.rs:142-146` copies the four `include_*` flags into a lock config.
That is **not** a per-session freeze of live config.toml. It materializes
resolved values into an optional exported/replayed lock file, and only when
`config_lock_export_dir` is set (`config_lock.rs:48-71`); replay happens only
under a debug `load_path` (`config/mod.rs:1461-1495`).

The real timing: config is read while constructing `Config`, copied into
`SessionConfiguration` at session creation (`session/mod.rs:634-713`), and new
turns clone from that rather than re-reading the file
(`turn_context.rs:600-637`, `:475-482`).

Therefore:

- An edit does **not** affect the next turn of a running thread.
- It applies when a new session is built from a freshly loaded `Config`.
- A full process restart is **not** proven necessary.

UNKNOWN: whether each frontend reloads config before every new thread. Settling
it needs a trace of the app-server thread-start path.

**Mandated UI copy:** "새 세션부터 적용됩니다. 실행 중인 세션은 현재 설정을
유지합니다." Never "즉시 적용" and never "재시작 필요".

## 4. Write safety

Codex rewrites config.toml itself — `codex features enable/disable`
(`cli/src/main.rs:1909-1928`), migration-notice setters (`config/edit.rs:813-829`),
MCP settings. The writer reads the text, parses `toml_edit::DocumentMut`,
applies path-scoped AST edits, serializes, and atomically replaces
(`config/edit.rs:730-769`).

Comments and unrelated formatting survive; a regression test proves two nested
edits leave everything else byte-identical (`config/edit_tests.rs:600-655`).

Consequences for us:

- Our marker comments should survive Codex's own edits.
- If Codex edits the same key, **its value wins.** Same-path keys are shared
  ownership, not ours.
- Malformed TOML blocks `DocumentMut` parsing, so Codex fails before writing
  (`config/edit.rs:745-749`). Our writer must never emit malformed output.

## 5. Unknown and malformed keys

`ConfigToml` carries `#[schemars(deny_unknown_fields)]` but **not** serde's
`deny_unknown_fields` (`config_toml.rs:147-150`). So:

- Normal mode: a valid-but-unknown root key is **silently ignored**.
- `--strict-config`: unknown keys are a **hard load error**
  (`loader/layer_io.rs:104-168`, `config_loader_tests.rs:363-385`).
- Malformed TOML: always `InvalidData`, strict or not.

A typo like `include_app_instructions = false` therefore does nothing in normal
mode and bricks startup in strict mode. WP1 validates key names against a fixed
allowlist before writing — the GUI can never emit a key it did not intend.

## 6. Managed layers can defeat our write

Cloud enterprise fragments sit *below* user config, so our write wins over them
(`cloud_config_layers_tests.rs:82-145`). Cloud *requirements* cannot lock these
keys — `ConfigRequirements` has no `include_*` fields
(`config_requirements.rs:1-28`).

But legacy `managed_config.toml` / MDM is appended **after** runtime layers
(`loader/mod.rs:369-413`), so a managed value silently overrides ours.

**This is why WP1 reports `defaultedUserValue`, not `effective`.** An earlier
draft of this document told WP2 to return an effective value and render an
override notice. opencodex reads exactly one of the eight layers above, so it
cannot compute the effective value, and an audit correctly rejected the
instruction as an overclaim.

Resolved-configuration reporting is **deferred**, not approximated: promising
override detection without a read path would relocate the false claim rather
than remove it. `010` and `005` carry the same rule; this section no longer
contradicts them.

## 7. Canonical target file

```toml
# ~/.codex/config.toml — root level
include_permissions_instructions = false
include_apps_instructions = false
include_collaboration_mode_instructions = false
include_environment_context = false

[skills]
include_instructions = false
```

Verified against `config.schema.json:5411-5426` and `skills_config.rs:30`.

## Risks carried into implementation

| Risk | Mitigation | Phase |
|---|---|---|
| Typo'd key silently no-ops or bricks strict mode | fixed allowlist, no free-form keys | WP1 |
| Managed layer overrides our write | **deferred** — we report this file's value under a name that says so | WP1/WP2 |
| Codex overwrites our value | same-path keys are shared; never assume ownership | WP1 |
| User expects instant effect | "new sessions" copy, enforced by test | WP3 |
| Upstream renames a key | absent key = unknown, not false | WP1 |
