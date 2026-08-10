# 003 — API-side toggle: design options, trust boundary, risk register

Research only. This document maps the design space; it does not commit to an
implementation. If an option is approved, the next cycle writes decade docs
(010+) at diff level.

## 1. What exists today

- `GET /api/client-config?client=opencode|pi`
  ([model-routes.ts:236](/Users/jun/Developer/new/700_projects/opencodex/src/server/management/model-routes.ts:236))
  builds the client document from the same core the CLI uses and **never
  writes** — "targeting it is the caller's explicit act"
  ([config-export.ts:19](/Users/jun/Developer/new/700_projects/opencodex/src/clients/config-export.ts:19)).
- Mutating precedents on the same router (`PUT /api/disabled-models`,
  `PUT /api/model-visibility`) persist only opencodex's *own* config, never
  third-party files.
- The GUI renders per-client rows from its own hand-synced list
  ([client-config-clients.ts:5](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/apikeys-workspace/client-config-clients.ts:5)) —
  copy/download only, no apply button.

A management-API toggle for the four new clients is therefore **not**
unprecedented in kind: two routes already mutate third-party files, and they
are the primary endpoint-level precedents for a toggle:

- `POST /api/grok/apply`
  ([agent-settings-routes.ts:593](/Users/jun/Developer/new/700_projects/opencodex/src/server/management/agent-settings-routes.ts:593)) —
  accepts **no body** (every input comes from persisted state, guards stay in
  `injectGrokConfig` and are not duplicated at the route); single-flight with
  `GrokApplyBusyError` -> 409; a policy skip (non-loopback, no `~/.grok`) is
  reported as a result (`skippedReason`), not a 500.
- `POST /api/claude-desktop/apply`
  ([agent-settings-routes.ts:651](/Users/jun/Developer/new/700_projects/opencodex/src/server/management/agent-settings-routes.ts:651)) —
  validates its optional body (`mode` enum, profile override parse), persists
  `appliedFingerprint` + `appliedAt` into opencodex config after a successful
  write, and reports partial failure as `{ saved: true, path }` + 500 when the
  third-party write fails after the profile was saved.
- `GET /api/claude-desktop/status`
  ([agent-settings-routes.ts:706](/Users/jun/Developer/new/700_projects/opencodex/src/server/management/agent-settings-routes.ts:706)) —
  recomputes the on-disk fingerprint (sha256, truncated) and returns
  `stale = savedFingerprint !== onDiskFingerprint`, plus a tri-state
  `activeProfile` (`null` = undeterminable; a readable `appliedId` with no
  opencodex entry is a *known* false).

## 2. Trust boundary (do not conflate the two planes)

| Plane | Guard | Relevance |
|-------|-------|-----------|
| Management (`/api/*`) — where the toggle endpoint lives | `requireManagementAuth`, origin-bound loopback sessions, CSRF on mutations ([management-auth.ts:207](/Users/jun/Developer/new/700_projects/opencodex/src/server/management-auth.ts:207), [index.ts:448](/Users/jun/Developer/new/700_projects/opencodex/src/server/index.ts:448)) | The toggle inherits this; no new auth design needed, but a toggle **write** must require the same CSRF path as `PUT /api/disabled-models`. |
| Data (`/v1/*`) — what the client calls after toggling | `resolveApiAuth`; loopback binds skip admission entirely ([auth-cors.ts:327](/Users/jun/Developer/new/700_projects/opencodex/src/server/auth-cors.ts:327)) | Decides what credential the *written config* must carry: placeholder on loopback, real key reference otherwise. |

## 3. State model: read-back, not a database

cc-switch keeps its own SQLite and a `live_config_managed` marker (001 §1, §5).
opencodex has no such DB and adding one for this is questionable scope. The
honest alternative: **derive state from the client file itself**, which forces
richer states than a boolean:

| State | Meaning | Toggle action offered |
|-------|---------|----------------------|
| `absent` | no opencodex entry in the client config | enable |
| `current` | our entry exists and matches what we would generate now | disable |
| `stale` | our entry is untouched (hash match) but no longer equals what we would generate now (catalog/port drift) | refresh (rewrite), disable |
| `conflict` | the file changed after we wrote it (hash mismatch), or an entry with our provider id exists with no ownership proof | refuse; show diff, require explicit takeover |
| `unsafe` | file unparseable, ownership markers damaged, or path not a regular file | refuse; surface the reason |

"Did we write it?" needs an ownership proof. Local precedents offer three
working patterns:

- **Managed fence** — `src/grok/inject.ts` writes a BEGIN/END marker region in
  `~/.grok/config.toml`, refuses or strips on an orphaned marker
  (`skippedReason: "orphaned-marker"`), and `src/grok/status.ts` is the paired
  read-only reader that parses only our own fence. Works for formats with
  comments (TOML/YAML/JSON5); not for strict JSON.
- **Provenance sidecar** — `src/claude/desktop-3p.ts` writes a metadata
  sidecar (`appliedId`, `entries`) next to the mutated file, refreshes a
  single `.bak` on **every** replacement (overwrite, not one-time —
  [desktop-3p.ts:371](/Users/jun/Developer/new/700_projects/opencodex/src/claude/desktop-3p.ts:371)),
  and rolls back if the metadata write fails
  ([desktop-3p.ts:356-380](/Users/jun/Developer/new/700_projects/opencodex/src/claude/desktop-3p.ts:356)).
  Works for any format, including strict JSON and strict-schema YAML (Gajae).
- **Persisted content fingerprint** — the Claude Desktop route pair stores
  the last-written content hash (`appliedFingerprint`) in opencodex's own
  config and the status route compares it against the on-disk hash to compute
  `stale`
  ([agent-settings-routes.ts:706](/Users/jun/Developer/new/700_projects/opencodex/src/server/management/agent-settings-routes.ts:706)).
  This is the piece that actually distinguishes "we wrote it and it is
  unchanged" from "someone edited it after us" — a sidecar alone only proves
  what we *intended* to write.

The ownership record for a toggle is therefore: **managed provider identity +
canonical last-written content hash (persisted opencodex-side) + the fence or
sidecar that scopes what we own in the file.** The classification is a
two-axis derivation from it — the persisted hash proves *the file was not
touched after us*, and a fresh regeneration proves *our content is still what
we would write today*:

1. on-disk hash != last-written hash -> `conflict` (someone modified the file
   after us; disable must refuse, per caveat 2 below).
2. hashes match AND managed content equals a fresh regeneration -> `current`.
3. hashes match BUT managed content differs from a fresh regeneration
   (catalog/port drift) -> `stale` (offer refresh/disable).
4. our provider id present with no ownership record at all -> `conflict`.
5. markers damaged or file unparseable -> `unsafe`.

Disable may proceed only from `current`/`stale` — i.e. only while the on-disk
hash still equals the last-written hash — followed by the pre-commit recheck
of caveat 1. This deliberately sharpens the Claude Desktop status route's
looser naming, where `stale = savedFingerprint !== onDiskFingerprint`
conflates foreign edits with drift; a toggle that can *delete* needs the two
split apart.

All of this rides on `atomicWriteFile` ([config.ts:54-167](/Users/jun/Developer/new/700_projects/opencodex/src/config.ts:54)):
temp+rename, Windows EBUSY/EPERM/EACCES retry with backoff, 0o600 mode, ACL
hardening, residual-temp scrubbing. Two caveats a toggle must add on top:

1. **Atomic rename is not compare-and-swap.** An additive read-modify-write
   can still lose a concurrent user/client edit that lands between our read
   and our rename. The toggle must re-read the file and verify the pre-write
   fingerprint immediately before committing; a mismatch aborts with the
   `conflict` state rather than overwriting. The `/api/grok/apply`
   single-flight pattern (busy -> 409) covers concurrency *within* the
   serving process; the pre-commit fingerprint check covers everything else
   best-effort. Residual cross-process races inside the re-read/rename window
   are accepted and documented, not claimed away.
2. **Disable after user modification.** If the persisted hash no longer
   matches on-disk content, the entry has been touched by someone else;
   disable must not silently delete it. That is the `conflict` path: show the
   drift, require explicit takeover/removal.

## 4. The `ocx opencode` precedence trap

`ocx opencode` injects `provider.opencodex` through `OPENCODE_CONFIG_CONTENT`,
which **outranks the disk config** for that process
([opencode.ts:8](/Users/jun/Developer/new/700_projects/opencodex/src/cli/opencode.ts:8)).
Consequences:

- For OpenCode, "enabled on disk" and "enabled at runtime" are different
  truths. Read-back must say which one it reports.
- A defensible scope cut: the disk toggle targets the four *new* clients and
  Pi (file-only consumers); OpenCode's disk toggle is either documented as
  "direct launches only" or excluded in v1. The launcher remains the
  recommended OpenCode path.

## 5. Design options

### Option A — opencodex-owned file writer (cc-switch additive pattern)

`PUT /api/client-integrations/:client { enabled: boolean }` (plus a GET for
the five-state read-back). Enable: parse the client file, additive-merge our
provider entry (ownership sidecar or fence), atomic write with the §3
ownership/backup contract (persisted content fingerprint, compare-before-commit,
`.bak` refreshed on every replacement). Disable: remove exactly our entry,
restore nothing else — and only while the fingerprint still matches (§3).

- Pros: works for all four clients; no dependency on their CLIs; one code
  path per format (YAML ×2, JSON5, TOML).
- Cons: opencodex assumes format-fidelity risk (comments, key order);
  Gajae's strict schema rejects unknown fields (002 §Gajae); Kimi's own
  tooling rewrites the whole document, so coexisting with `kimi provider`
  edits is fine byte-wise but our writer must round-trip unknown sections as
  values; needs new serializer dependencies (YAML, JSON5, TOML) in a repo
  whose export core is currently JSON-only.

### Option B — vendor-CLI-driven toggle

Enable/disable shells out to the client's own non-interactive surface
(002 matrix): `openclaw config set --merge` / plain `config unset`; `kimi provider add
<registry-url>` / `remove` — with opencodex **serving an `api.json` registry
endpoint** so add/remove is fully vendor-owned; `gjc setup provider ...` for
add. Hermes has no CRUD surface (its dashboard API is auth-gated and has no
verified provider endpoint), so Hermes drops to Option A regardless.

- Pros: vendor owns schema knowledge, atomicity, comment loss (Kimi already
  rewrites the whole file itself), and cascade cleanup (Kimi removal deletes
  referencing aliases + `default_model`; OpenClaw's plain path unset removes
  exactly our provider key).
  The Kimi registry variant has a second payoff: model-catalog refreshes
  propagate on the client's next startup instead of going `stale`.
- Cons: requires the client binary on PATH at toggle time; version drift
  changes flags; `gjc setup provider` cannot select `openai-completions` and
  has no remove, so Gajae still needs a file writer for half the operation;
  exit-code/stdout contracts become test fixtures we do not control.

### Option C — hybrid (recommended shape for the next cycle)

Per client, prefer the vendor CLI when it covers the operation; fall back to
the Option-A writer where it does not:

| Client | Enable | Disable |
|--------|--------|---------|
| OpenClaw | `openclaw config set --merge` (`--merge` is documented for protected maps on set/patch) | `openclaw config unset models.providers.opencodex` (plain path unset — `--merge` is **not** a documented unset flag; [config CLI](https://docs.openclaw.ai/cli/config)) |
| Kimi Code | `kimi provider add <ocx registry url>` | `kimi provider remove opencodex` |
| Gajae Code | `gjc setup provider --api-key-env ...` (needs `openai-responses` acceptance) or file writer | file writer (no CLI remove exists) |
| Hermes | file writer (YAML, `${VAR}` key ref) | file writer |

Read-back (the five states of §3) is always opencodex-owned file parsing —
vendor CLIs report their own state, not provenance.

## 6. Risk register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Format fidelity: comment/order loss on YAML/JSON5/TOML rewrite | Medium | prefer vendor CLI (Option C); Kimi already loses comments with its own tooling, so matching that bar is defensible; fence/sidecar keeps our edits narrow |
| Gajae strict schema rejects unknown fields | High if naive | emit only schema-known fields (002 §Gajae); test against the published tarball schema |
| Concurrent write while client runs | Medium | `atomicWriteFile` prevents torn bytes only; lost updates need the §3 compare-before-commit fingerprint check + single-flight 409, with the residual cross-process race accepted and documented; OpenClaw hot-reload makes a torn write *visible* to a running gateway |
| Drift: written model list vs live catalog | Medium | five-state read-back (`stale`) + refresh action; Kimi registry path self-refreshes |
| Non-loopback credential serialization (Kimi literal-only) | High | scope the toggle to loopback (placeholder key, Grok precedent `api_key = "opencodex-loopback"` in [grok/inject.ts](/Users/jun/Developer/new/700_projects/opencodex/src/grok/inject.ts)); non-loopback requires manual key entry — document, do not automate |
| Hermes removal residue (`.env`, `auth.json`, credential pool) | Low | env-ref-only toggle never writes those; document that we do not touch them |
| `conflict` state destructive-disable | High | never remove a block without ownership proof; require explicit takeover UX |
| Windows path/ACL matrix (`%LOCALAPPDATA%\hermes`, XDG on Windows for others) | Medium | reuse `atomicWriteFile` hardening; per-client path table in the implementation cycle |

## 7. Open questions for the implementation cycle

1. Kimi `api.json` registry schema — exact document shape the CLI imports and
   re-fetches (source read of `provider.ts` registry-import path).
2. Hermes dashboard API auth model — could an agent-driven caller ever use it,
   or is file writing the only honest path?
3. Gajae `api: openai-responses` acceptance — does our `/v1/responses` surface
   satisfy `gjc setup provider --compat openai`, making the add half
   CLI-driven too?
4. Whether read-back belongs in `GET /api/client-config` (per-client `state`
   field) or a new `GET /api/client-integrations`.
5. Per-client Windows/macOS/Linux path matrix (follows cc-switch's
   `get_hermes_dir` resolution order for Hermes).
