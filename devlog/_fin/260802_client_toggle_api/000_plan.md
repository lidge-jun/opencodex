# 000 — Plan: client-integration toggle research (API-side on/off switch)

Research unit. Docs-only: this unit produces survey and design-option documents,
not production code. Implementation, if approved later, gets its own decade docs
in a follow-up cycle.

Parent unit: `devlog/_plan/260731_client_config_export/` (the read-only export
surface this unit extends). Sibling survey `001_client_config_survey.md` there
already covers Pi/OpenCode injection layers and the no-standard landscape; this
unit does not re-survey them.

## Loop spec

- Loop archetype: spec-satisfaction research (verifier defines done).
- Trigger: user request — can client integrations be applied as an API-side
  on/off switch (enable writes the provider block into the client config,
  disable removes it), for Hermes Agent, OpenClaw, Kimi Code CLI, and
  Gajae Code, with cc-switch as the reference implementation.
- Goal: durable devlog evidence answering (a) how cc-switch implements
  apply/remove, (b) what each of the four clients requires for a safe external
  toggle, (c) what shape an opencodex management-API toggle would take and its
  risks.
- Non-goals: no `src/`, `gui/`, or test changes; no new clients serialized in
  `config-export.ts`; no implementation plan at diff level (that is the next
  cycle's decade docs, only if the design is approved).
- Verifier: every load-bearing claim carries a source URL or repo file path
  opened this cycle (cxc-search Tier 2); unverifiable claims are marked
  `candidate — unverified` and listed as open questions. `bun run
  privacy:scan` stays green.
- Stop condition: all four clients + cc-switch lane questions answered or
  explicitly marked unreachable.
- Memory artifact: this unit's 001–003 docs.
- Expected terminal outcomes: DONE (docs written, claims sourced) or BLOCKED
  (sources unreachable, named).
- Escalation: a client whose config cannot be toggled safely from outside is a
  finding, not a failure — record the blocker and mark that client UNSAFE for
  the toggle design.

## Research questions

### Q1 — cc-switch reference mechanics (doc 001)

- How does cc-switch apply a provider into each app's config (writer modules,
  atomic write, backup/restore), and how does it remove or restore one?
- Does it offer any local HTTP API / relay ("universal endpoint") as an
  alternative to file writes?
- What state does it own (`~/.cc-switch/config.json`) versus mutate in the
  client's files?

### Q2 — Per-client toggle requirements (doc 002)

For each of Hermes Agent, OpenClaw, Kimi Code CLI, Gajae Code:

- Config file, format, and the minimal provider block that points at
  `http://127.0.0.1:<port>/v1`.
- Hot-reload semantics: does the client re-read the file, or only at
  session/process start? What does "applies on toggle" mean in practice?
- Non-interactive management surface, if any (CLI subcommands, local API),
  which would beat raw file writes.
- Credential handling: env-reference support versus literal-only (decides
  whether the no-secret-serialization invariant survives a write path).
- Removal semantics: what must be cleaned up beyond the provider block
  (default model pointers, sessions, auth storage).

### Q3 — opencodex API toggle design options (doc 003)

- Current surface: `GET /api/client-config` is read-only by design; mutating
  precedents exist (`PUT /api/disabled-models`, `PUT /api/model-visibility`).
- Trust boundary (A-gate amendment, blocker 2): the toggle endpoint lives on
  the **management plane** — every `/api/*` request passes
  `requireManagementAuth`, loopback GUI sessions are origin-bound, and
  mutations require CSRF (`src/server/management-auth.ts`,
  `src/server/index.ts:448`). This is separate from **data-plane** admission
  (`resolveApiAuth` in `src/server/auth-cors.ts`), whose loopback shortcut
  only decides what a *client* must send to `/v1`. Doc 003 must not conflate
  the two.
- Launcher precedence (A-gate amendment, blocker 3): `ocx opencode` injects
  `provider.opencodex` through `OPENCODE_CONFIG_CONTENT`, which outranks the
  disk config for that process (`src/cli/opencode.ts`). Read-back must
  distinguish "disk state" from "runtime state when launched via `ocx`", and
  the design must say whether the disk toggle even applies to OpenCode.
- Design space: `PUT /api/client-config/:client {enabled: bool}` or a
  `/api/client-integrations` resource; read-back/health (is our block present
  and current?) versus fire-and-forget writes.
- State model (A-gate amendment, blocker 4): no cc-switch-style DB exists, so
  "is it on?" must be read back from the client file. A boolean `enabled`
  hides drift; the design needs richer states — `absent`, `current`, `stale`
  (our block but not what we would generate now), `conflict` (a block with our
  provider id that we did not write), `unsafe` (unparseable file / damaged
  ownership markers).
- Invariants to carry over: no secret serialized, additive merge only,
  preserve unknown fields, atomic write + backup, never touch blocks we did
  not write.

### Q4 — Local writer/read-back precedents (doc 003, A-gate amendment)

- `src/grok/inject.ts` — the repo's one existing third-party config writer:
  BEGIN/END managed fence in `~/.grok/config.toml`, orphan-marker refusal,
  non-loopback refusal with credential-fallthrough reasoning, placeholder
  `api_key = "opencodex-loopback"` (never a real secret), `stripGrokConfig`
  removal path.
- `src/grok/status.ts` — the read-only status reader paired with the writer;
  parses only our own fenced region.
- `src/config.ts` `atomicWriteFile`/`renameAtomicFile` — temp+rename, Windows
  EBUSY/EPERM/EACCES retry with backoff, 0o600 mode, ACL hardening, residual
  temp scrubbing.
- Claude Desktop writer/reader — second precedent to survey in 003.
- Risk register: format fidelity (YAML/JSON5/TOML round-trip), concurrent
  writes while the client runs, clients that rewrite their own config
  (Kimi Code), drift between proxy catalog and written model list.

## Doc map (000-range, research only)

- `000_plan.md` — this document.
- `001_ccswitch_toggle_analysis.md` — Q1 findings.
- `002_client_toggle_matrix.md` — Q2 findings, one section per client.
- `003_api_design_options.md` — Q3 design space + risk register + open
  questions. Options, not a commitment.
- `004_ux_design.md` — (cycle 2) GUI design for the unified integrations
  surface: tab rename, hero with install detection + switches, per-client
  sub-pages, and the rollback UX that makes the toggle trustworthy. Design
  spec only; component diffs belong to a later implementation cycle.

## Dispatch plan

- 5 research lanes (subagents, read-only): cc-switch, Hermes, OpenClaw,
  Kimi Code, Gajae Code. Lane output is candidate evidence; load-bearing
  claims are re-opened by the main agent before promotion (cxc-search proof
  handoff).
- Local (main agent): current management-API surface, GUI consumer, loopback
  admission semantics — already read this cycle:
  `src/clients/config-export.ts`, `src/server/management/model-routes.ts`,
  `src/server/auth-cors.ts` (`resolveApiAuth`, loopback admission),
  `gui/src/components/apikeys-workspace/client-config-clients.ts`.
