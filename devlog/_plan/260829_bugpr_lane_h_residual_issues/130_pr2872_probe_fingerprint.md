# 130 — #2872: the probe admission fingerprint omits the instruction files it renders

Written after an independent adversarial review of PR #2872 at head `a7504ab8e`
returned BLOCKER FOUND, and after a plan audit of the first fix draft returned
PLAN NEEDS CHANGE. Both verdicts are applied here.

## Scope

IN: `src/codex/prompt-layers.ts` (`computePromptProbeStateFingerprint`),
`tests/codex-prompt-route.test.ts` (route-level regression).

OUT: the coalescing machinery itself (`runSharedPromptProbe`, waiter accounting,
the `busy` fail-closed policy) — reviewed and found sound. Also out: fingerprinting
state this process cannot observe, discussed under "What this does not cover".

## Defect — a post-write reader joins a pre-write flight and gets stale text

`computePromptProbeStateFingerprint` (`src/codex/prompt-layers.ts:643`) hashes
`config.toml`, `opencodex-prompt.json` (through `computeRevision`) and the selected
base variant `.md`. It does not hash `$CODEX_HOME/AGENTS.md`.

`probePromptText` runs the child with `cwd = resolveCodexHomeDir()`
(`src/codex/prompt-text-probe.ts:400`) and extracts that file's body as the
`__agents_md` layer (`:365`). The fingerprint is a component of `commandKey()`
(`:137-145`), which is the sole admission identity in `runSharedPromptProbe`
(`:302`). So an `AGENTS.md` edit leaves the key unchanged, the next request matches
`active.key`, joins the in-flight pre-write probe, and is served pre-write text.

Reproduced deterministically at `a7504ab8e`: identical fingerprints before and
after the write, and both callers received `"old-agent-text"`.

This is the same class of bug the fingerprint was introduced to fix. The original
`revision` covered only config/store transaction bytes, so editing the selected base
variant changed the prompt without moving the revision. Naming one more uncovered
input does not change the shape of the defect: admission identity must name every
input the probe renders.

## Fix

Hash the `CODEX_HOME` instruction files into the fingerprint.

The path is `resolveCodexHomeDir()`, **not** `dirname(activeConfigPath(opts))`. The
plan audit rejected the latter and it is right: `tests/codex-prompt-route.test.ts:115-125`
injects `codexPromptPaths` at a fixture root while setting `CODEX_HOME` to a separate
decoy, precisely so a route that ignored the injected paths is caught. Deriving the
`AGENTS.md` path from `configPath` would name a file the probe never reads, and the
regression would pass while production stayed broken.

Both spellings are hashed, in Codex's own precedence order: `AGENTS.override.md`
is preferred over `AGENTS.md`, so an override edit must move the key too. Absent
files hash to a distinct sentinel, so create and delete both move the key.

## What this does not cover, stated rather than implied

The guarantee is bounded to OpenCodex-managed writes plus the `CODEX_HOME`
instruction files. It is not complete prompt-state identity, and the code says so
instead of implying otherwise:

- Skill metadata, plugin manifests, and MCP/app availability feed
  `<skills_instructions>`, `<plugins_instructions>` and `<apps_instructions>`.
- Clock, timezone, shell and permission state feed `<environment_context>`.

None is writable through `/api/codex-prompt`; each needs an external edit
concurrent with an in-flight probe. A 15-second window bounded by a fail-closed
`busy` is the exposure, and pretending to fingerprint a clock would be worse than
documenting it.

The external `model_instructions_file` target was on that list and has been moved
off it. Listing it there was the wrong call twice over: it is an ordinary file this
process can read, and leaving it out meant the guarantee depended on whether we
authored the selected base prompt. A fourth review round found the asymmetry —
managed variant bytes hashed, an external selection recorded as the bare word
`external`. Its path and bytes are now hashed like any other field.

One correction to that round's stated impact, because the difference matters for
anyone reading this later: `base-instructions` is reported `not-exposed`
unconditionally, since `prompt_debug.rs` discards it. So the stale value was never
rendered back to a caller. The defect was a real hole in admission identity, not an
observable stale layer, and it is worth closing on the first ground alone.

## Round-by-round record

Four review rounds, four real defects. Worth keeping because the pattern is the
point: each fix was itself reviewed, and three of the four findings were in code
written to fix the previous finding.

1. The fingerprint omitted `AGENTS.md` entirely.
2. Fields were concatenated unframed, so contents could imitate a separator; the
   `\0absent` sentinel collided with a file holding those literal bytes.
3. `computeRevision` still had that same unframed shape inside it — and that value
   is also the write-path concurrency token, so the collision reached further than
   the probe.
4. An external base selection was hashed as a bare kind string.
5. Two more: a relative `model_instructions_file` was resolved against the proxy's
   own working directory instead of the config file's, so it hashed an unrelated
   file; and only the two built-in project-document names were considered, so a
   configured `project_doc_fallback_filenames` entry could be edited unnoticed.

## The pattern, and where it stops

Five rounds is the interesting part of this record. Each fix was reviewed, and four
of the six findings were in code written to close the previous finding. The reason is
consistent: a cache key is only as good as its worst-covered input, and "I added the
input I was told about" is not the same as "the key names everything the output
depends on". Framing, path resolution, and candidate-set breadth each failed
separately.

A sixth round then rejected the first version of this very section, and it was right.
It claimed the ancestor walk could never find anything because the probe runs in
`CODEX_HOME` with no checkout around it. The default project-root marker is `.git`,
and `~/.codex` inside a dotfiles repository is an ordinary setup: there, Codex renders
the repository's own `AGENTS.md` and the walk matters. The same round found two more
parsing gaps — upstream trims each configured filename and drops whitespace-only
entries, and the ordinary multi-line array spelling was missed by a single-line regex.

So the walk is now performed rather than argued away: nearest ancestor holding a
configured marker, then every directory from that root down to the home, with a
present-but-empty `project_root_markers` disabling detection exactly as upstream does.

What remains uncovered, with a reason that is not "we did not get to it":

- **Skill and plugin metadata.** Readable, but they are directory trees owned by
  Codex, not files with a stable enumeration contract here. Hashing them means
  duplicating a loader we do not own and would have to keep in sync.
- **Clock, timezone, shell, MCP availability.** Not files. A fingerprint over a clock
  is not a fingerprint.

The exposure for both is an external edit landing inside a single in-flight probe's
window, whose failure mode is a fail-closed `busy` and a retry, not corruption.

Given that this section has now been wrong once, the standard it should be held to is
worth stating: an input belongs on this list only when it cannot be read from this
process, not when reading it looks inconvenient.

## Verification

Route-level, in the file whose fixture separates `CODEX_HOME` from the injected
paths — the only place this can fail honestly. Two callers separated by an
`AGENTS.md` write must not share a flight: the second returns `busy`, and a later
request returns the new text. Repeated for `AGENTS.override.md`.

Named mutation: delete the instruction-file contribution from the fingerprint. The
regression must go red with identical keys and one spawn.
