# 001 — regression review of `origin/main..dev` (179 commits)

Method: five parallel read-only reviewer lanes, one per subsystem, each required to
classify every finding CONFIRMED / SUSPECTED / CLEARED with a file:line citation and
a reproduction. Plus a live drive of the running proxy by the main session, because
the user's stated fear ("503 같은 회귀가 있을수도 있잖아") is about runtime
behaviour and no amount of reading settles it.

Result: **13 CONFIRMED regressions, 1 SUSPECTED, 14 explicitly CLEARED.** Four of
the confirmed ones are severity-high. The 503 the user asked about is real, and it
is worse than a rare edge: `chmod` on a file is enough to trigger it.

## Live proxy drive (the 503 question, answered directly)

Against the running proxy on port 10100, with the admin token:

```
healthz=200
/v1/models=200
/api/codex-prompt=200
POST /v1/chat/completions -> 200, 1.638s, real completion ("OK", 13 tokens)
```

So the happy path is not broken. The 503 is CONDITIONAL, and finding H1 is the
condition.

## Confirmed findings

### H1 — `chmod` fences the entire data plane with 503 (high)

`src/lib/package-tree-integrity.ts:36`, `src/server/index.ts:869`.
Landed in `303cc3c8c` ("refuse requests after the package tree is replaced under a
live proxy (#2459) (#2632)").

The guard compares `{device, inode, changeTimeNs, size}` of `package.json` against
the boot observation. `ctimeNs` changes on **metadata** writes, not only content
writes — `chmod`, `chown`, `touch`, an editor's permission normalisation, a backup
tool restoring modes, `git checkout` of an unrelated branch that happens to reset a
mode bit. Device, inode and size are all unchanged in those cases, so the guard's
own definition of "replaced" is met by a file that was never replaced.

Reproduced by the main session, in a temp directory, without touching the real
`package.json`:

```
boot: {"ok":true}
after chmod (contents identical): {"ok":false,"reason":"package_tree_replaced"}
```

The consequence at `src/server/index.ts:869-889`: `/healthz`, `/readyz` and every
`/v1/*` request return 503 with `Retry-After: 5` and the message "restart OpenCodex
before retrying". A negative result is deliberately never cached, so every
subsequent request re-stats and re-fails. There is no recovery short of a restart,
because `boot` is captured once at construction.

Note what the guard's own comment claims: "an event that happens at most once per
install". That is true of a tree replacement. It is not true of a ctime change.

### H2 — 64-lane cap turns the 65th session into a 503 (medium)

`src/server/lifecycle.ts:179`. `origin/main`'s `tryAdmitTurn` had only the
256-slot global turn gate; dev adds a 64 distinct-lane gate ahead of it and maps
the rejection to `server_busy` 503. Proven by the harness's own assertion at
`tests/session-lane-recall-harness.test.ts:244`. A user with 65 concurrent
identified sessions is refused at a limit that did not exist and that no
documentation mentions.

### H3 — custom-layer write corrupts a BOM-prefixed `config.toml` (high)

`src/codex/prompt-layers.ts:614`. The generated block is inserted BEFORE a UTF-8
BOM, relocating the BOM to byte 58. The write reports success; Codex's parser then
fails. Reproduced: `WRITE:OK`, `BOM_INDEX:58`, `PARSE_ERROR: Expected a key but
found (0xEF)`.

This is the exact class the module's own header warns about — the file is careful
never to parse TOML back, then hands the parser a file it cannot read.

### H4 — a bad store leaves `config.toml` half-written and the journal orphaned (high)

`src/codex/prompt-layers.ts:657`. Only CONFIG readability is pre-checked. The
config is written first; the store write then throws and nothing rolls the config
back. Reproduced with the store path as a directory: `THROW:EISDIR`, config
containing `developer_instructions = "B"`, `JOURNAL:true`, `LOCK:false`.

### H5 — prompt WRITE routes accept a bare admin token (high)

`src/server/management/codex-prompt-routes.ts:283`. The routes never inspect
`ctx.principal`; the shared gate accepts the raw admin token
(`src/server/management-auth.ts:463`). A PUT with only the admin token returned
`GATE:ALLOWED`, `PRINCIPAL:admin-token`.

AGENTS.md is explicit that a config writer must sit behind a dashboard session, and
explicit about why the distinction is thin but real: the session requirement stops
the casual path — "an agent that would have POSTed there because the endpoint
existed, and one holding only the admin token". This route is precisely the second
case.

### H6 — scheduled cleanup deletes a REUSED branch name (high)

`.github/scripts/closed-pr-branch-cleanup.cjs:113`. The planner selects branches
whose same-NAME historical PRs are all closed, and never checks that the branch's
current SHA matches a closed PR head SHA. Reproduced: a live
`codex/reused-for-new-work` branch with one old closed PR #42 produced
`{"deletions":[{"branch":"codex/reused-for-new-work","pullRequests":[42]}]}`, and
the workflow calls `deleteRef` at `cleanup-closed-pr-branches.yml:119`.

Given this session's own habit of reusing `codex/`-prefixed names, this one can
eat live work.

### H7 — the `--restart-codex` fix cannot explain the user's surviving PID (high)

`src/codex/app-server-processes.ts:1087`. Dev additionally matches the direct
`node <codex>` wrapper, but still signals each matched PID independently and
reports only signalled PIDs. So the "unmatched supervisor" story cannot produce the
survivor the user actually saw (`PID(s) still running after SIGTERM: 1782906`), and
a native child that ignores SIGTERM still survives. The focused test passes because
it tests matching and explicitly preserves SIGTERM-only behaviour.

The user's complaint from the Ubuntu box therefore stands unfixed.

### H8 — hidden Multi-auth panel keeps polling (medium)

`gui/src/pages/CodexSet.tsx:37`. `origin/main` unmounted Codex Auth on
navigation. Dev's lazy-mount latch only adds `hidden`, so `/api/config`,
account-pool, picker and feature-setting 30-second polls all keep running while the
Prompt panel is active.

### H9-H12 — provider/adapter findings (medium)

- `src/adapters/openai-chat.ts:1113` — sibling scalar assertions OVERWRITE instead
  of intersecting. `{minLength:5, enum:["a","b"]}` over
  `{minLength:1, enum:["b","c"]}` yields `{minLength:1, enum:["b","c"]}`, i.e. the
  looser constraint wins. The existing test passes because its same-key case only
  uses a tighter sibling.
- `src/adapters/openai-chat.ts:1090` — budget exhaustion returns `{}`, deleting
  `type`, `required` and every leaf constraint below it. A 70-level ref-free schema
  reached 31 object levels and terminated as `{}`. The deep-schema test only checks
  that normalisation does not throw.
- `src/providers/registry.ts:979` — `glm-5.3-flash` is STILL in `noVisionModels`
  on umans, cline-pass, nvidia, both volcengine plans and ollama-cloud; umans and
  cline additionally emit `modalities:["text"]`. My own previous work fixed Z.AI
  and missed six providers, so images on those routes go through the vision sidecar
  instead of native VLM input.
- `src/providers/registry.ts:343` — `glm-5.3-flash` was added to the Z.AI list by
  hand and omitted from `ZAI_GLM_53_MODELS`, so `efforts`, `defaultEffort` and
  `maxOutput` are all null where its siblings inherit `["low","high","max"]`,
  default `max`, 131072.

That last pair is worth stating plainly: two of the thirteen regressions are mine,
from the glm-5.3-flash work merged earlier in this same session. The parity test
passed because its assertions cover only selected providers, which is exactly the
false-green shape `TEST-ORACLE-INDEPENDENCE-01` warns about.

## Suspected

`src/codex/prompt-lock.ts:128` — `release()` swallows an unlink failure, its false
return is ignored at `prompt-layers.ts:721`, and the still-live PID defeats stale
takeover, so every later write is refused until restart. Deterministic by reading,
but proving it needs an injected `unlinkSync` failure test.

## Cleared, with what protects each

| Claim | Protected by |
|---|---|
| core-lab boundary intact | `tests/core-lab-boundary.test.ts` 13/13, direct + transitive + guard-sabotage |
| no `await` in the `startServer` sync window | `activateLab` still sync at `index.ts:1951`, returns `:1954` |
| reconnect lanes refcount correctly | harness reconnect / reverse-release / global-cap / HTTP-overlap |
| provider discovery 502 degrades to fallback | `provider-fetch.ts:1421-1428` unchanged in range |
| Ox Alpha removal complete | zero readers of either deleted symbol or any Ox id |
| no surviving model id lost | word-diff of `registry.ts`: Ox Alpha is the only deletion |
| legacy `#codex-auth` hashes still reachable | `codex-set-shell` 12/12 |
| i18n complete | 0 missing used keys across all 8 locales, 2256 keys each |
| prompt write rollback reconciles | custom-layers 26/26, presets 11/11 |
| 0-byte `config.toml` handled | absent-vs-empty revision coverage |
| TOML encoding round-trips | quotes, trailing backslash, literal \n, non-BMP, U+2028/9, 64 KiB |
| AGENTS.md probe global-only, bounded | no caller cwd, resolved CODEX_HOME, 8 MiB cap |
| no gitlink / clone / triage indexed | `repo-hygiene` 11/11 |
| new cleanup workflow least-privilege | no default perms, SHA-pinned actions |
| `privacy:scan` | passes |

## Disposition

Promotion of `dev` to `main` should not happen until H1, H3, H4, H5 and H6 are
fixed. H1 alone is a self-inflicted outage waiting for a `chmod`.

Fix order, dependency-first: H1 (availability) → H5 (auth boundary) → H3/H4 (config
corruption) → H6 (branch deletion) → H9-H12 (provider metadata) → H2/H7/H8.
