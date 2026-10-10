# Codex prompts

`src/server/management/codex-prompt-routes.ts` exposes the prompt-layer snapshot,
base import preview/confirmation, and recovery-only Repair operation. Mutations
retain the [canonical config writer contract](codex-home.md) and its explicit
held lock handle. Repair replays recorded images without rewriting the custom
layer list. Busy locks return `locked`; unsafe ownership remains `unsafe`.

## Base prompt import

`src/codex/prompt-layers.ts` resolves relative base prompt paths from the configuration
file's directory for selection and uncertain-write cleanup. Import cleanup preserves
files still referenced after `write_superseded` or `recovery_required`, together with
the journal. The line editor in `src/codex/prompt-layers/toml-edit.ts` decodes quoted
keys before matching assignments and preserves trailing whitespace and comments.
`src/codex/prompt-layers/encoding.ts` shares decoded assignment-key matching with
toggle reads, so quoted writes and their returned snapshots agree. Scalar edits
first classify every line by lexical scope across the whole file: a line that
starts inside a multiline string or a multi-line composite is prose, never an
assignment or table header, so assignment-shaped text inside
`developer_instructions` is not edited. A string or composite that never closes
refuses the whole edit before publication, and a composite or multiline target
value also refuses. Delimiters in quoted strings and comments do not change scope.
Toggle reads use the same scan (`scopedBool` in `toml-read.ts`, scanner in
`encoding.ts`), so a write and the snapshot read back agree.
An edit is also checked before publication: if the result would leave the target table
header ambiguous or duplicated (for example a quoted or spaced `[skills]` header next to
a `[skills]` token inside a multiline string), the edit is refused and the file is left
byte-identical, instead of publishing TOML that a byte-hash check alone cannot reject.

Journal recovery, commit and rollback recheck the target's current content before every
rename attempt, including each retry after a transient sharing error such as `EBUSY`.
If a peer has rewritten the target in place since the image was recorded, the rename is
not attempted: the newer bytes and the journal are kept and the operation reports
`recovery_required`. This applies to both the config and the store target.

`src/codex/prompt-layers/import-source.ts` opens an external source nonblocking,
checks the opened descriptor is regular, and reads at most 128 KiB plus one refusal
byte. CRLF normalization can halve that raw size; the normalized body is limited to
64 KiB independently of the heading. A source beyond either limit produces no preview.

The base-import flow in `gui/src/pages/codex-set-prompt.tsx` expires read-only
previews when their dialog closes or title changes. A confirm cancels queued title
previews and settles the shared snapshot even after Close; a lost response triggers
a fresh read after the mutation finishes. A title-preview refusal preserves the last
preview and its editor so the title can be corrected, while confirmation stays bound
to the last accepted title and hash.
Read-only title previews keep the input enabled and focused. Config read failures
are reported before an import absence, and HTTP/network probe failures retain a
request-failure classification rather than claiming another probe is busy.
`gui/src/components/codex-set/BaseVariantDialog.tsx` reconciles successful existing
edits to the canonical saved title and body only while the visible draft still
matches the submitted input. Refusals and newer edits keep their drafts.

## Prompt text probe

`src/codex/prompt-text-probe.ts` reports the prompt Codex assembles for the resolved Codex home. It
runs `codex debug prompt-input` in that home, bounded in time and in bytes, maps each rendered section
onto a layer, and takes no caller-supplied directory. Captured process output is never serialized
back: a failure is a classified kind plus a fixed phrase and the resolved command.

The base prompt is absent from that output, because Codex discards `base_instructions` before
rendering `prompt.input`. It is read from configuration instead, and it is read before the subprocess
starts, so an unresolved Codex runtime, a failed probe and a cancelled request all still answer with
it. Precedence follows Codex: a `model_instructions_file` decides the answer whenever the key is set,
including when the file it names is missing, blank or unreadable, and otherwise the selected model's
catalog row supplies `base_instructions`, with `model_messages.instructions_template` as the fallback.
Only the first form is reported as text Codex sends. A template is reported as a template and the
legacy `base-instructions` layer slot carries no text for it: that slot has five coarse reasons and no
representation, and its dialog labels every readable layer as text sent to the model.

Each configured source is opened once, non-blocking, and read to at most the probe's byte ceiling,
which is what keeps a FIFO, a device node or an oversized file from stalling or ballooning a
synchronous request. The regular-file check reads the opened descriptor rather than the path, and the
whole TOML document parses before any key from it is trusted, because Codex rejects a malformed
config outright. Every failure is a reason on the response rather than an exception, so the
management read degrades instead of returning an error page.
