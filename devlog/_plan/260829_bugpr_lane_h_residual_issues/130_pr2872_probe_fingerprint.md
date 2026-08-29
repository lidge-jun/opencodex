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

An eighth round then rejected this section a second time. Skill metadata had been
written off as "a directory tree with no stable enumeration contract"; a live edit to
one `SKILL.md` description moved the probe's rendered output while the fingerprint
stood still. It is a directory listing and one file read per skill. The manifests are
hashed now.

What remains uncovered:

- **Plugin manifests and MCP/app availability.** Availability is a live connector
  state, not a file this process can stat.
- **Clock, timezone, shell.** Not files. A fingerprint over a clock is not a
  fingerprint.

The exposure is an external edit landing inside a single in-flight probe's window. Be
precise about the failure mode, because an earlier draft of this sentence got it
backwards: for an input the key does not cover, the key does not move, so the caller
DOES join and DOES receive the older rendering. Fail-closed `busy` is what happens for
a covered input. An uncovered one is a stale read of one layer's text, bounded to that
window, in a read-only inspection view.

This section has now been wrong twice, in the same direction both times: something was
called unreadable when it was merely inconvenient to read. The standard that survived
is narrow — an input belongs on this list only when no file on disk determines it.
Anything with a path gets hashed.

## Why this is a bounded key and not a total one

Nine rounds in, the useful conclusion is about the shape of the specification rather
than any single input. "Hash everything the rendered prompt depends on" is closable
only against a pinned Codex: the dependency graph belongs to Codex, is private, and
moves independently of this repository. A new config field or a changed precedence
upstream silently widens the gap without anything here changing.

So this is a bounded invalidation key over known local inputs, and the code says that
rather than implying identity.

A design that needs no enumeration exists and was assessed: admit on TIME, where a
request may join a probe only if the probe started after the request arrived. The
correctness argument holds — such a probe read the filesystem after every write that
completed before the request — and it needs a monotonic in-process ordinal rather than
a clock. It was not adopted because it removes almost all the coalescing that motivated
the work: a probe spawns immediately, so the ordinary second caller arrives after the
start and would always be refused. Recovering both properties means cohort batching —
hold arrivals briefly, spawn once the cohort is closed — which is a different change
from this one.

That is a real option, not a dismissal, and it belongs to whoever needs a strict
"never older than my arrival" contract. What ships here is the bounded key, which is
strictly better than the revision-only key it replaces.

## The reader, and why it stopped being a regex

Rounds five, six and seven each found another valid TOML spelling the hand-rolled
reader missed: a multi-line array, then a comment directly after the opening bracket,
then a quoted key. Three rounds, three patches to the same regex, each closing one
spelling and leaving the rest.

At that point the pattern was the defect. TOML is not a line format, so no regex over
lines can enumerate what a parser accepts, and each fix was only ever going to cover
the example in front of it. `Bun.TOML.parse` reads both keys now.

The module header forbids trusting a JS TOML parser, and that prohibition is worth
not eroding, so the distinction matters: it is about VERIFYING BYTES WE WRITE, where
Bun and Rust `toml_edit` disagree on escapes and Codex reads what we wrote. This is a
read of two arrays of plain filenames, and the failure directions are opposite. A
parse disagreement here costs a redundant probe; a missed spelling costs a stale read.
An unparseable file yields nothing, which is correct — Codex could not load it either.

## Verification

Route-level, in the file whose fixture separates `CODEX_HOME` from the injected
paths — the only place this can fail honestly. Two callers separated by an
`AGENTS.md` write must not share a flight: the second returns `busy`, and a later
request returns the new text. Repeated for `AGENTS.override.md`.

Named mutation: delete the instruction-file contribution from the fingerprint. The
regression must go red with identical keys and one spawn.
