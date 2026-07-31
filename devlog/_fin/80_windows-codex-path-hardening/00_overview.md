# 80 — Windows / Codex Path Hardening

## Context

Phase 80 records the remote hardening work pulled after Phase 70. The theme is not just "Windows support"; the real boundary is Codex path ownership:

- Codex local state must be resolved using Codex's own `CODEX_HOME` semantics.
- opencodex must write config/profile/catalog/cache files under that resolved Codex home.
- service managers must preserve the same environment that the interactive install used.
- Windows stop/service flows must verify real process state instead of assuming command success.

The full source/web investigation lives in `docs/codex-path-investigation.md`. This devlog records how that research mapped to implementation.

## Commit Set

| Commit | Area | Summary |
| --- | --- | --- |
| `8ca68d0` | config injection | Removed legacy `[profiles.opencodex]` injection path. |
| `060f51d` | Codex paths | Added shared Codex-home path resolver and Windows-safe catalog/config injection. |
| `ed35531` | services | Propagated Codex home handling into launchd/systemd/schtasks service definitions. |
| `726294f` | docs | Added primary Codex path investigation document. |
| `62edb7b` | docs + service | Hardened Windows service wrapper and updated user/docs-site wording. |
| `34a19a5` | process control | Fixed Windows proxy stop verification with actual process liveness checks. |
| `691731e` | release CI | Added GitHub Release creation with commit logs. |
| `be11239` | release CI | Made release dry-runs version-safe. |

## Primary Finding

The old implementation used `os.homedir()/.codex` as the place to edit Codex files. That only worked when Codex itself also used the default home. It breaks when:

- `CODEX_HOME` is set;
- Codex App/IDE/app-server launches with a different environment;
- opencodex runs as a service without the same shell environment;
- Windows Task Scheduler starts opencodex through a non-interactive path.

The corrected rule is:

```text
CODEX_HOME if set and non-empty:
  require existing directory
  canonicalize
else:
  use homedir()/.codex
```

Every Codex-side file then derives from that root:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

## User-Facing Result

After Phase 80, `ocx sync`, `ocx start`, and service mode should agree on the same Codex home and catalog path across macOS, Linux, and Windows. The fallback profile is now the modern file-based profile:

```text
$CODEX_HOME/opencodex.config.toml
```

not the deprecated inline table:

```toml
[profiles.opencodex]
```

## Out of Scope

- This phase does not change provider routing semantics.
- This phase does not add new OAuth providers.
- This phase does not solve already-running Codex processes that cached a previous catalog; it ensures new sync/start/service runs write the right files and invalidate the right cache.
