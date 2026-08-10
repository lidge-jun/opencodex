# 010 — WP1: the config.toml read/write core

> **Status: LANDED.** Six commits, `e0b15feb0` through `d70fde4d9`.
> Files: `src/codex/prompt-layers.ts`, `src/codex/prompt-journal.ts`,
> `src/codex/prompt-lock.ts`, plus six test files (134 cases).
> Full suite green at 7095 pass / 0 fail.
>
> Deviations from this document, all recorded below where they occur:
>
> - `Bun.TOML` is not used to verify writes. A live probe on Bun 1.3.14 found it
>   transposes `\t` and `\f`, rejects `\u0007`, and does not trim the newline
>   after an opening `'''`. Verification is byte-level instead.
> - Salvage returns `backupDir`, not `backupPath` — a read-only preview must not
>   reserve a filename.
> - `previewAdopt` runs the full validation pipeline so preview and commit agree
>   byte-for-byte; asserted by test.
>
> Still open, carried as the WP1 acceptance gate the audit named: Windows
> write-through. `fsyncDir` no-ops on win32 today, so a crash there surfaces as
> `recovery_required` rather than silent loss. That branch needs a Windows CI
> run before WP2 depends on it.

New file: `src/codex/prompt-layers.ts`. No GUI, no route. Pure module + tests.

`004` §E: `features.ts` forbids broadening itself beyond `multi_agent_v2`, so
this is a sibling module that copies its technique rather than an extension of
it.

## Exports

```ts
/** Classes A-E from 001 §4. The partition is total and disjoint. */
export type LayerClass =
  | "base" | "config-toggle" | "feature-gated"
  | "runtime-conditional" | "extension-unknown";

export type ToggleId =
  | "permissions" | "collaboration" | "environment" | "apps" | "skills";

/** The canonical inventory. ONE definition, consumed by route and GUI alike. */
export interface LayerDescriptor {
  id: string;
  class: LayerClass;
  /** config key for config-toggle and feature-gated; null otherwise */
  key: string | null;
  /** documented default when the key is absent */
  default: boolean | null;
  /** assembly index from 001 §1; null when registration-order dependent */
  order: number | null;
}
export const LAYER_INVENTORY: readonly LayerDescriptor[];

export interface ToggleState {
  id: ToggleId;
  key: string;
  /** null = key absent from the user file */
  userFileValue: boolean | null;
  /** userFileValue ?? default. NOT the resolved Codex value — see below. */
  defaultedUserValue: boolean;
  default: boolean;
}

export interface CustomLayer {
  id: string;             // [a-z0-9]{6}, stable across edits
  title: string;
  body: string;
  enabled: boolean;
}

export interface PromptLayerSnapshot {
  configPath: string;
  storePath: string;
  configExists: boolean;
  readable: boolean;
  /** false when developer_instructions exists without our marker */
  developerInstructionsOwned: boolean;
  /** non-null blocks mutations until resolved; see §Drift */
  drift: Drift;
  toggles: ToggleState[];
  custom: CustomLayer[];
  modelInstructionsFile: string | null;   // read-only warning (002 §3)
  /** SHA-256 over the COMPLETE bytes of both files plus existence flags */
  revision: string;
}

/** Preview DTOs — returned without writing anything. */
export interface AdoptPreview {
  rawLine: string;
  decodedBody: string | null;      // null when the form is unsupported
  reason: "ok" | "unsupported_form" | "invalid_characters";
  path: string;
  line: number;
}
export interface SalvagePreview {
  body: string;
  /** the DIRECTORY backups are written to. No path is reserved by a preview. */
  backupDir: string;
  /** enumerated so the UI can state them; see §Missing store */
  unrecoverable: readonly string[];
}
```

`previewSalvage` returns a directory, not a filename. Naming an exact backup
path during a read-only preview would either reserve it — making the preview a
write — or promise a name that exclusive creation may refuse at commit time.
The actual path is created during the confirmed mutation and returned in its
`WriteResult`.

```ts

export type WriteResult =
  | { ok: true; changed: boolean; snapshot: PromptLayerSnapshot }
  | { ok: false; error: WriteError };

export type WriteError =
  | "config_unreadable" | "stale_revision" | "developer_instructions_not_owned"
  | "unknown_layer" | "store_unreadable" | "invalid_characters"
  | "adopt_unsupported_form" | "write_superseded" | "recovery_required";

export type Drift =
  | "journal-present" | "projection-stale" | "store-missing"
  | "owned-malformed" | null;

/** Pure. Never writes, never locks, never recovers. */
export function readPromptLayers(opts?: Paths): PromptLayerSnapshot;

export function setToggle(id: ToggleId, enabled: boolean, revision: string, opts?: Paths): WriteResult;
export function writeCustomLayers(layers: CustomLayer[], revision: string, opts?: Paths): WriteResult;

/** Preview is read-only; commit requires an explicit confirmation + revision. */
export function previewAdopt(opts?: Paths): AdoptPreview;
export function adoptDeveloperInstructions(revision: string, opts?: Paths): WriteResult;

/** `owned-malformed`: re-adopt through the narrow decoder, or replace outright. */
export function repairOwnedMalformed(
  mode: "adopt" | "replace", revision: string, opts?: Paths,
): WriteResult;

/** `store-missing`: salvage the projection as ONE layer. Preview is read-only. */
export function previewSalvage(opts?: Paths): SalvagePreview;
export function salvageProjection(revision: string, opts?: Paths): WriteResult;

/** `journal-present`: run at service start and at every lock acquisition. */
export function recoverIfNeeded(opts?: Paths): 
  { ok: true; recovered: boolean } | { ok: false; error: "recovery_required" };
```

Every filesystem mutation lives in WP1. `020` is a transport that validates,
forwards, and serializes — it never opens a file. An earlier draft left adopt,
repair, salvage, and recovery undeclared, so `020` could not have been built
from WP1's stated contract at all.

### `defaultedUserValue`, not `effective`

The audit caught the first draft calling `configured ?? default` the *effective*
value. It is not. `003` §1 lists eight layers above the user file — profile-v2,
project config, CLI `-c`, thread layers, MDM — any of which can win.

opencodex reads one file, so it can only report what that file says. The field
is named for what it actually is, and the UI says "이 파일의 설정" rather than
claiming the running Codex agrees. `003` §6's managed-override notice is
**deferred**: promising override detection without a read path would be the same
overclaim in a different place.

## Key allowlist — fixed, never computed

```ts
const TOGGLE_KEYS: Record<ToggleId, { table: string | null; key: string }> = {
  permissions:   { table: null,     key: "include_permissions_instructions" },
  collaboration: { table: null,     key: "include_collaboration_mode_instructions" },
  environment:   { table: null,     key: "include_environment_context" },
  apps:          { table: null,     key: "include_apps_instructions" },
  skills:        { table: "skills", key: "include_instructions" },
};
```

`003` §5: an unknown key is silently ignored in normal mode and a hard startup
error under `--strict-config`. A fixed table means the GUI can never emit a key
it did not intend. `setToggle` rejects any id outside this map before
touching the file.

## Read

1. Resolve the path exactly as `features.ts:58-67` does — `CODEX_HOME` at call
   time, `~` expansion, `realpathSync.native` when it resolves.
2. Missing file → `configExists: false`, `readable: true`, every toggle
   `userFileValue: null`. **Writes are allowed and create the file** — see
   "First write" below. The audit was right that a disabled switch plus a
   "created on first change" note is a contradiction.
3. Unreadable → `readable: false` and every write refused.
4. For each of the five keys, scan the correct scope: root keys only outside any
   `[table]` header; `skills.include_instructions` only inside `[skills]`.
   Reuse the table-body bounding from `features.ts:269-290`.
5. **Absent key means `configured: null`, never `false`.** `001` §6 — this
   surface is four months old and still moving; absence is unknown, not off.
6. Custom layers come from `opencodex-prompt.json`, never from parsing
   `developer_instructions`. Determine `developerInstructionsOwned` by the
   marker-adjacency rule.
7. Read `model_instructions_file` for the read-only warning row.
8. Compute `revision`.

## First write

When `config.toml` is absent, the first mutation creates it:

- `mkdir -p` the parent with mode `0700`, matching how Codex itself treats
  `$CODEX_HOME`;
- write a minimal file containing only the marker and the key being set;
- `0600` on the file — it sits beside `auth.json`.

A missing file is a first run, not an error state. `040` therefore renders live
switches, not disabled ones.

## File modes — every content-bearing file, not just config.toml

Custom layer bodies are user prose that may contain anything the user considers
private. They land in four places besides `config.toml`, and an earlier draft
specified a mode for none of them:

| File | Mode | Why |
|---|---|---|
| `opencodex-prompt.json` | `0600` | holds every layer body |
| `opencodex-prompt.journal` | `0600` | holds pre- and post-images of both files |
| `opencodex-prompt.salvage-*.txt` | `0600` | a copy of the projected prompt |
| `opencodex-prompt.lock*` | `0600` | pid and token metadata |

Temporary files inherit the same mode **at creation**, not by a later `chmod` —
a window where a body is world-readable is still a disclosure. Quarantined lock
files keep their mode through the rename.

Windows has no POSIX modes; the repository's existing ACL hardening path is used
instead, and the mode assertions are POSIX-only in tests.

## Write

Same discipline as `features.ts:248-310`:

- refuse unreadable input rather than creating a fresh file over it;
- `dominantEol` before, `applyEol` after;
- edit the line array, never re-serialize the document;
- confine matching to the owning table body;
- idempotent — equal value returns `changed: false` and writes nothing;
- `atomicWriteFile` only when something changed.

Root-key insertion goes at the document top, before the first `[table]` header,
because a root key placed after one belongs to that table. `inject.ts:162`
already establishes the top-of-document convention.

`[skills]` is created only when setting the skills layer and the table is
absent, appended at end of document.

## Storage — redesigned after audit

The first draft fenced layer bodies inside the `developer_instructions` TOML
string and kept disabled bodies in a sidecar JSON. An independent audit killed
it on four counts, all correct:

- **TOML encoding.** "Body is verbatim" is false inside a multiline basic
  string. A body containing `"""` terminates the value; a backslash is an escape.
  Arbitrary user prose would produce malformed TOML — and `003` §4 shows Codex
  cannot then parse the file at all.
- **Fence collision.** A body containing `# <<< ocx-layer:...` splits or steals
  its own block.
- **Two-file reconciliation.** Presence/absence rules do not say which side wins
  for body, title, or order, and deleting the JSON silently loses every disabled
  body.
- **Concurrency.** Two GUI tabs, or Codex writing between our read and write,
  lose updates. Atomic rename prevents torn bytes, not stale overwrites.

### The fix: one owned file, one generated key

**`$CODEX_HOME/opencodex-prompt.json` is the single source of truth** for custom
layers — every layer, enabled or not, with body, title, and order.

`config.toml` receives exactly one generated root key, emitted by our own
three-rule encoder over a restricted character set (§Why no prompt text goes
into config.toml at all):

```toml
# Auto-injected by opencodex
developer_instructions = "...properly escaped composition of enabled layers..."
```

Consequences that dissolve three blockers at once:

- **No fences.** Bodies are joined with `\n\n` and never carry structure that
  has to survive a round trip through TOML. The value is write-only from our
  side; we never parse it back to recover layer identity.
- **Encoding is total.** Three escapes — `"`, `\`, newline — over a character
  set that excludes everything ambiguous. Verification is a byte comparison, not
  a reparse, because no TOML parser we could run is trustworthy enough to be the
  judge (measured defects in `Bun.TOML` are recorded below).
- **Reconciliation disappears.** There is exactly one authority. `config.toml`
  is a *projection*, never a source.

### Why no prompt text goes into config.toml at all

Round 2 of the audit rejected the `smol-toml` plan on six counts, and a live
experiment on this machine settled the question harder than the audit could.

**Measured on Bun 1.3.14, `Bun.TOML.parse`:**

| Input | Decodes to | Correct? |
|---|---|---|
| `"a\tb"` | `a\fb` | **no — tab becomes form-feed** |
| `"a\fb"` | `a\tb` | **no — form-feed becomes tab** |
| `"a\u0007b"` | `SyntaxError` | **no — valid TOML rejected** |
| `'''\nx'''` | `\nx` | **no — spec requires trimming the first newline** |

`\n`, `\r`, `\b`, `\\`, `\"`, `\uXXXX` for printable code points, and non-BMP
text all round-trip correctly. But three defects are fatal to a verify-by-reparse
design: two escapes are transposed, one legal escape is refused, and multi-line
literal trimming is not implemented.

The consequence is not "pick a different parser". It is that **we cannot verify
what Codex will read.** Codex parses with Rust `toml_edit`; we would verify with
Bun or with a JS library. An encoding tuned to satisfy our verifier is exactly
the encoding that can diverge in Codex's. A reparse check against a parser with
known-transposed escapes is worse than no check, because it reports success.

Adding `smol-toml` does not fix this either. The audit was right on every
procedural count — it is BSD-3-Clause and not MIT as an earlier draft claimed,
it is absent from `package.json` and `bun.lock`, its `parse()` returns values
and not source spans so the "locate the exact value span" claim was unsupported,
and a new production dependency triggers the security review that
`AGENTS.md` requires and no phase owned.

### The design that removes the problem

**No user-authored prose is ever written into `config.toml`.**

Custom layers live in `$CODEX_HOME/opencodex-prompt.md` — a plain UTF-8 markdown
file that opencodex owns outright. `config.toml` receives one generated line:

```toml
# Auto-injected by opencodex
model_instructions_file = "~/.codex/opencodex-prompt.md"
```

No — see the next paragraph. That key replaces the base prompt (`002` §3), which
is the thing this unit exists to avoid.

`developer_instructions` accepts only a string, so an external file is not an
option for it. Therefore the composed value **must** be encoded into TOML, and
the encoding must be one whose correctness does not depend on any parser we
control.

**Resolution: restrict the writable body character set.**

"Printable Unicode" is not executable, as the audit noted. The rule is defined
over **Unicode scalar values**, not UTF-16 code units:

| Input | Handling |
|---|---|
| U+0009 tab | normalized to four spaces |
| CRLF, lone CR | normalized to LF |
| U+000A newline | accepted, encoded as `\n` |
| other C0 controls, U+007F DEL | **rejected** with position |
| C1 controls U+0080–U+009F | **rejected** — invisible and rarely intentional |
| **unpaired surrogate** | **rejected** — not a scalar value; UTF-8 encoding would substitute U+FFFD and silently alter the prompt |
| U+2028, U+2029 | accepted; they are not TOML line terminators and cannot end a basic string |
| everything else, incl. non-BMP | accepted verbatim |

Validation iterates code points, so positions are reported as **code-point
indices** consistently across the API, the linter, and the editor. Size caps are
measured in **UTF-8 bytes after normalization** — tab expansion can grow a body,
so checking before normalization would let an oversized value through.

Within that set, TOML basic-string encoding is total: escape `"` and `\`, emit
`\n` for newline, pass everything else through. Three escapes, all unambiguous,
none in the defective set. `\r` never appears because CRLF is normalized away.

Verification is then a **byte-level** assertion rather than a semantic one: the
emitted line must equal `key = "` + escaped + `"`, and re-reading the file must
yield that exact line. No TOML parser is involved on the write path, so no
parser's defects can hide a divergence.

**Byte equality is not the same as Rust agreeing with us**, which the audit
rightly pressed on. A hand-written grammar matcher tests the encoder against the
encoder's own assumptions. So WP1 also carries **one** independent proof: a
checked-in fixture of generated lines covering every accepted character class,
parsed by the real `toml_edit` through a tiny Rust test in the pinned upstream
checkout, with the decoded values committed as a golden file. It runs on demand,
not in the GUI suite, and it is the only thing that settles what Codex actually
reads.

This costs the user the ability to put a NUL or a bell character in a prompt.
That is not a real loss, and it buys a guarantee that a dependency plus a
reparse could not.

### Canonical physical form

Audit blocker 5 asked for one canonical representation so replacement is a known
edit rather than a span search. It is exactly this, always:

```
<OCX_SECTION_MARKER>
developer_instructions = "<escaped, single line>"
```

Two lines, at the top of the document, above the first `[table]`. The value is
always a single-line basic string — never multi-line, never literal. Replacement
is: find the marker, replace the following line. If the line after the marker
does not match `/^developer_instructions = "/`, we do not own it and refuse.

The five boolean toggles keep the `features.ts:248-310` scoped line edit.
Booleans need no escaping at all.

### Ownership, and the takeover flow

`developer_instructions` is ours only when the immediately preceding line is
`OCX_SECTION_MARKER` and the line itself matches the canonical form — the
adjacency rule from `injected-marker.ts:53-60`, tightened by a shape check.

- **Marker present, canonical shape** → owned; rewrite freely.
- **Marker present, shape differs** → refuse. Something edited our line into a
  form our replacement rule does not cover.
- **Marker absent, key present** → externally authored. Refuse to write, and
  offer the takeover below.

We cannot safely rewrite a value whose string form we did not choose: it may be
literal, multi-line, or dotted, and `Bun.TOML.parse` cannot be trusted to decode
it (see §Why no prompt text goes into config.toml at all). Refusing is honest.

**But refusing alone is a dead end**, which is what audit blocker 5 objected to
in round 2 — the earlier answer was "the user clears it themselves", i.e. delete
your existing instructions by hand. That is not a feature.

**Takeover (`POST /api/codex-prompt/adopt`):**

1. read the raw source line
2. **decode it** with the inverse of our own encoder (below) — an earlier draft
   stored the raw line as the body, which an audit correctly called a semantics
   change: `"hello\nworld"` would have been imported as those twelve literal
   characters rather than two lines
3. show the user **both** the original source line and the exact decoded body
   that will be imported, plus a copy button
4. on explicit confirmation: write the decoded body into
   `opencodex-prompt.json` as one enabled layer titled "Imported from
   config.toml", and replace the original lines with the canonical owned form,
   through the journal transaction every other write uses

**The decoder is deliberately narrow.** It accepts a single-line basic string
containing only `\"`, `\\`, and `\n` — precisely the three escapes our encoder
emits. Anything else is refused:

| Input | Result |
|---|---|
| `\t`, `\f`, `\b`, `\r` | refused — `Bun.TOML` transposes two of these, so we will not guess |
| `\uXXXX` | refused — decoding it correctly is exactly the ambiguity we removed |
| multi-line basic or literal string | refused |
| unterminated or unbalanced quotes | refused |

Refusal is `adopt_unsupported_form` with the file path and line number. That is
a narrow dead end that names where to look, and it is honest about the reason:
we do not have a parser we trust for the general case.

**The decoded text then goes through the ordinary pipeline, in this order:**

1. decode with the narrow decoder → `adopt_unsupported_form` on refusal
2. normalize: tab → four spaces, CRLF and lone CR → LF
3. validate scalars: reject unpaired surrogates, C0, DEL, C1 → `invalid_characters`
   with a code-point position
4. enforce the 64 KiB body cap **after** normalization, in UTF-8 bytes, and the
   128 KiB composed cap against the layers that already exist
5. preview **the post-normalization body** — the exact bytes that will be
   committed

Step 5 matters: an earlier draft previewed the decoded text and committed the
normalized text, so a body containing tabs would have been shown one way and
saved another. Preview and commit must be the same string.

The same five steps run for `owned-malformed` re-adoption.

### Malformed owned lines

Marker present, shape non-canonical. The audit flagged this as a new dead end,
and it was — Adopt covered only the marker-absent case, and Repair only drift.

It is now its own state, `drift: "owned-malformed"`, with the same treatment as
Adopt: show the raw line, offer a copy, and on confirmation either re-adopt it
through the narrow decoder or replace it outright with an empty owned line if
the user prefers. A user cannot be locked out by reformatting a line we
generated.

### Revision — hashes the edit base, not a summary of it

Audit blocker 4 found the first revision covering too little: removing the
marker while leaving the value unchanged produced an identical hash, so an
ownership change was invisible.

`revision` is now SHA-256 over the **complete bytes** of both files plus their
existence flags:

```
sha256( "cfg:" + (configExists ? configBytes : "\0absent") + "\n" +
        "store:" + (storeExists ? storeBytes : "\0absent") )
```

Hashing whole bytes rather than extracted values covers marker presence, key
position, reformatting, comment changes, and file creation or deletion in one
construct. It is also the exact base the edit is computed from, which is what
makes the compare-then-write meaningful.

### The transaction

Blocker 2 was correct and serious: JSON-first meant a failed request had already
mutated the source of truth. Blocker 3 was correct that "the next read
reprojects" made GET a mutating operation.

Both are fixed by a journal, and by never letting a read write.

**Files:**

| Path | Role |
|---|---|
| `opencodex-prompt.json` | source of truth for custom layers |
| `opencodex-prompt.journal` | present only during a mutation |
| `config.toml` | Codex's file; carries the generated projection |

**Write, under an advisory lock (below):**

1. acquire the lock; run recovery first if a journal exists
2. re-read both files; compare `revision` → `stale_revision` on mismatch
3. write the journal envelope (below) and durably rename it into place.
   **The journal is prepared intent. It is not a commit.**
4. re-verify `config.toml` bytes against the edit base, then write it atomically
5. re-verify `opencodex-prompt.json` bytes against the edit base, then write it
   atomically
6. **verify both targets now hash to the post-image**; only then delete the
   journal — that deletion is the commit
7. release

Steps 4 and 5 each re-verify **their own** target immediately before its rename.
An earlier draft guarded only `config.toml`, which left the store writable by a
third party between step 2 and step 5 — the audit was right that we would then
overwrite it. A mismatch at either point aborts and rolls back.

Step 6 compares **complete bytes**, not just the presence of our two lines.
Another writer could change an unrelated key while leaving our lines intact, and
a narrow check would report success over their edit. Any target that matches
neither image is `write_superseded`, and the journal is **not** deleted.

**Rollback** applies the same pre/post/neither classification per target: a
target matching the post-image is restored to its pre-image, a target matching
the pre-image is already correct, and a target matching neither stops everything
with `recovery_required`. Rollback never writes over a file it does not
recognise.

**Recovery — at service start and at lock acquisition, never in a GET.**

Because the journal is prepared intent and commit is its deletion, **a journal
found on disk means the transaction never committed.** Recovery therefore rolls
*back*, never forward. An earlier draft rolled forward from the post-image while
simultaneously claiming a failed request changes nothing; the audit found the
two rules cannot both hold, and this is the one that survives.

An earlier draft said "if either target differs from the post-image, rewrite
both from the post-image". An audit found that destroys legitimate work: crash
after writing config.toml, user or Codex then edits config.toml, recovery sees a
mismatch and overwrites their edit with a stale post-image.

Recovery classifies **each target independently** against both recorded hashes:

| Target matches | Meaning | Action |
|---|---|---|
| **all targets** post-image | writes finished, step 6 never ran | delete journal — commit it |
| post-image (mixed) | partially applied | **restore to pre-image** |
| pre-image | never applied | leave it |
| **neither** | **externally modified** | **stop; `recovery_required`** |

A single unrecognised target aborts the whole recovery before anything is
written. We never repair one file while another carries a stranger's edit.

The all-post case is the one exception to rolling back, and it is not a
roll-forward: both files already hold exactly the intended result, so the only
missing step was deleting the journal.

### Journal envelope

"Restore from the pre-image if it is intact" is not implementable when the
pre-image lives inside the same damaged document — the audit was right. The
journal is therefore a **checksummed envelope**:

```
line 1: ocx-journal-v1 <sha256 of line 2..n>
line 2: {"preConfig":"...","postConfig":"...","preStore":"...","postStore":"...",
         "preConfigExists":true,...}
```

On recovery the checksum is verified first. **Any journal that fails its
checksum, or is truncated, is `recovery_required` — nothing is read from it and
nothing is written.** Partial recovery from a damaged transaction record is
exactly the operation that should never be attempted on a user's config.

Atomic temp-write plus `fsync` and rename makes a torn journal exceptional; when
it happens anyway, failing closed is the whole point of having the record.

`recovery_required` names both paths and the journal, and blocks mutations until
the user resolves it. An honest stop beats best-effort repair on a file the user
also edits by hand.

### Commit point — one state machine, not two

The same audit found the draft mixing two models: journal-rename-is-commit
(implying roll-forward) alongside "a step-5 failure restores the pre-image"
(implying the journal is only intent). Both cannot hold.

**Chosen: the journal is prepared intent. Commit is when both targets match the
post-image.**

- Failure before both targets are written → roll **back** to the pre-image, and
  the API reports a plain error. Nothing changed.
- Failure after both match → the write succeeded; recovery only deletes the
  journal.
- The unrecognised-target case above overrides everything and stops.

This is the model that makes "a failed request changes nothing" true, which is
what audit blocker 2 required. Roll-forward-after-journal would have made a
failed request silently succeed later.

### Durability

`fsync` on a temp file does not make its directory entry durable. Each step is:
write temp → `fsync` file → rename → **`fsync` the parent directory**. Journal
deletion is also followed by a directory `fsync` before completion is reported.

On Windows, directory `fsync` is unavailable; `FlushFileBuffers` on the file plus
`MoveFileEx` with write-through is the documented fallback, and the
`030`-era Windows CI job covers it. Where neither is available, the journal is
still written first, so the worst case is a recovery that reports
`recovery_required` rather than one that loses data silently.

### Reads never write

`readPromptLayers` is pure. When it observes drift — a journal present, or
config.toml's projection disagreeing with the JSON — it reports
`drift: "journal-present" | "projection-stale" | null` and changes nothing.

`020` surfaces drift as a state the GUI renders with an explicit **Repair**
action. Repair is a `POST`, revision-checked like any other mutation. An HTTP
GET must never modify a user's configuration, which is exactly what blocker 3
said.

### Missing store is not an empty store

Blocker 3's sharpest case: JSON deleted while an owned, non-empty projection
still sits in config.toml. Treating that as "empty store" would make the next
write erase the active prompt and every saved body.

Three distinct states, distinguished before anything is written:

| Store | Owned projection | Meaning | Behavior |
|---|---|---|---|
| absent | absent | never used | normal first run |
| absent | **present and non-empty** | **store lost** | refuse writes, `drift: "store-missing"`, offer Repair |
| present | either | normal | normal |

Repair from `store-missing` is **salvage, not reconstruction** — the audit was
right that the earlier wording oversold it.

The projection holds one concatenated string of the enabled layers. It cannot
recover layer boundaries, ids, titles, row order, disabled layers, or their
bodies, and it cannot tell a `\n\n` that separated two layers from one that a
user typed. All of that is gone with the store.

So salvage takes the whole projected text and offers it as **one new layer**,
with the exact body previewed and the losses listed explicitly before the user
confirms.

The backup is written first, and "first" has to mean durable: a timestamp alone
can collide, and an unflushed backup is not a backup. It is created with
exclusive `wx` and a random suffix, mode `0600`, then `fsync`ed together with its
parent directory. **If the backup cannot be created or made durable, salvage
aborts** — a destructive operation whose safety net failed should not proceed.

### Cross-process locking

Blocker 4 was right that an in-process mutex protects only browser tabs behind
one service. A CLI invocation, a second service, or Codex itself can all write
the same file.

`$CODEX_HOME/opencodex-prompt.lock` is an advisory lock created with `wx`,
carrying a random **token**, pid, and start time. Every opencodex writer —
service, CLI, route — takes it.

Naive stale-breaking is racy, as the audit showed: A judges the lock stale, B
removes it and acquires its own, A then deletes *B's live lock* and both
proceed. Unlinking a path you did not verify is the bug.

**Race-safe takeover:**

1. read the lock; if its pid is live or it is younger than 10s, wait
2. otherwise `rename()` it to `opencodex-prompt.lock.stale-<our token>` — an
   atomic operation exactly one contender can win
3. the winner creates the real lock with `wx` and deletes the quarantined file
4. a loser's rename fails with `ENOENT`; it returns to step 1

**Release deletes only a lock whose token still matches ours.** A token mismatch
means we were superseded: we do not delete, and we report `write_superseded`
rather than assuming the file is still ours.

That covers opencodex against itself. **It does not cover Codex**, which knows
nothing about our lock. The residual window is between step 2's read and step 4's
rename. Two mitigations, and an honest limit:

- immediately before the rename, re-hash `config.toml` and compare against the
  edit base. A change aborts with `stale_revision`, nothing written. This shrinks
  the window to the rename itself.
- after the rename, re-read and confirm the file contains our two lines. If it
  does not, another writer won; report `write_superseded` rather than success.
- a race lost inside the rename cannot be prevented from user space. It is
  detected on the next read as `projection-stale`, and it is recorded in `070`
  as residual rather than claimed solved.

## Tests — `tests/codex-prompt-layers.test.ts`

Every case takes explicit temp paths (`004` §H: never resolve the real
`CODEX_HOME`).

**Reading**
1. missing config → defaults, `configExists: false`, writes still permitted
2. unreadable config → `readable: false`, every write refused
3. absent key → `userFileValue: null`, `defaultedUserValue: true`
4. `include_apps_instructions = false` → both false
5. `[skills] include_instructions` read from its table, not root
6. a root-looking key **inside** another table is not read as the root key

**Boolean writes**
7. insert above the first `[table]`
8. replace in place, comments intact
9. idempotent → `changed: false`, file byte-identical
10. CRLF preserved
11. unrelated tables, comments, blank lines survive
12. unknown id rejected before any file access
13. first write creates file and parent with `0700`/`0600`

**Encoding — byte-level, no parser involved**
14. body with `"` and `\` emits exactly `\"` and `\\`, byte-compared
15. body with `"""` is unremarkable — it is three escaped quotes on one line
16. tab normalizes to four spaces; CRLF normalizes to LF
17. control characters rejected with position, nothing written
18. non-BMP Unicode and combining marks pass through unescaped
19. a 64 KiB body produces one line of the expected length
20. **after every write, the file re-read byte-for-byte contains the exact
    expected two lines** — the assertion that replaces reparse verification
21. **a golden fixture of the emitted line is checked against the TOML spec's
    basic-string grammar by hand-written matcher**, not by `Bun.TOML`
21a. unpaired high surrogate → rejected with code-point position
21b. unpaired low surrogate → rejected
21c. U+007F DEL and a C1 control (U+0085) → rejected
21d. U+2028 / U+2029 accepted and pass through unescaped
21e. size caps measured in UTF-8 bytes **after** tab expansion
21f. **golden Rust fixture**: generated lines for every accepted character class
     parsed by real `toml_edit`, decoded values matching a committed golden file

Cases 20-21 exist because `Bun.TOML.parse` on Bun 1.3.14 transposes `\t`/`\f`
and rejects `\u0007` (measured; see §Why no prompt text goes into config.toml).
A test that verified through that parser would report success on a file Codex
might read differently.

**Ownership and adoption**
22. marker + canonical line → owned, rewritten
23. marker + non-canonical line → refuse, file untouched
24. key without marker → refuse, `drift`/adopt offered, file untouched
25. adopt on a single-line basic string imports it and takes ownership
26. adopt on a multi-line or literal string is refused with path and line
26a. adopt normalizes tabs to four spaces and CRLF to LF
26b. adopt rejects a forbidden control with its code-point position
26c. adopt refuses a body that exceeds 64 KiB **after** normalization
26d. adopt refuses when the composed total would exceed 128 KiB
26e. **the previewed body is byte-identical to the committed body**
26f. `owned-malformed` re-adoption runs the same five steps
26g. `previewSalvage` returns a directory and creates no file
27. our marker survives an unrelated boolean write

**Store, transaction, recovery**
28. custom layers round-trip through JSON
29. disabled layer stays in JSON, absent from the projection
30. all layers disabled → both generated lines removed
31. store absent + no owned projection → normal first run
32. **store absent + owned non-empty projection → `drift: "store-missing"`,
    writes refused, salvage offers the projected text as one layer**
33. store malformed → `store_unreadable`, config.toml untouched
34. stale revision → refused, nothing written
35. revision changes when only the marker is removed (value identical)
36. revision changes when the config is deleted
37. journal present + **all** targets match post-image → journal deleted, state
    kept (the writes finished; only the commit step was missing)
38. journal present + one target post, one pre → **both rolled back to
    pre-image**, because a journal on disk means commit never happened
39. journal present + a target matches **neither** → `recovery_required`,
    nothing written, the other target untouched
40. journal fails its checksum → `recovery_required`, nothing read from it
41. journal truncated → `recovery_required`, nothing written
41a. store externally modified between compare and its rename → abort, roll back
41b. store deleted between compare and its rename → abort, roll back
41c. config externally modified during rollback → `recovery_required`
41d. post-write byte comparison catches an unrelated key changed by another
     writer → `write_superseded`, journal retained
41e. backup creation fails → salvage aborts, nothing destroyed
41f. every content-bearing file is created `0600` (POSIX only)
41. config write succeeds, store write fails → config restored, request errors,
    **source of truth unchanged**
42. rollback itself fails → `recovery_required` naming both paths
43. config.toml modified between compare and rename → `stale_revision`
44. post-rename readback missing our lines → `write_superseded`
45. lock held by a live pid → second writer waits then refuses
46. lock held by a dead pid → broken after the timeout
46a. **A quarantines the stale lock; B acquires the real lock before A can
     recreate it; A's `wx` fails; A retries from the top without deleting B's
     lock and without entering the critical section**
46b. release with a mismatched token deletes nothing and reports
     `write_superseded`
46c. two contenders quarantine simultaneously → exactly one rename succeeds
47. **`readPromptLayers` never writes**: a read against every drift state leaves
    both files byte-identical

Cases 20, 24, 32, 41, 43, and 47 are the data-protection set. Each is driven red
once before it is trusted.

### Cross-platform

The lock uses `wx` open and pid liveness; the journal uses `fsync` + rename.
Both behave differently enough on Windows that WP1's CI must run its suite on
Linux, macOS, and Windows — the three platforms `AGENTS.md` names. Path
separators and `realpathSync.native` on a WSL-visible `$CODEX_HOME`
(`home.ts:90-107`) are covered by existing fixtures.

**Windows durability is a WP1 acceptance gate, not an assumption.** Directory
`fsync` is unavailable there, and the plan does not claim a Bun API for
`MoveFileEx` write-through because none is established. WP1 must determine what
Bun actually exposes and then either use it or **fail closed**: if
write-through cannot be guaranteed, the journal is still written first, and a
crash surfaces as `recovery_required` rather than as silent loss. A Windows test
must exercise that branch explicitly. WP1 does not land until this is settled
one way or the other and the answer is recorded here.

### No new production dependency

WP1 adds nothing to `package.json`. The audit's dependency-review blocker is
resolved by removing the dependency, not by scheduling a review: byte-level
encoding needs no TOML library, and `Bun.TOML.parse` is used only in tests, and
only where its measured defects do not apply.

## Not in this phase

No route, no GUI, no presets, no linter. WP1 ships a module and its tests.
