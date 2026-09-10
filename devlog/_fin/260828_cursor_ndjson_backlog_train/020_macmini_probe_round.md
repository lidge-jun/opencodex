# 020 — wp3: macmini-cf live probe round (NDJSON empiricism)

Host: macmini-cf. Proxy: ~/opencodex, launchd com.opencodex.proxy,
port 10100. Codex CLI: ~/.bun/bin/codex (bun global bin).

## Procedure

1. Sync (A-gate blockers 11/12 folded):
   - Environment: the host codex shim's shebang is "env node" and the
     host has NO node on PATH — every probe command must prepend a node
     shim (export PATH with bun's node alias, or "bun x codex"). VERIFY
     "codex --version" works in the actual probe shell BEFORE claiming any
     probe ran; a login-shell (ssh -t or zsh -lc) may differ from plain ssh.
   - The user's ~/opencodex dev checkout is NEVER reset or cherry-picked.
     Mandatory: dedicated probe worktree (git -C ~/opencodex worktree add
     ~/ocx-probe-260828/wt <ref> from fetched refs).
   - Deployment (A-gate round-1 fold, blockers 1-4):
     * Probe proxy launcher: a direct Bun entry that imports startServer
       (server/index.ts) on port 10199 — NOT "ocx start" (its CLI path
       detects the 10100 owner and exits, and mutates launchd env /
       startup integrations, cli/index.ts:204/:376, system-env.ts:261).
     * Isolated homes: OPENCODEX_HOME=~/ocx-probe-260828/home and
       CODEX_HOME=~/ocx-probe-260828/codex-home for the probe process AND
       probe codex runs. Never share ocx.pid/runtime-port.json with the
       primary (process-state.ts last-writer corruption).
     * Credentials: copy config.json + auth.json into the probe home.
       NO-REFRESH GATE: before probing, read cursor access-token expiry;
       require remaining lifetime > planned probe window + 10min skew,
       else abort (probe-side refresh could rotate the refresh token and
       invalidate the PRIMARY, oauth/cursor.ts:205/:232). Hash primary
       auth.json before/after and prove identical.
     * codex invocation: per-command -c overrides, not OPENAI_BASE_URL:
       codex exec --json -c 'model_providers.opencodex.base_url="http://127.0.0.1:10199/v1"'
       -m cursor/grok-4.6 ... ; verify "codex exec --help" advertises
       --json in the actual login shell first.
     * Capture contract: per-run files N<k>/run-XX.{command.txt,
       stdout.ndjson,stderr.log,exit}; probe-home usage.jsonl snapshots
       (never tail the primary's).
     * Pre/post primary evidence: branch, SHA, porcelain status, 10100
       /healthz, launchd state, sha256 of primary config.json + auth.json
       + ~/.codex/config.toml. Teardown: kill probe PID (verify its
       command/cwd first), prove 10199 closed + 10100 healthy, git
       worktree remove + git worktree list proof, keep evidence dir.
2. Probe matrix (codex exec --json -m cursor/grok-4.6 unless noted), scratch
   cwds under mktemp -d, transcripts + NDJSON to ~/ocx-probe-260828/:
   - N1 5-step chain (090 S4 shape): mkdir/write/read/compute/verify — the
     empty-tool-result trigger scenario. >=6 runs to chase the intermittent
     empty delivery; capture codex exec --json event stream per run.
   - N2 deep checkpoint session: >=8 tool rounds same thread (exercises
     checkpoint suffix path request-builder.ts:472).
   - N3 zero-stdout commands (true; mkdir; export) — defect #3 activation.
     N3 FIRST records how Cursor renders/forwards empty stdout on both the
     unary and streaming channel; the 030 marker ships ONLY if this
     evidence shows the model receives an unexplained blank (A-gate
     blocker 9 — no pre-committed fix).
   - N4 stalled-consumer live check for wp2 (curl -N | slow reader).
   - N5 usage.jsonl integrity tail — schema + usageStatus after rounds.
   - Controls: same probes via xai/grok-4.6 where defect could be
     model-class.
3. Evidence per probe: command, exit, NDJSON line excerpts (event types,
   call ids, output byte counts), usage.jsonl rows, PASS/FAIL vs expected.

## Decision gate feeding wp4

- Empty result reproduced with NDJSON showing nonempty local result but
  model-visible blank -> adapter boundary per 002 #1 -> wp4 instrumentation
  phase targets the implicated stage.
- Not reproduced in >=6 N1 runs + N2 -> defect #1 downgraded to WATCH with
  bounds recorded; wp4 ships #3 fix + instrumentation only.
