# Codex CLI Update Plan

`src/codex/cli-update-plan.ts` constructs the read-only update plan;
`src/codex/app-server-processes.ts` supplies its process observation.
Installation inspection follows the [runtime inspection contract](runtime.md#lifecycle),
and explicit Windows observation follows its [separate read-only contract](runtime.md#explicit-codex-cli-installation-observation).

Explicit Codex CLI installation observation does not discover a Codex home or read/write its state. See the [read-only observation contract](runtime.md#explicit-codex-cli-installation-observation).

The read-only CLI update plan binds npm executable selection to the inspected launcher PATH.
`bin/ocx.mjs` captures proxy variables (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY,
in any case) and NODE_EXTRA_CA_CERTS before Bun loads project dotenv. The proof-bound
snapshot preserves each key's spelling and value, including aliases and empty strings;
`src/cli/launcher-context.ts` validates and freezes that allowlisted transport map.
`src/cli/codex-cli-update.ts` forwards it with the inspected PATH/PATHEXT to the plan's
npm resolver. The resolver replaces all ambient aliases with the captured entries:
project dotenv cannot supply missing settings or change the captured precedence.
An older snapshot without a transport map conveys no transport settings, with no
ambient fallback. Snapshot values are internal inputs, never report or diagnostic fields.
Registry integrity requires a canonical base64 SHA-512 digest of exactly 64 bytes; malformed or truncated tokens refuse the target.
Plan identity also binds a bounded content observation (installContentDigest): a versioned file set
fixed by the supported npm-global layout — the package manifest, its declared bin/codex.js
entrypoint, and the platform backing manifest plus vendored binary at the layout's modeled
locations. The vendored binary is streamed in chunks under a finite 1 GiB bound sized for the
published backings (about 297 MB for linux-x64 at 0.163.0). The actually selected launcher stays bound through the existing canonical-path and
manifest-linkage provenance; the observation covers those files' bytes only and claims nothing about
which file a launcher run would execute, artifact authenticity, or the rest of the install tree. The
modeled locations follow Node's module lookup evaluated against the bound inspection environment
— the captured PATH/NODE_PATH/HOME and the node binary that PATH resolves — never the
inspecting process's own runtime globals. The backing is selected by the Node launcher's
`process.arch`, carried in the same snapshot, because a Bun override or PATH fallback may run a
different architecture under Rosetta; a snapshot without it falls back to the inspecting process's
arch, and an unknown value invalidates the context. The optional HOME/NODE_PATH seeds are withheld on
Windows, where the modeled lookup never runs, and dropped when they would push the serialized
launch context past its cap, so the selection snapshot survives: a local optional-package lane can
still bind, while the global and vendor-fallback lanes stay unmodelable and fail closed. Missing
required files, an out-of-prefix resolution, an unreadable or mid-observation-changed file, a
retargeted selection link, or an unmodelable global lookup all fail closed. The selector and lexical
links are checked after the final file-identity pass while native descriptors remain open; this
observes linkage at that boundary and does not prevent later symlink mutation. A managed install with
no bound content is refused install_content_unverified before any registry query. The digest is
observation only — it carries no execution guarantee — so a future apply phase must re-observe
rather than rely on it. The observation is opt-in: the plan path requests it because the planId
binds it, while a bare check leaves the digest null rather than paying the bounded read.
Selection observation uses the runtime resolver with provenance's bounded no-follow, nonblocking state reader and local executable-path policy. Windows returns before invoking the resolver; its deferred inspection performs no candidate or configuration I/O.
Its child environment drops npm configuration overrides, named Node startup/output controls,
the `LD_*`/`DYLD_*` loader families and the OpenSSL startup configuration and
provider/engine search variables; proxy settings and `NODE_EXTRA_CA_CERTS` remain supported.
Ambient NODE_COMPILE_CACHE is replaced with an owned path inside the isolation directory because
npm's own enableCompileCache() otherwise recreates a default cache outside that directory.
Distinct npm config files, npm/Node caches and logs stay under the owned temporary root with best-effort
cleanup; a cleanup error does not replace the computed plan/refusal. The POSIX update
scan includes all readable users by default, retaining an explicitly injected UID scope.
Linux per-process `status`/`cmdline` read failures invalidate a complete observation except for `ENOENT`
(a process that disappeared); incomplete observation refuses with `blocked_process_state_unknown`;
the restart/kill path skips unreadable entries while retaining independently verified same-user app-server targets. This plan neither installs a runtime nor signals
an existing Codex session. Windows enumeration/installation limits remain unchanged.
